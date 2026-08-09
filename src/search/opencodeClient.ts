import type { SearchResult, ExtractedEvent } from '../types';

export async function extractDates(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[]
): Promise<ExtractedEvent[]> {
  const sessionId = await createSession(baseUrl, apiKey);
  const replyText = await sendMessage(baseUrl, apiKey, sessionId, buildPrompt(query, results));
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
  const data = (await response.json()) as { id: string };
  return data.id;
}

async function sendMessage(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  text: string
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
  if (!response.ok) {
    throw new Error(`opencode message failed: ${response.status}`);
  }
  const data = (await response.json()) as { parts: Array<{ type: string; text?: string }> };
  const textPart = data.parts.find(p => p.type === 'text' && p.text);
  if (!textPart?.text) {
    throw new Error('opencode reply had no text part');
  }
  return textPart.text;
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