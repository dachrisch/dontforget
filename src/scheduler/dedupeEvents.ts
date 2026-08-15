import type { ExtractedEvent } from '../types.js';

export interface ExistingEventKey {
  start_date: string;
  end_date: string;
}

export function filterNewEvents(
  candidates: ExtractedEvent[],
  existing: ExistingEventKey[]
): ExtractedEvent[] {
  const seen = new Set(existing.map(e => `${e.start_date}|${e.end_date}`));
  return candidates.filter(event => {
    const key = `${event.startDate}|${event.endDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
