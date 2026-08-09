import type { SearchResult } from '../types';

// This instance's general-category engines (google, duckduckgo, brave,
// startpage, mojeek, qwant, bing) are configured as SearXNG "private
// engines" (container repo: ansible/plays/templates/searxng/settings.yml.j2)
// — every request needs a matching token or every engine is silently
// skipped, returning zero results with no error. Same token job-search uses
// (SEARXNG_TOKEN there too).
export async function searxngSearch(
  baseUrl: string,
  query: string,
  token: string
): Promise<SearchResult[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&tokens=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`searxng request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    results: Array<{ title: string; url: string; content?: string }>;
  };
  return data.results.map(r => ({ title: r.title, url: r.url, content: r.content ?? '' }));
}