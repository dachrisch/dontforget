import type { ExtractedEvent, ExtractionResult, SearchResult } from '../types.js';

export interface SearchOrchestratorDeps {
  searxngSearch: (query: string) => Promise<SearchResult[]>;
  extractDates: (query: string, results: SearchResult[]) => Promise<ExtractionResult>;
}

export function createSearchOrchestrator(
  deps: SearchOrchestratorDeps
): (query: string) => Promise<ExtractionResult> {
  return async function runQuery(query: string): Promise<ExtractionResult> {
    const results = await deps.searxngSearch(query);
    if (results.length === 0) {
      return { events: [], cadence: null };
    }
    const extracted = await deps.extractDates(query, results);
    return { events: dedupeEvents(extracted.events), cadence: extracted.cadence };
  };
}

// extractDates() runs per search result, so the same real-world event
// mentioned on multiple pages — often under slightly different labels
// ("Frühjahrsdult" vs "Frühjahrsdult (Auer Dult)") — comes back once per
// mention. The daterange is the stable signal, so keep the first occurrence
// of each distinct (startDate, endDate) combination.
function dedupeEvents(events: ExtractedEvent[]): ExtractedEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    const key = `${event.startDate}|${event.endDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}