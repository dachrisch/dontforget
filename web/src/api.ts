import type { CandidateEvent, Dashboard, EventDetail, QuerySummary, RecurrenceInterval } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json() as Promise<T>;
}

export async function requestMagicLink(email: string): Promise<void> {
  const response = await fetch('/api/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'failed to request link');
  }
}

export async function checkSession(): Promise<boolean> {
  const response = await fetch('/api/me', { credentials: 'include' });
  return response.ok;
}

export async function listQueries(): Promise<Dashboard> {
  const response = await fetch('/api/queries', { credentials: 'include' });
  return handle(response);
}

export async function submitQuery(
  text: string,
  recurrenceInterval?: RecurrenceInterval
): Promise<{ queryId: string; candidates: CandidateEvent[]; suggestedInterval: RecurrenceInterval | null }> {
  const response = await fetch('/api/queries', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, recurrenceInterval }),
  });
  return handle(response);
}

export async function updateQuery(
  queryId: string,
  patch: { text?: string; recurrenceInterval?: RecurrenceInterval }
): Promise<QuerySummary> {
  const response = await fetch(`/api/queries/${queryId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handle(response);
}

export async function approveEvents(
  queryId: string,
  eventIds: string[],
  recurrenceInterval?: RecurrenceInterval
): Promise<{ icsUrl: string; rssUrl: string }> {
  const body: { eventIds: string[]; recurrenceInterval?: RecurrenceInterval } = { eventIds };
  if (recurrenceInterval) body.recurrenceInterval = recurrenceInterval;
  const response = await fetch(`/api/queries/${queryId}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle(response);
}

export async function signOut(): Promise<void> {
  const response = await fetch('/api/auth/signout', {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
}

export async function getQueryEvents(queryId: string): Promise<EventDetail[]> {
  const response = await fetch(`/api/queries/${queryId}/events`, { credentials: 'include' });
  return handle(response);
}

export async function rotateFeedToken(): Promise<{ icsUrl: string; rssUrl: string }> {
  const response = await fetch('/api/feed/rotate', {
    method: 'POST',
    credentials: 'include',
  });
  return handle(response);
}

export async function deleteQuery(queryId: string): Promise<void> {
  const response = await fetch(`/api/queries/${queryId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
}