export interface CandidateEvent {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  status: 'candidate' | 'approved';
}

export type RecurrenceInterval = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const RECURRENCE_INTERVALS: RecurrenceInterval[] = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
];

export const DEFAULT_RECURRENCE_INTERVAL: RecurrenceInterval = 'weekly';

export interface QuerySummary {
  id: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  lastRunAt: string | null;
  createdAt: string;
  approvedCount: number;
  candidateCount: number;
}

export interface FeedSummary {
  icsUrl: string;
  rssUrl: string;
  lastFetchedAt: string | null;
}

export interface Dashboard {
  queries: QuerySummary[];
  feed: FeedSummary | null;
}

export interface CreateQueryResponse {
  queryId: string;
  candidates: CandidateEvent[];
  suggestedInterval: RecurrenceInterval | null;
}

export interface ApproveResponse {
  icsUrl: string;
  rssUrl: string;
}

export interface EventDetail {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  status: 'candidate' | 'approved';
}