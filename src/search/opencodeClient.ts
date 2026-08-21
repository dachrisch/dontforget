import { Agent, fetch as undiciFetch } from 'undici';
import { isRecurrenceInterval, type ExtractionResult, type SearchResult } from '../types.js';
import type { ActiveModel } from './models.js';
import type { MetricsService } from './metrics.js';

// servyy-test's opencode instance is only reachable at an internal-only
// `.lxd` hostname (Traefik's Let's Encrypt resolver can't issue a real cert
// for a private domain, so it falls back to self-signed there). Production
// (opencode.lehel.xyz) always has a real cert and must never skip
// verification — this is opt-in per-deployment via an env var set only in
// the servyy-test Ansible template, not a blanket NODE_TLS_REJECT_UNAUTHORIZED
// toggle that would also weaken unrelated TLS connections (Mongo, SMTP...).
//
// Uses undici's own `fetch`/`Agent`, not the global `fetch` — Node's
// built-in fetch is backed by its own internal, differently-versioned copy
// of undici, and passing an Agent from the standalone `undici` package as
// `dispatcher` to the global fetch throws (`invalid onRequestStart method`,
// an internal ABI mismatch between the two undici copies). Confirmed live
// against opencode.servyy-test.lxd — global fetch + external Agent fails,
// undici's own fetch + its own Agent works.
const insecureDispatcher =
  process.env.OPENCODE_ALLOW_INSECURE_TLS === 'true' ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

// Contract confirmed live against opencode.lehel.xyz on 2026-08-09 — the
// plan's original guess (single POST .../message returning parts[] inline)
// was wrong on every point. The real shape:
//   POST /api/session            -> {"data": {"id": "ses_...", ...}}
//   POST /api/session/:id/prompt -> {"data": {"id":"msg_...", "delivery":"steer", ...}} (an ack, not the reply)
//   GET  /api/session/:id/wait   -> 503 "Session wait is not available yet" (not usable)
//   GET  /api/session/:id/message -> {"data": [<newest message first>, ...]}
// So the reply has to be polled for: keep GETting .../message until the
// newest entry is an assistant message with `finish` set (or `finish:
// "error"`, e.g. a transient upstream 503 from the model provider — seen
// live during this same verification).
const POLL_INTERVAL_MS = 1000;
// Generous on purpose: agent-mode models on opencode routinely spend 60-90s
// reasoning before their first text token (deepseek-v4-flash-free measured
// ~92s prompt-to-finish on a real extraction prompt, 2026-08-20). A tight
// timeout here doesn't fail fast — it abandons a session that opencode keeps
// computing to completion, then burns another one on retry.
const POLL_TIMEOUT_MS = 120_000;

interface OpencodeMessage {
  type: 'user' | 'assistant';
  finish?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

// The upstream LLM provider behind opencode is occasionally flaky (503
// "Endpoint is unavailable", 429 rate limiting, or a poll timeout) —
// confirmed against production logs on 2026-08-17: 4 of the last 6 real
// submissions failed this way, none rescued by the flat 1s retry delay that
// used to be here (a 429 rate limit doesn't clear in 1s). Two changes:
// exponential backoff between attempts on the same model gives a rate limit
// or blip more time to clear, and MODEL_TIERS lets a persistently
// unhealthy model (all MAX_ATTEMPTS exhausted) fail over to a different
// model on the same provider rather than give up entirely.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface ExtractDatesOptions {
  // The ordered list of models to try (default first, then backups). Falls
  // back to the built-in MODEL_TIERS when omitted. Admin-controlled via the
  // model registry.
  models?: ActiveModel[];
  // Records one model_metric per attempt (success or failure). No-op when
  // omitted or null, so callers without a metrics service are unaffected.
  metrics?: MetricsService | null;
}

const noopMetrics: MetricsService = {
  async recordModelCall() {},
  async recordSearchCall() {},
};

export async function extractDates(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[],
  opts: ExtractDatesOptions = {}
): Promise<ExtractionResult> {
  const models = opts.models ?? MODEL_TIERS;
  const metrics = opts.metrics ?? noopMetrics;
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      try {
        const sessionId = await createSession(baseUrl, apiKey, model);
        await sendPrompt(baseUrl, apiKey, sessionId, buildPrompt(query, results));
        const replyText = await pollForReply(baseUrl, apiKey, sessionId);
        const parsed = parseExtraction(replyText);
        await metrics.recordModelCall({
          modelId: model.id,
          providerId: model.providerID,
          outcome: 'success',
          durationMs: Date.now() - started,
        });
        return parsed;
      } catch (err) {
        lastError = err;
        await metrics.recordModelCall({
          modelId: model.id,
          providerId: model.providerID,
          outcome: 'failure',
          errorType: classifyError(err),
          durationMs: Date.now() - started,
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
  }
  throw lastError;
}

// Bucket error messages into a coarse type for admin visibility — a provider
// outage (503/429) and a malformed reply are very different signals.
function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('503') || msg.includes('429') || msg.includes('Endpoint is unavailable')) return 'provider-unavailable';
  if (msg.includes('timed out')) return 'timeout';
  if (msg.includes('no text content') || msg.includes('JSON') || msg.includes('unterminated')) return 'bad-reply';
  if (msg.includes('session create failed')) return 'session-create';
  return 'other';
}

