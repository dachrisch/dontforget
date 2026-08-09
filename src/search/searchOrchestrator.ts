import type { SearchResult, ExtractedEvent } from '../types';

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
    return deps.extractDates(query, results);
  };
}