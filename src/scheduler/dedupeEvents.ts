import type { ExtractedEvent } from '../types.js';

export interface ExistingEventKey {
  label: string;
  start_date: string;
  end_date: string;
}

export function filterNewEvents(
  candidates: ExtractedEvent[],
  existing: ExistingEventKey[]
): ExtractedEvent[] {
  const seen = new Set(existing.map(e => `${e.label}|${e.start_date}|${e.end_date}`));
  return candidates.filter(event => !seen.has(`${event.label}|${event.startDate}|${event.endDate}`));
}