// Left unspecified, opencode picks its own default model — confirmed live
// 2026-08-10 to be "ling-3.0-tiny-free", which was persistently failing
// with 503 "Endpoint is unavailable" (not the transient kind retries can
// fix). Pin a specific model explicitly instead of relying on whatever
// opencode defaults to.
//
// Model choice is driven by a live perf test against opencode.lehel.xyz
// (2026-08-21, full 11.4KB extraction prompt, 3 rounds each): mimo-v2.5-free
// was the fastest responsive free model (median 22.3s), big-pickle second
// (28.5s). deepseek-v4-flash-free was retired from the opencode catalog —
// it used to take 76s+ of reasoning and was the reason responses stalled.
const MODEL = { id: 'mimo-v2.5-free', providerID: 'opencode' };

// Backup model tried only after MODEL exhausts every attempt above — a
// distinct free model on the same "opencode" (OpenCode Zen) provider.
// Rate limits and outages on MODEL are provider-side per-model, so a
// different model is likely unaffected even when MODEL itself is down.
const FALLBACK_MODEL = { id: 'big-pickle', providerID: 'opencode' };

const MODEL_TIERS = [MODEL, FALLBACK_MODEL];

async function createSession(
  baseUrl: string,
  apiKey: string,
  model: { id: string; providerID: string }
): Promise<string> {
  const response = await undiciFetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ model }),
    dispatcher: insecureDispatcher,
  });
  if (!response.ok) {
    throw new Error(`opencode session create failed: ${response.status}`);
  }
  const data = (await response.json()) as { data: { id: string } };
  return data.data.id;
}

async function sendPrompt(baseUrl: string, apiKey: string, sessionId: string, text: string): Promise<void> {
  const response = await undiciFetch(`${baseUrl}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ prompt: { text } }),
    dispatcher: insecureDispatcher,
  });
  if (!response.ok) {
    throw new Error(`opencode prompt failed: ${response.status}`);
  }
}

async function pollForReply(baseUrl: string, apiKey: string, sessionId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await undiciFetch(`${baseUrl}/api/session/${sessionId}/message`, {
      headers: { 'X-Api-Key': apiKey },
      dispatcher: insecureDispatcher,
    });
    if (!response.ok) {
      throw new Error(`opencode message poll failed: ${response.status}`);
    }
    const data = (await response.json()) as { data: OpencodeMessage[] };
    const latest = data.data[0];

    if (latest?.type === 'assistant' && latest.finish) {
      if (latest.finish === 'error') {
        throw new Error(`opencode generation failed: ${latest.error?.message ?? 'unknown error'}`);
      }
      const textPart = latest.content?.find(p => p.type === 'text' && p.text);
      if (!textPart?.text) {
        throw new Error('opencode reply had no text content');
      }
      return textPart.text;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('opencode reply timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt(query: string, results: SearchResult[]): string {
  const resultsBlock = results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');
  return [
    `Extract every concrete date mentioned for "${query}" from these search results.`,
    `Respond with only JSON, no prose: {"events":[{"label":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sourceUrl":string}],"cadence":"weekly"|"monthly"|"quarterly"|"yearly"|null}`,
    `If a result gives a single day, set startDate and endDate to the same date.`,
    `Also judge how often "${query}" recurs as a whole: set cadence to "weekly", "monthly", "quarterly", or "yearly". If it does not recur on a predictable cadence, set "cadence":null.`,
    `If nothing is found, respond {"events":[],"cadence":null}.`,
    '',
    resultsBlock,
  ].join('\n');
}

function parseExtraction(replyText: string): ExtractionResult {
  const jsonText = extractFirstJsonObject(replyText);
  const parsed = JSON.parse(jsonText) as { events?: ExtractionResult['events']; cadence?: unknown };
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const cadence = isRecurrenceInterval(parsed.cadence) ? parsed.cadence : null;
  return { events, cadence };
}

// A plain /\{[\s\S]*\}/ match greedily spans from the first '{' to the very
// LAST '}' in the whole reply, so any trailing prose after valid JSON (or
// the literal `{...}` example syntax in the prompt itself) breaks JSON.parse
// even though a complete, valid object was present. Walk brace depth
// instead, string-aware, and stop at the first balanced object.
function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('opencode reply did not contain JSON');
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new Error('opencode reply contained an unterminated JSON object');
}