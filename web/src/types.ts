export interface CandidateEvent {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
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

// `running` = a search is in flight (the card shows a status until it
// lands); `failed` = the last search errored; `ready` = search results are
// in (or there were none).
export type QueryStatus = 'running' | 'ready' | 'failed';

export interface QuerySummary {
  id: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  lastRunAt: string | null;
  createdAt: string;
  approvedCount: number;
  candidateCount: number;
  status: QueryStatus;
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
  status: 'candidate' | 'approved' | 'dismissed';
}

export type UserRole = 'admin' | 'user';

export interface Me {
  authenticated: boolean;
  role: UserRole;
}

export interface AdminStats {
  totalUsers: number;
  totalQueries: number;
  approvedEvents: number;
  candidateEvents: number;
  activeUsers7d: number;
}

export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string | null;
  queryCount: number;
}