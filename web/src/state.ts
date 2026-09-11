import type { AdminModel, AdminSearch, AdminStats, AdminUser, EventDetail, FeedSummary, QuerySummary, RecurrenceInterval, SeriesDatePreview, SeriesStatus, SeriesSummary } from './types';

export type EventDecision = 'none' | 'approve' | 'dismiss';

export interface SelectableEditEvent extends EventDetail {
  decision: EventDecision;
}

function cycleDecision(decision: EventDecision): EventDecision {
  if (decision === 'none') return 'approve';
  if (decision === 'approve') return 'dismiss';
  return 'none';
}

// One discovered series inside the edit card. `status` is the last known
// server status and is never staged — `selected` is the staged subscription
// that Save persists via the series review endpoint. `expanded` is the
// accordion state; `expanding` tracks the in-flight date search.
export interface EditingSeriesDraft {
  id: string;
  title: string;
  description: string;
  sourceUrls: string[];
  status: SeriesStatus;
  selected: boolean;
  expanded: boolean;
  expanding: boolean;
  preview: SeriesDatePreview[];
}

export interface EditingDraft {
  queryId: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  events: SelectableEditEvent[];
  // Series triage for series queries. Null while the series list is still
  // loading; series-less legacy queries keep an empty list and render the
  // legacy per-event tiles.
  series: EditingSeriesDraft[] | null;
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
}

export interface AdminState {
  kind: 'admin';
  stats: AdminStats | null;
  users: AdminUser[];
  models: AdminModel[];
  search: AdminSearch | null;
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'linkSent' }
  | { kind: 'empty' }
  | DashboardState
  | AdminState;

// The background dashboard poll must never yank the user off another page —
// most importantly the admin panel — while a search is running. A dashboard
// refresh is only allowed to land when the user is already on the dashboard,
// or on the first-run empty workspace that a fresh query submit transitions
// out of.
export function canRefreshDashboard(state: WorkspaceState): boolean {
  return state.kind === 'dashboard' || state.kind === 'empty';
}

export type WorkspaceEvent =
  | { type: 'MAGIC_LINK_SENT' }
  | { type: 'DASHBOARD_LOADED'; queries: QuerySummary[]; feed: FeedSummary | null }
  | { type: 'START_EDIT'; queryId: string }
  | { type: 'EDIT_EVENTS_LOADED'; queryId: string; events: EventDetail[] }
  | { type: 'EDIT_SERIES_LOADED'; queryId: string; series: SeriesSummary[] }
  | { type: 'TOGGLE_EDIT_SERIES'; seriesId: string }
  | { type: 'TOGGLE_EDIT_SERIES_EXPAND'; seriesId: string }
  | { type: 'EDIT_SERIES_EVENTS_LOADED'; queryId: string; seriesId: string; events: EventDetail[] }
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
  | { type: 'ADMIN_LOADED'; stats: AdminStats; users: AdminUser[]; models: AdminModel[]; search: AdminSearch }
  | { type: 'ADMIN_MODELS_UPDATED'; models: AdminModel[] }
  | { type: 'ADMIN_USER_DELETED'; id: string };

function seriesIdentity(s: Pick<SeriesSummary, 'title' | 'appliesTo'>): string {
  return s.appliesTo && s.appliesTo !== s.title ? `${s.title} · ${s.appliesTo}` : s.appliesTo || s.title;
}

// Seeds edit drafts from discovered series. Dismissed series stay hidden
// (the backend never re-creates them). Previously staged drafts keep their
// accordion state; selection always re-seeds from the server status.
function seedSeriesDrafts(
  series: SeriesSummary[],
  previous: Map<string, EditingSeriesDraft>
): EditingSeriesDraft[] {
  return series
    .filter(s => s.status !== 'dismissed')
    .map(s => {
      const prev = previous.get(s.id);
      const selected = s.status === 'approved';
      return {
        id: s.id,
        title: seriesIdentity(s),
        description: s.description,
        sourceUrls: s.sourceUrls ?? [],
        status: s.status,
        selected,
        // Subscribed series auto-open so their next dates are visible
        // without a second tap; manual accordion toggles survive re-seeds.
        expanded: prev?.expanded ?? selected,
        expanding: s.expanding ?? false,
        preview: s.previewEvents ?? [],
      };
    });
}

// Pre-checks candidate dates of selected series: they are approved on save
// via the series subscribe cascade, so the accordion checkboxes reflect
// "will be in the calendar" unless explicitly unticked.
function preselectSeriesEvents(
  events: SelectableEditEvent[],
  series: EditingSeriesDraft[] | null
): SelectableEditEvent[] {
  if (!series) return events;
  const selected = new Set(series.filter(s => s.selected).map(s => s.id));
  return events.map(e =>
    e.seriesId && selected.has(e.seriesId) && e.status === 'candidate' && e.decision === 'none'
      ? { ...e, decision: 'approve' as const }
      : e
  );
}

