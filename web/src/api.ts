import type { AdminModel, AdminSearch, AdminStats, AdminUser, BillingStatus, Dashboard, EventDetail, Me, ModelRole, QuerySummary, RecurrenceInterval } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function handle<T>(response: Response): Promise<T> {
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

export async function getMe(): Promise<Me> {
  const response = await fetch('/api/me', { credentials: 'include' });
  if (!response.ok) {
    return { authenticated: false, role: 'user' };
  }
  return response.json() as Promise<Me>;
}

export async function listQueries(): Promise<Dashboard> {
  const response = await fetch('/api/queries', { credentials: 'include' });
  return handle(response);
}

export async function getBillingStatus(): Promise<BillingStatus> {
  const response = await fetch('/api/billing/status', { credentials: 'include' });
  return handle(response);
}

// Checkout creates a Stripe object server-side, so the route is POST —
// unlike startPortal below, a plain `window.location.href` navigation can't
// send POST, so submit a real (invisible) form instead. enctype=text/plain
// because the route has no body to parse and Fastify's default parsers only
// cover application/json and text/plain — a form's normal default
// (application/x-www-form-urlencoded) has no registered parser and 415s.
export function startCheckout(quantity = 1): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/billing/checkout?quantity=${quantity}`;
  form.enctype = 'text/plain';
  document.body.appendChild(form);
  form.submit();
}

export function startPortal(): void {
  window.location.href = '/api/billing/portal';
}

export async function submitQuery(
  text: string,
  recurrenceInterval?: RecurrenceInterval
): Promise<{ queryId: string }> {
  const response = await fetch('/api/queries', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, recurrenceInterval }),
  });
  return handle(response);
}

// Re-runs a query's search in the background (dashboard "Try again" on a
// failed card). Resolves once the query row is queued, not when the search
// finishes — the dashboard poll picks the results up.
export async function runQuery(queryId: string): Promise<{ queryId: string }> {
  const response = await fetch(`/api/queries/${queryId}/run`, {
    method: 'POST',
    credentials: 'include',
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
  recurrenceInterval?: RecurrenceInterval,
  dismissEventIds: string[] = []
): Promise<{ icsUrl: string; rssUrl: string }> {
  const body: { eventIds: string[]; recurrenceInterval?: RecurrenceInterval; dismissEventIds?: string[] } = { eventIds };
  if (recurrenceInterval) body.recurrenceInterval = recurrenceInterval;
  if (dismissEventIds.length > 0) body.dismissEventIds = dismissEventIds;
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

export async function deleteAccount(): Promise<void> {
  const response = await fetch('/api/auth/account', {
    method: 'DELETE',
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

export async function deactivateQuery(queryId: string): Promise<void> {
  const response = await fetch(`/api/queries/${queryId}/deactivate`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, 'failed to pause query');
}

export async function reactivateQuery(queryId: string): Promise<void> {
  const response = await fetch(`/api/queries/${queryId}/reactivate`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, 'failed to resume query');
}

export async function addSlots(count: number): Promise<{ purchasedSlots: number }> {
  const response = await fetch('/api/billing/add-slots', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  return handle(response);
}

export async function getAdminStats(): Promise<AdminStats> {
  const response = await fetch('/api/admin/stats', { credentials: 'include' });
  return handle(response);
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const response = await fetch('/api/admin/users', { credentials: 'include' });
  return handle(response);
}

export async function deleteAdminUser(userId: string): Promise<void> {
  const response = await fetch(`/api/admin/users/${userId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
}

export async function listAdminModels(): Promise<AdminModel[]> {
  const response = await fetch('/api/admin/models', { credentials: 'include' });
  return handle(response);
}

export async function addAdminModel(id: string, providerID: string): Promise<AdminModel> {
  const response = await fetch('/api/admin/models', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, providerID }),
  });
  return handle(response);
}

export async function updateAdminModel(
  id: string,
  patch: { enabled?: boolean; role?: ModelRole | null }
): Promise<AdminModel> {
  const response = await fetch(`/api/admin/models/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handle(response);
}

export async function getAdminSearch(): Promise<AdminSearch> {
  const response = await fetch('/api/admin/search', { credentials: 'include' });
  return handle(response);
}