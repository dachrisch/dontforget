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

export interface ExtractionResult {
  events: ExtractedEvent[];
  // The cadence the model judged this kind of event recurs on, e.g. a
  // yearly festival. Null when the results give no signal, or when the
  // model's answer isn't one of the supported intervals.
  cadence: RecurrenceInterval | null;
}

export interface CandidateEvent extends ExtractedEvent {
  id: string;
  status: 'candidate' | 'approved' | 'dismissed';
}

export type RecurrenceInterval = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const RECURRENCE_INTERVALS: RecurrenceInterval[] = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
];

export const DEFAULT_RECURRENCE_INTERVAL: RecurrenceInterval = 'weekly';

export function isRecurrenceInterval(value: unknown): value is RecurrenceInterval {
  return typeof value === 'string' && (RECURRENCE_INTERVALS as string[]).includes(value);
}

// `running` means a search is in flight (the initial submit, or a retry) and
// the query card shows a status until it lands as `ready` or `failed`. Older
// queries predate the field and are treated as `ready`.
export type QueryStatus = 'running' | 'ready' | 'failed' | 'blocked';

export interface QuerySummary {
  id: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  lastRunAt: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  approvedCount: number;
  candidateCount: number;
  status: QueryStatus;
  active: boolean;
}

export interface FeedSummary {
  icsUrl: string;
  rssUrl: string;
  lastFetchedAt: string | null; // ISO 8601
}

export interface Dashboard {
  queries: QuerySummary[];
  feed: FeedSummary | null;
}