// Merges a dashboard refresh into an open edit card: the date-search
// indicator and previews follow the server, newly discovered series appear
// unticked, and the user's staged selection/accordion state is preserved.
function syncEditSeriesFromQuery(editing: EditingDraft, query: QuerySummary): EditingDraft {
  if (!editing.series) return editing;
  const byId = new Map((query.series ?? []).map(s => [s.id, s]));
  const synced = editing.series.map(d => {
    const s = byId.get(d.id);
    return s ? { ...d, expanding: s.expanding ?? false, preview: s.previewEvents ?? [] } : d;
  });
  const known = new Set(synced.map(d => d.id));
  const discovered = (query.series ?? [])
    .filter(s => !known.has(s.id) && s.status !== 'dismissed')
    .map(s => seedSeriesDrafts([s], new Map())[0]);
  return { ...editing, series: [...synced, ...discovered] };
}

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'MAGIC_LINK_SENT':
      if (state.kind !== 'signedOut') return state;
      return { kind: 'linkSent' };

    case 'DASHBOARD_LOADED': {
      // Keep an open edit/review card alive across refreshes (the search
      // poll re-renders every few seconds while a query runs) — but only if
      // the query it belongs to still exists.
      const incoming =
        state.kind === 'dashboard' && state.editing
          ? event.queries.find(q => q.id === state.editing!.queryId) ?? null
          : null;
      const editing =
        state.kind === 'dashboard' && state.editing && incoming
          ? syncEditSeriesFromQuery(state.editing, incoming)
          : null;
      const reviewing =
        state.kind === 'dashboard' && state.reviewing && event.queries.some(q => q.id === state.reviewing!.queryId)
          ? state.reviewing
          : null;
      return { kind: 'dashboard', queries: event.queries, feed: event.feed, editing, reviewing };
    }

    case 'START_EDIT': {
      if (state.kind !== 'dashboard') return state;
      const query = state.queries.find(q => q.id === event.queryId);
      if (!query) return state;
      return {
        ...state,
        // Series queries load their triage list async (null = loading);
        // series-less legacy queries keep an empty list.
        editing: { queryId: query.id, text: query.text, recurrenceInterval: query.recurrenceInterval, events: [], series: query.series?.length ? null : [] },
        reviewing: state.reviewing?.queryId === query.id ? null : state.reviewing,
      };
    }

    case 'EDIT_EVENTS_LOADED': {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== event.queryId) return state;
      // Edit keeps approved events visible for context (it's the
      // "manage this query" view); only dismissed ones stay hidden.
      const events = event.events
        .filter(e => e.status !== 'dismissed')
        .map(e => ({ ...e, decision: 'none' as const }));
      return {
        ...state,
        editing: {
          ...state.editing,
          // Dates of selected series are approved on save (via the series
          // subscribe cascade), so pre-check their candidates — unticking
          // stages an explicit dismissal.
          events: preselectSeriesEvents(events, state.editing.series),
        },
      };
    }

    case 'EDIT_SERIES_LOADED': {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== event.queryId) return state;
      const previous = new Map((state.editing.series ?? []).map(d => [d.id, d]));
      return {
        ...state,
        editing: {
          ...state.editing,
          events: preselectSeriesEvents(state.editing.events, seedSeriesDrafts(event.series, previous)),
          series: seedSeriesDrafts(event.series, previous),
        },
      };
    }

    case 'TOGGLE_EDIT_SERIES': {
      if (state.kind !== 'dashboard' || !state.editing?.series) return state;
      const draft = state.editing.series.find(s => s.id === event.seriesId);
      if (!draft) return state;
      const selected = !draft.selected;
      return {
        ...state,
        editing: {
          ...state.editing,
          // Selecting auto-opens the accordion and marks the date search as
          // in flight (the caller fires the expand request); deselecting
          // collapses it again. Per-event decisions are left untouched so a
          // re-select restores the staged dates.
          series: state.editing.series.map(s =>
            s.id === event.seriesId
              ? { ...s, selected, expanded: selected ? true : false, expanding: selected ? true : s.expanding }
              : s
          ),
          events: selected
            ? state.editing.events.map(e =>
              e.seriesId === event.seriesId && e.status === 'candidate' && e.decision === 'none'
                ? { ...e, decision: 'approve' as const }
                : e
            )
            : state.editing.events,
        },
      };
    }

    case 'TOGGLE_EDIT_SERIES_EXPAND': {
      if (state.kind !== 'dashboard' || !state.editing?.series) return state;
      if (!state.editing.series.some(s => s.id === event.seriesId)) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          series: state.editing.series.map(s =>
            s.id === event.seriesId ? { ...s, expanded: !s.expanded } : s
          ),
        },
      };
    }

    case 'EDIT_SERIES_EVENTS_LOADED': {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== event.queryId) return state;
      const draft = state.editing.series?.find(s => s.id === event.seriesId);
      if (!draft) return state;
      const incoming = new Map(event.events.map(e => [e.id, e]));
      const kept = state.editing.events.filter(e => !incoming.has(e.id));
      const merged: SelectableEditEvent[] = [
        ...kept,
        // Expanded dates of a selected series are approved on save, so
        // pre-check fresh candidates the same way the toggle does.
        ...event.events.map(e => ({
          ...e,
          decision: (draft.selected && e.status === 'candidate' ? 'approve' : 'none') as EventDecision,
        })),
      ];
      return {
        ...state,
        editing: {
          ...state.editing,
          events: merged,
          series: (state.editing.series ?? []).map(s =>
            s.id === event.seriesId ? { ...s, expanding: false } : s
          ),
        },
      };
    }

    case 'TOGGLE_EDIT_EVENT': {
      if (state.kind !== 'dashboard' || !state.editing) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          // Candidates cycle approve → dismiss → none; approved dates can
          // only be staged for dismissal (or back to kept).
          events: state.editing.events.map(e => {
            if (e.id !== event.id) return e;
            if (e.status === 'candidate') return { ...e, decision: cycleDecision(e.decision) };
            if (e.status === 'approved') return { ...e, decision: e.decision === 'dismiss' ? 'none' as const : 'dismiss' as const };
            return e;
          }),
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
      return {
        kind: 'admin',
        stats: event.stats,
        users: event.users,
        models: event.models,
        search: event.search,
      };

    case 'ADMIN_MODELS_UPDATED':
      if (state.kind !== 'admin') return state;
      return { ...state, models: event.models };

    case 'ADMIN_USER_DELETED':
      if (state.kind !== 'admin') return state;
      return { ...state, users: state.users.filter(user => user.id !== event.id) };

    default:
      return state;
  }
}