import type { SearchResult, ExtractedEvent } from '../types';

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
const POLL_TIMEOUT_MS = 30_000;

interface OpencodeMessage {
  type: 'user' | 'assistant';
  finish?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

export async function extractDates(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[]
): Promise<ExtractedEvent[]> {
  const sessionId = await createSession(baseUrl, apiKey);
  await sendPrompt(baseUrl, apiKey, sessionId, buildPrompt(query, results));
  const replyText = await pollForReply(baseUrl, apiKey, sessionId);
  return parseEvents(replyText);
}

async function createSession(baseUrl: string, apiKey: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`opencode session create failed: ${response.status}`);
  }
  const data = (await response.json()) as { data: { id: string } };
  return data.data.id;
}

async function sendPrompt(baseUrl: string, apiKey: string, sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ prompt: { text } }),
  });
  if (!response.ok) {
    throw new Error(`opencode prompt failed: ${response.status}`);
  }
}

async function pollForReply(baseUrl: string, apiKey: string, sessionId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/session/${sessionId}/message`, {
      headers: { 'X-Api-Key': apiKey },
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
    `Respond with only JSON, no prose: {"events":[{"label":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sourceUrl":string}]}`,
    `If a result gives a single day, set startDate and endDate to the same date. If nothing is found, respond {"events":[]}.`,
    '',
    resultsBlock,
  ].join('\n');
}

function parseEvents(replyText: string): ExtractedEvent[] {
  const jsonText = extractFirstJsonObject(replyText);
  const parsed = JSON.parse(jsonText) as { events: ExtractedEvent[] };
  return parsed.events;
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