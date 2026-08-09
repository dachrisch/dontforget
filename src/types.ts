export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface ExtractedEvent {
  label: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
  sourceUrl: string;
}

export interface CandidateEvent extends ExtractedEvent {
  id: string;
  status: 'candidate' | 'approved';
}