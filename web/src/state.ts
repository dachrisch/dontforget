import type { CandidateEvent, EventDetail, FeedSummary, QuerySummary, RecurrenceInterval } from './types';

export interface SelectableCandidate extends CandidateEvent {
  selected: boolean;
}

export interface SelectableEditEvent extends EventDetail {
  selected: boolean;
}

export interface EditingDraft {
  queryId: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  events: SelectableEditEvent[];
}

interface DashboardState {
  kind: 'dashboard';
  queries: QuerySummary[];
  feed: FeedSummary | null;
  editing: EditingDraft | null;
}

interface LoadingState {
  kind: 'loading';
  queryText: string;
  fromDashboard?: boolean;
}

interface ReviewState {
  kind: 'review';
  queryId: string;
  candidates: SelectableCandidate[];
  fromDashboard?: boolean;
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'linkSent' }
  | { kind: 'empty'; queryText?: string }
  | LoadingState
  | ReviewState
  | { kind: 'feedReady'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] }
  | DashboardState;

export type WorkspaceEvent =
  | { type: 'MAGIC_LINK_SENT' }
  | { type: 'SUBMIT_QUERY'; text: string }
  | { type: 'QUERY_RESOLVED'; queryId: string; candidates: CandidateEvent[] }
  | { type: 'QUERY_FAILED' }
  | { type: 'TOGGLE_CANDIDATE'; id: string }
  | { type: 'APPROVE_RESOLVED'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] }
  | { type: 'DASHBOARD_LOADED'; queries: QuerySummary[]; feed: FeedSummary | null }
  | { type: 'START_EDIT'; queryId: string }
  | { type: 'EDIT_EVENTS_LOADED'; queryId: string; events: EventDetail[] }
  | { type: 'TOGGLE_EDIT_EVENT'; id: string }
  | { type: 'CANCEL_EDIT' }
  | { type: 'QUERY_DELETED'; queryId: string };

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'MAGIC_LINK_SENT':
      if (state.kind !== 'signedOut') return state;
      return { kind: 'linkSent' };

    case 'SUBMIT_QUERY':
      if (state.kind === 'empty') {
        return { kind: 'loading', queryText: event.text };
      }
      if (state.kind === 'dashboard') {
        return { kind: 'loading', queryText: event.text, fromDashboard: true };
      }
      return state;

    case 'QUERY_RESOLVED': {
      if (state.kind !== 'loading') return state;
      const next: ReviewState = {
        kind: 'review',
        queryId: event.queryId,
        candidates: event.candidates.map(c => ({ ...c, selected: true })),
      };
      if (state.fromDashboard) next.fromDashboard = true;
      return next;
    }

    case 'QUERY_FAILED':
      if (state.kind !== 'loading') return state;
      return { kind: 'empty', queryText: state.queryText };

    case 'TOGGLE_CANDIDATE':
      if (state.kind !== 'review') return state;
      return {
        ...state,
        candidates: state.candidates.map(c => (c.id === event.id ? { ...c, selected: !c.selected } : c)),
      };

    case 'APPROVE_RESOLVED':
      if (state.kind !== 'review') return state;
      // `approved` comes from the event, not state.candidates here — the
      // caller must snapshot selections at the moment it sent the approve
      // request, since the user can keep toggling checkboxes while that
      // request is in flight and state.candidates would have moved on.
      return {
        kind: 'feedReady',
        icsUrl: event.icsUrl,
        rssUrl: event.rssUrl,
        approved: event.approved,
      };

    case 'DASHBOARD_LOADED':
      return { kind: 'dashboard', queries: event.queries, feed: event.feed, editing: null };

    case 'START_EDIT': {
      if (state.kind !== 'dashboard') return state;
      const query = state.queries.find(q => q.id === event.queryId);
      if (!query) return state;
      return {
        ...state,
        editing: { queryId: query.id, text: query.text, recurrenceInterval: query.recurrenceInterval, events: [] },
      };
    }

    case 'EDIT_EVENTS_LOADED': {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== event.queryId) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          // Pending candidates start pre-selected, mirroring the first-search
          // review flow; approved events are not re-selectable.
          events: event.events.map(e => ({ ...e, selected: e.status === 'candidate' })),
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
            e.status === 'candidate' && e.id === event.id ? { ...e, selected: !e.selected } : e
          ),
        },
      };
    }

    case 'CANCEL_EDIT':
      if (state.kind !== 'dashboard') return state;
      return { ...state, editing: null };

    case 'QUERY_DELETED':
      if (state.kind !== 'dashboard') return state;
      return {
        ...state,
        queries: state.queries.filter(q => q.id !== event.queryId),
        editing: state.editing?.queryId === event.queryId ? null : state.editing,
      };

    default:
      return state;
  }
}