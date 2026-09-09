import { Agent, fetch as undiciFetch } from 'undici';
import { isRecurrenceInterval, type ExtractionResult, type SearchResult, type SeriesExtractionResult } from '../types.js';
import type { ActiveModel } from './models.js';
import type { MetricsService } from './metrics.js';

// servyy-test's opencode instance is only reachable at an internal-only
// `.lxd` hostname (Traefik's Let's Encrypt resolver can't issue a real cert
// for a private domain, so it falls back to self-signed there). Production
// (code.lehel.xyz) always has a real cert and must never skip
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

// Contract confirmed live against code.lehel.xyz on 2026-08-09 — the
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
  return runExtraction(baseUrl, apiKey, query, results, opts, buildPrompt, parseExtraction);
}

// Groups a broad free-form query into a bounded set of coherent event
// series (not raw dates). One broad searxng probe's results in, at most
// MAX_SERIES_OUT series out — each with a title, one-line description,
// reusable search keywords, and exemplar source URLs. Narrow queries are
// the degenerate case: the model returns a single series.
export async function extractSeries(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[],
  opts: ExtractDatesOptions = {}
): Promise<SeriesExtractionResult> {
  return runExtraction(baseUrl, apiKey, query, results, opts, buildSeriesPrompt, parseSeriesExtraction);
}

