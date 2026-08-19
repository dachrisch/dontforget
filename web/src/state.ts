import type { AdminStats, AdminUser, BillingStatus, EventDetail, FeedSummary, QuerySummary, RecurrenceInterval } from './types';

export type EventDecision = 'none' | 'approve' | 'dismiss';

export interface SelectableEditEvent extends EventDetail {
  decision: EventDecision;
}

function cycleDecision(decision: EventDecision): EventDecision {
  if (decision === 'none') return 'approve';
  if (decision === 'approve') return 'dismiss';
  return 'none';
}

export interface EditingDraft {
  queryId: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  events: SelectableEditEvent[];
}

// A landed search that's open for inline approval on its dashboard card. The
// cadence select is pre-filled from the query's stored interval (which the
// AI suggestion fills when the user picked none).
export interface ReviewingDraft {
  queryId: string;
  recurrenceInterval: RecurrenceInterval;
  events: SelectableEditEvent[];
}

interface DashboardState {
  kind: 'dashboard';
  queries: QuerySummary[];
  feed: FeedSummary | null;
  editing: EditingDraft | null;
  reviewing: ReviewingDraft | null;
  billing: BillingStatus | null;
}

export interface AdminState {
  kind: 'admin';
  stats: AdminStats | null;
  users: AdminUser[];
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'linkSent' }
  | { kind: 'empty' }
  | DashboardState
  | AdminState;

export type WorkspaceEvent =
  | { type: 'MAGIC_LINK_SENT' }
  | { type: 'DASHBOARD_LOADED'; queries: QuerySummary[]; feed: FeedSummary | null; billing?: BillingStatus | null }
  | { type: 'START_EDIT'; queryId: string }
  | { type: 'EDIT_EVENTS_LOADED'; queryId: string; events: EventDetail[] }
  | { type: 'TOGGLE_EDIT_EVENT'; id: string }
  | { type: 'CANCEL_EDIT' }
  | { type: 'QUERY_DELETED'; queryId: string }
  | { type: 'FEED_ROTATED'; icsUrl: string; rssUrl: string }
  | { type: 'START_REVIEW'; queryId: string }
  | { type: 'REVIEW_EVENTS_LOADED'; queryId: string; events: EventDetail[] }
  | { type: 'TOGGLE_REVIEW_EVENT'; id: string }
  | { type: 'SET_REVIEW_INTERVAL'; interval: RecurrenceInterval }
  | { type: 'CANCEL_REVIEW' }
  | { type: 'REVIEW_APPROVED'; queryId: string }
  | { type: 'ADMIN_LOADED'; stats: AdminStats; users: AdminUser[] }
  | { type: 'ADMIN_USER_DELETED'; id: string };

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'MAGIC_LINK_SENT':
      if (state.kind !== 'signedOut') return state;
      return { kind: 'linkSent' };

    case 'DASHBOARD_LOADED': {
      // Keep an open edit/review card alive across refreshes (the search
      // poll re-renders every few seconds while a query runs) — but only if
      // the query it belongs to still exists.
      const editing =
        state.kind === 'dashboard' && state.editing && event.queries.some(q => q.id === state.editing!.queryId)
          ? state.editing
          : null;
      const reviewing =
        state.kind === 'dashboard' && state.reviewing && event.queries.some(q => q.id === state.reviewing!.queryId)
          ? state.reviewing
          : null;
      return { kind: 'dashboard', queries: event.queries, feed: event.feed, editing, reviewing, billing: event.billing ?? null };
    }

    case 'START_EDIT': {
      if (state.kind !== 'dashboard') return state;
      const query = state.queries.find(q => q.id === event.queryId);
      if (!query) return state;
      return {
        ...state,
        editing: { queryId: query.id, text: query.text, recurrenceInterval: query.recurrenceInterval, events: [] },
        reviewing: state.reviewing?.queryId === query.id ? null : state.reviewing,
      };
    }

    case 'EDIT_EVENTS_LOADED': {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== event.queryId) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          // Edit keeps approved events visible for context (it's the
          // "manage this query" view); only dismissed ones stay hidden.
          // Pending candidates start undecided; approved events are shown
          // read-only and never gain a decision.
          events: event.events
            .filter(e => e.status !== 'dismissed')
            .map(e => ({ ...e, decision: 'none' as const })),
        },
      };
    }

    case 'TOGGLE_EDIT_EVENT': {
      if (state.kind !== 'dashboard' || !state.editing) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          events: state.editing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, decision: cycleDecision(e.decision) } : e
          ),
        },
      };
    }

    case 'CANCEL_EDIT':
      if (state.kind !== 'dashboard') return state;
      return { ...state, editing: null };

    case 'START_REVIEW': {
      if (state.kind !== 'dashboard') return state;
      const query = state.queries.find(q => q.id === event.queryId);
      if (!query) return state;
      return {
        ...state,
        reviewing: { queryId: query.id, recurrenceInterval: query.recurrenceInterval, events: [] },
        editing: state.editing?.queryId === query.id ? null : state.editing,
      };
    }

    case 'REVIEW_EVENTS_LOADED': {
      if (state.kind !== 'dashboard' || state.reviewing?.queryId !== event.queryId) return state;
      return {
        ...state,
        reviewing: {
          ...state.reviewing,
          // Review is a lean "decide on what's pending" queue — approved and
          // dismissed events are never shown here (see
          // docs/superpowers/specs/2026-08-19-review-edit-dismissed-design.md).
          events: event.events
            .filter(e => e.status === 'candidate')
            .map(e => ({ ...e, decision: 'none' as const })),
        },
      };
    }

    case 'TOGGLE_REVIEW_EVENT': {
      if (state.kind !== 'dashboard' || !state.reviewing) return state;
      return {
        ...state,
        reviewing: {
          ...state.reviewing,
          events: state.reviewing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, decision: cycleDecision(e.decision) } : e
          ),
        },
      };
    }

    case 'SET_REVIEW_INTERVAL': {
      if (state.kind !== 'dashboard' || !state.reviewing) return state;
      return { ...state, reviewing: { ...state.reviewing, recurrenceInterval: event.interval } };
    }

    case 'CANCEL_REVIEW':
      if (state.kind !== 'dashboard') return state;
      return { ...state, reviewing: null };

    case 'REVIEW_APPROVED':
      if (state.kind !== 'dashboard' || state.reviewing?.queryId !== event.queryId) return state;
      return { ...state, reviewing: null };

    case 'QUERY_DELETED':
      if (state.kind !== 'dashboard') return state;
      return {
        ...state,
        queries: state.queries.filter(q => q.id !== event.queryId),
        editing: state.editing?.queryId === event.queryId ? null : state.editing,
        reviewing: state.reviewing?.queryId === event.queryId ? null : state.reviewing,
      };

    case 'FEED_ROTATED':
      if (state.kind !== 'dashboard' || !state.feed) return state;
      return {
        ...state,
        feed: { ...state.feed, icsUrl: event.icsUrl, rssUrl: event.rssUrl },
      };

    case 'ADMIN_LOADED':
      if (state.kind !== 'admin') return state;
      return { kind: 'admin', stats: event.stats, users: event.users };

    case 'ADMIN_USER_DELETED':
      if (state.kind !== 'admin') return state;
      return { ...state, users: state.users.filter(user => user.id !== event.id) };

    default:
      return state;
  }
}