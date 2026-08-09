import type { SearchResult } from '../types';

export async function searxngSearch(baseUrl: string, query: string): Promise<SearchResult[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`searxng request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    results: Array<{ title: string; url: string; content?: string }>;
  };
  return data.results.map(r => ({ title: r.title, url: r.url, content: r.content ?? '' }));
}