async function runExtraction<T>(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[],
  opts: ExtractDatesOptions,
  build: (query: string, results: SearchResult[]) => string,
  parse: (replyText: string) => T
): Promise<T> {
  const models = opts.models ?? MODEL_TIERS;
  const metrics = opts.metrics ?? noopMetrics;
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      try {
        const sessionId = await createSession(baseUrl, apiKey, model);
        await sendPrompt(baseUrl, apiKey, sessionId, build(query, results));
        const replyText = await pollForReply(baseUrl, apiKey, sessionId);
        const parsed = parse(replyText);
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

// opencode's model catalog changed (2026-08-29): the free models
// mimo-v2.5-free and big-pickle were removed entirely, and the providers
// were renamed — the Qwen models now live under "bailian-payg" (Alibaba
// DashScope, pay-as-you-go) and the Anthropic/Gemini models under "google"
// (Antigravity). Pin explicit model ids that still exist; relying on
// opencode's own default ("ling-3.0-tiny-free" historically) is unreliable.
//
// As of 2026-09-01 the primary is "glm-5.3-flash" on the "opencode-go"
// provider (OpenCode Go). The fallback is on a different provider so a
// provider-side outage/rate limit on the primary fails over rather than
// giving up. Both verified present in the code.lehel.xyz catalog.
const MODEL = { id: 'glm-5.3-flash', providerID: 'opencode-go' };

// Backup model tried only after MODEL exhausts every attempt above — a
// distinct model on a different provider (google/Antigravity) so an
// opencode-go outage or rate limit doesn't take extraction down.
const FALLBACK_MODEL = { id: 'antigravity-gemini-3-flash', providerID: 'google' };

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

// Cost guardrail for series discovery (issue #143): one broad query yields
// at most MAX_SERIES series, truncated deterministically (model order,
// first N win). Tunable after the first real-world run.
export const MAX_SERIES = 12;

// The identity a discovered series applies to (e.g. "Auer Dult",
// "Stadtfest Minden"): the canonical recurring entity, always with its
// place. Dedupe key everywhere — the model's `appliesTo` when present,
// falling back to `title` for older replies/fixtures that predate it.
export function seriesIdentityKey(entry: { title: string; appliesTo?: string }): string {
  const raw = entry.appliesTo?.trim() || entry.title;
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildSeriesPrompt(query: string, results: SearchResult[]): string {
  const resultsBlock = results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');
  return [
    `Group the broad query "${query}" into coherent recurring event series based on these search results.`,
    `Each series is a distinct repeating event (e.g. a festival, a sports season's home matches, a fair) — not a single dated occurrence.`,
    `Work in two steps per series. Step 1: find out what the series applies to — the canonical recurring entity with its place (e.g. "Auer Dult" in Munich, "Stadtfest Minden" in Minden). Step 2: only then give the search keywords and sources for dates in THIS series.`,
    `Respond with only JSON, no prose: {"series":[{"title":string,"appliesTo":string,"description":string,"searchKeywords":string,"sourceUrls":string[]}]}`,
    `Rules: at most ${MAX_SERIES} series, most prominent first; title is the series display name; appliesTo is the canonical recurring entity it applies to, including place (e.g. "Auer Dult, Munich"); description is one line saying what recurs where; searchKeywords is a focused searxng query that would find dates of exactly this entity (include place/theme, e.g. "Auer Dult Munich Termine"); sourceUrls lists 1-2 URLs from the results above that mention this entity.`,
    `If the query already resolves to one series (e.g. "Auer Dult Munich"), return exactly 1 series for it, with appliesTo naming that entity.`,
    `If nothing is found, respond {"series":[]}.`,
    '',
    resultsBlock,
  ].join('\n');
}

function parseSeriesExtraction(replyText: string): SeriesExtractionResult {
  const jsonText = extractFirstJsonObject(replyText);
  const parsed = JSON.parse(jsonText) as { series?: unknown };
  const raw = Array.isArray(parsed.series) ? parsed.series : [];
  const seen = new Set<string>();
  const series: SeriesExtractionResult['series'] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    // appliesTo postdates some fixtures — fall back to the title so older
    // replies still yield a usable identity.
    const appliesToRaw = typeof rec.appliesTo === 'string' ? rec.appliesTo.trim() : '';
    const appliesTo = appliesToRaw || title;
    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    const searchKeywords = typeof rec.searchKeywords === 'string' ? rec.searchKeywords.trim() : '';
    const sourceUrls = Array.isArray(rec.sourceUrls)
      ? rec.sourceUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map(u => u.trim())
      : [];
    if (!title || !appliesTo || !searchKeywords || sourceUrls.length === 0) continue;
    const key = seriesIdentityKey({ title, appliesTo });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    series.push({ title, appliesTo, description, searchKeywords, sourceUrls });
    // Deterministic truncation: keep model order, first MAX_SERIES win.
    if (series.length >= MAX_SERIES) break;
  }
  return { series };
}

// The scope a date lookup is restricted to: dates must be occurrences of
// THIS series' entity, not just anything mentioning the keywords.
export interface SeriesScope {
  title: string;
  appliesTo: string;
  description: string;
  searchKeywords: string;
}

// Series-scoped date extraction (stage 2 of the two-stage pipeline): the
// user subscribes to the series, not to individual events, so the lookup
// must first recall what the series applies to and then return only dates
// that are occurrences of that entity. Anything else mentioned in the
// results (other fairs, other towns, generic event roundups) is ignored.
export async function extractSeriesDates(
  baseUrl: string,
  apiKey: string,
  series: SeriesScope,
  results: SearchResult[],
  opts: ExtractDatesOptions = {}
): Promise<ExtractionResult> {
  return runExtraction(
    baseUrl,
    apiKey,
    series.searchKeywords,
    results,
    opts,
    () => buildSeriesDatesPrompt(series, results),
    parseExtraction
  );
}

function buildSeriesDatesPrompt(series: SeriesScope, results: SearchResult[]): string {
  const resultsBlock = results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');
  const identity = series.appliesTo.trim() || series.title;
  return [
    `This series applies to "${identity}"${series.title && series.title !== identity ? ` (shown as "${series.title}")` : ''}${series.description ? `: ${series.description}` : ''}.`,
    `Extract only concrete dates that are occurrences of THIS series from these search results (e.g. its editions, shows, or match dates).`,
    `Ignore dates belonging to any other event, fair, or town mentioned in the results, even if the wording overlaps.`,
    `Respond with only JSON, no prose: {"events":[{"label":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sourceUrl":string}],"cadence":"weekly"|"monthly"|"quarterly"|"yearly"|null}`,
    `If a result gives a single day, set startDate and endDate to the same date. Label each event as an occurrence of "${identity}" (e.g. its edition or season name).`,
    `Also judge how often "${identity}" recurs as a whole: set cadence to "weekly", "monthly", "quarterly", or "yearly". If it does not recur on a predictable cadence, set "cadence":null.`,
    `If no dates of this series are found, respond {"events":[],"cadence":null}.`,
    '',
    resultsBlock,
  ].join('\n');
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