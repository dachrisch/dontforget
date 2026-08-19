import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';
import type { EventDetail, QueryStatus } from './types';

function query(id: string, status: QueryStatus = 'ready'): import('./types').QuerySummary {
  return {
    id,
    text: 'Auer Dult Munich',
    recurrenceInterval: 'monthly',
    lastRunAt: null,
    createdAt: '2026-08-10T00:00:00Z',
    approvedCount: 0,
    candidateCount: 0,
    status,
  };
}

function dashboard(queries: import('./types').QuerySummary[]): WorkspaceState {
  return { kind: 'dashboard', queries, feed: null, editing: null, reviewing: null, billing: null };
}

describe('reducer', () => {
  it('moves from signedOut to linkSent on MAGIC_LINK_SENT', () => {
    const next = reducer({ kind: 'signedOut' }, { type: 'MAGIC_LINK_SENT' });
    expect(next).toEqual({ kind: 'linkSent' });
  });

  it('loads the dashboard and starts with no query being edited or reviewed', () => {
    const next = reducer({ kind: 'signedOut' }, {
      type: 'DASHBOARD_LOADED',
      queries: [query('q1')],
      feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: null },
    });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null, reviewing: null });
  });

  it('carries the billing status through DASHBOARD_LOADED', () => {
    const billing = { freeLimit: 1, activeQueryCount: 0, pricePerExtraQuery: 0.5, subscribed: false, subscriptionStatus: null, checkoutUrl: '/api/billing/checkout', portalUrl: '/api/billing/portal' };
    const next = reducer({ kind: 'signedOut' }, {
      type: 'DASHBOARD_LOADED',
      queries: [query('q1')],
      feed: null,
      billing,
    });
    expect(next).toMatchObject({ billing });
  });

  it('keeps an open review card across a dashboard refresh when its query still exists', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'DASHBOARD_LOADED', queries: [query('q1')], feed: null });
    expect(next).toMatchObject({ reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] } });
  });

  it('drops an open review card when a dashboard refresh no longer lists its query', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'DASHBOARD_LOADED', queries: [], feed: null });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('starts reviewing a query prefilled with its stored cadence', () => {
    const state = dashboard([query('q1')]);
    const next = reducer(state, { type: 'START_REVIEW', queryId: 'q1' });
    expect(next).toMatchObject({
      kind: 'dashboard',
      reviewing: { queryId: 'q1', recurrenceInterval: 'monthly', events: [] },
    });
  });

  it('ignores START_REVIEW when the query does not exist', () => {
    const state = dashboard([]);
    expect(reducer(state, { type: 'START_REVIEW', queryId: 'q1' })).toBe(state);
  });

  it('loads events into the open review card, keeping only pending candidates', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    // A mix of all three statuses: only the candidate should survive into
    // reviewing.events — Review is a lean "decide on what's pending" queue
    // (see docs/superpowers/specs/2026-08-19-review-edit-dismissed-design.md).
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
      { id: 'e3', label: 'Kirmesdult', startDate: '2026-11-06', endDate: '2026-11-16', sourceUrl: 'u', status: 'dismissed' },
    ];
    const next = reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      reviewing: {
        events: [{ id: 'e2', status: 'candidate', decision: 'none' }],
      },
    });
  });

  it('ignores loaded review events when they do not match the query being reviewed', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    expect(reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId: 'q2', events: [] })).toBe(state);
  });

  it('toggles a pending candidate in the review card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: {
        queryId: 'q1',
        recurrenceInterval: 'weekly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'none' },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
    };
    const afterFirstClick = reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterFirstClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'approve' }, { id: 'e2', decision: 'none' }] },
    });

    const afterSecondClick = reducer(afterFirstClick, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterSecondClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'dismiss' }, { id: 'e2', decision: 'none' }] },
    });

    const afterThirdClick = reducer(afterSecondClick, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterThirdClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'none' }, { id: 'e2', decision: 'none' }] },
    });
  });

  it('ignores TOGGLE_REVIEW_EVENT on an already-approved event', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: {
        queryId: 'q1',
        recurrenceInterval: 'weekly',
        events: [
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
    };
    const next = reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e2' });
    expect(next).toMatchObject({ reviewing: { events: [{ id: 'e2', decision: 'none' }] } });
  });

  it('updates the review cadence the user picks before approving', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'SET_REVIEW_INTERVAL', interval: 'monthly' });
    expect(next).toMatchObject({ reviewing: { recurrenceInterval: 'monthly' } });
  });

  it('closes the review card on CANCEL_REVIEW', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'CANCEL_REVIEW' });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('closes the review card on REVIEW_APPROVED', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'REVIEW_APPROVED', queryId: 'q1' });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('ignores REVIEW_APPROVED when a different query is open', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1'), query('q2')],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    expect(reducer(state, { type: 'REVIEW_APPROVED', queryId: 'q2' })).toBe(state);
  });

  it('starts editing a saved query prefilled with its own values', () => {
    const state = dashboard([query('q1')]);
    const next = reducer(state, { type: 'START_EDIT', queryId: 'q1' });
    expect(next).toMatchObject({
      kind: 'dashboard',
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
    });
  });

  it('loads events into the open edit card, keeping candidates and approved but excluding dismissed', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
      billing: null,
    };
    // A mix of all three statuses: Edit is the "manage this query" view, so
    // both candidate and approved should survive; only dismissed is hidden.
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
      { id: 'e3', label: 'Kirmesdult', startDate: '2026-11-06', endDate: '2026-11-16', sourceUrl: 'u', status: 'dismissed' },
    ];
    const next = reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      editing: {
        events: [
          { id: 'e1', status: 'approved', decision: 'none' },
          { id: 'e2', status: 'candidate', decision: 'none' },
        ],
      },
    });
  });

  it('ignores loaded edit events when they do not match the query being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
      billing: null,
    };
    expect(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q2', events: [] })).toBe(state);
  });

  it('toggles a pending candidate inside the edit card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: {
        queryId: 'q1',
        text: 'A',
        recurrenceInterval: 'monthly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'none' },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
      reviewing: null,
      billing: null,
    };
    const afterFirstClick = reducer(state, { type: 'TOGGLE_EDIT_EVENT', id: 'e1' });
    expect(afterFirstClick).toMatchObject({
      editing: { events: [{ id: 'e1', decision: 'approve' }, { id: 'e2', decision: 'none' }] },
    });

    const afterSecondClick = reducer(afterFirstClick, { type: 'TOGGLE_EDIT_EVENT', id: 'e1' });
    expect(afterSecondClick).toMatchObject({
      editing: { events: [{ id: 'e1', decision: 'dismiss' }, { id: 'e2', decision: 'none' }] },
    });
  });

  it('cancels editing', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
      billing: null,
    };
    const next = reducer(state, { type: 'CANCEL_EDIT' });
    expect(next).toEqual({ kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null, billing: null });
  });

  it('removes a deleted query from the dashboard', () => {
    const q1 = query('q1');
    const state = dashboard([q1, query('q2')]);
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', queries: [{ id: 'q2' }] });
  });

  it('clears an open edit when the query being deleted is the one being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
      billing: null,
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null });
  });

  it('clears an open review when the query being deleted is the one being reviewed', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: null,
      billing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', reviewing: null });
  });

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' })).toBe(state);
  });

  it('loads stats and users into the admin panel', () => {
    const state: WorkspaceState = { kind: 'admin', stats: null, users: [] };
    const stats = { totalUsers: 2, totalQueries: 3, approvedEvents: 1, candidateEvents: 0, activeUsers7d: 1 };
    const users: import('./types').AdminUser[] = [{ id: 'u1', email: 'a@example.com', role: 'user', createdAt: null, queryCount: 1 }];

    const next = reducer(state, { type: 'ADMIN_LOADED', stats, users });
    expect(next).toEqual({ kind: 'admin', stats, users });
  });

  it('ignores ADMIN_LOADED outside the admin panel', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(
      reducer(state, { type: 'ADMIN_LOADED', stats: { totalUsers: 0, totalQueries: 0, approvedEvents: 0, candidateEvents: 0, activeUsers7d: 0 }, users: [] })
    ).toBe(state);
  });

  it('removes a deleted user from the admin list', () => {
    const state: WorkspaceState = {
      kind: 'admin',
      stats: null,
      users: [
        { id: 'u1', email: 'a@example.com', role: 'user', createdAt: null, queryCount: 1 },
        { id: 'u2', email: 'b@example.com', role: 'admin', createdAt: null, queryCount: 0 },
      ],
    };

    const next = reducer(state, { type: 'ADMIN_USER_DELETED', id: 'u1' });
    expect(next).toMatchObject({ kind: 'admin', users: [{ id: 'u2' }] });
  });
});