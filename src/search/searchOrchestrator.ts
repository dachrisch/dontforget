import type { ExtractedEvent, ExtractionResult, SearchResult } from '../types.js';
import type { MetricsService } from './metrics.js';

export interface SearchOrchestratorDeps {
  searxngSearch: (query: string) => Promise<SearchResult[]>;
  extractDates: (query: string, results: SearchResult[]) => Promise<ExtractionResult>;
  // Records one search_metric per search call. Optional — no-op when absent.
  metrics?: MetricsService | null;
}

export function createSearchOrchestrator(
  deps: SearchOrchestratorDeps
): (query: string) => Promise<ExtractionResult> {
  return async function runQuery(query: string): Promise<ExtractionResult> {
    const started = Date.now();
    let results: SearchResult[];
    try {
      results = await deps.searxngSearch(query);
    } catch (err) {
      await deps.metrics?.recordSearchCall({
        outcome: 'failure',
        errorType: err instanceof Error ? err.message : String(err),
        resultCount: 0,
        durationMs: Date.now() - started,
      });
      throw err;
    }
    await deps.metrics?.recordSearchCall({
      outcome: 'success',
      resultCount: results.length,
      durationMs: Date.now() - started,
    });
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
