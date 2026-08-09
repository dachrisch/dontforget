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
  const jsonMatch = replyText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('opencode reply did not contain JSON');
  }
  const parsed = JSON.parse(jsonMatch[0]) as { events: ExtractedEvent[] };
  return parsed.events;
}