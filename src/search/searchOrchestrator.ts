import type { ExtractedEvent, ExtractedSeries, ExtractionResult, SearchResult, SeriesExtractionResult } from '../types.js';
import { MAX_SERIES } from './opencodeClient.js';
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

export interface SeriesDiscoveryDeps {
  searxngSearch: (query: string) => Promise<SearchResult[]>;
  extractSeries: (query: string, results: SearchResult[]) => Promise<SeriesExtractionResult>;
  // Records one search_metric per discovery probe. Optional — no-op when absent.
  metrics?: MetricsService | null;
}

// Two-stage pipeline, stage 1 (issue #143): group a broad free-form query
// into a bounded set of event series before fetching any dated events.
//
// Cost guardrail: exactly 1 searxng call + 1 extractSeries call per
// discovery, and the result is capped at MAX_SERIES (truncated
// deterministically — first N in model order win). Per-series expansion
// (stage 2) reuses the existing single-stage orchestrator with each
// series' searchKeywords, one searxng call per expanded series.
export function createSeriesDiscoveryOrchestrator(
  deps: SeriesDiscoveryDeps
): (query: string) => Promise<SeriesExtractionResult> {
  return async function discoverSeries(query: string): Promise<SeriesExtractionResult> {
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
      return { series: [] };
    }
    const extracted = await deps.extractSeries(query, results);
    return { series: dedupeSeries(extracted.series).slice(0, MAX_SERIES) };
  };
}

// Same normalized-title dedupe as the series repo (defense in depth — the
// repo also dedupes against stored dismissed titles). First occurrence wins,
// preserving model order so truncation is deterministic.
function dedupeSeries(series: ExtractedSeries[]): ExtractedSeries[] {
  const seen = new Set<string>();
  return series.filter(entry => {
    const key = entry.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
