import type { SearchResult, ExtractedEvent } from '../types.js';

export interface SearchOrchestratorDeps {
  searxngSearch: (query: string) => Promise<SearchResult[]>;
  extractDates: (query: string, results: SearchResult[]) => Promise<ExtractedEvent[]>;
}

export function createSearchOrchestrator(
  deps: SearchOrchestratorDeps
): (query: string) => Promise<ExtractedEvent[]> {
  return async function runQuery(query: string): Promise<ExtractedEvent[]> {
    const results = await deps.searxngSearch(query);
    if (results.length === 0) {
      return [];
    }
    const events = await deps.extractDates(query, results);
    return dedupeEvents(events);
  };
}

// extractDates() runs per search result, so the same real-world event
// mentioned on multiple pages (a common case — the same festival listed on
// several sites) comes back once per mention. Keep the first occurrence of
// each distinct (label, startDate, endDate) combination.
function dedupeEvents(events: ExtractedEvent[]): ExtractedEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    const key = `${event.label}|${event.startDate}|${event.endDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}