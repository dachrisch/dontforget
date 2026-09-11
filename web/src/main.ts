import './style.css';
import { canRefreshDashboard, reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import {
  requestMagicLink,
  getMe,
  submitQuery,
  approveEvents,
  listQueries,
  updateQuery,
  getQueryEvents,
  listSeries,
  expandSeries,
  deleteQuery,
  rotateFeedToken,
  runQuery,
  reviewSeries,
  signOut,
  deleteAccount,
  getAdminStats,
  listAdminUsers,
  deleteAdminUser,
  listAdminModels,
  getAdminSearch,
  updateAdminModel,
  addAdminModel,
} from './api';
import { renderMasthead, startWordmarkAnimation } from './masthead';
import { detectLocale, setLocale, t, type MessageKey } from './i18n';

setLocale(detectLocale());

const root = document.getElementById('root')!;
root.before(renderMasthead());
startWordmarkAnimation();

const errorBanner = document.createElement('div');
errorBanner.className = 'error-banner';
errorBanner.hidden = true;
const errorMessage = document.createElement('span');
const errorDismiss = document.createElement('button');
errorDismiss.type = 'button';
errorDismiss.className = 'error-dismiss';
errorDismiss.setAttribute('aria-label', t('error.dismissAria'));
errorDismiss.textContent = '×';
errorDismiss.addEventListener('click', clearError);
errorBanner.appendChild(errorMessage);
errorBanner.appendChild(errorDismiss);
root.before(errorBanner);

function showError(key: MessageKey, err: unknown): void {
  console.error(`[dontforget] ${key} failed:`, err);
  errorMessage.textContent = t(key);
  errorBanner.hidden = false;
}

function clearError(): void {
  errorBanner.hidden = true;
}

let state: WorkspaceState = { kind: 'signedOut' };

function setState(next: WorkspaceState) {
  state = next;
  paint();
}

// Admin-only entry point, mounted into the masthead once auth reveals the
// current user is an admin. Lives outside the workspace state machine on
// purpose — the masthead persists across every workspace state, so an admin
// can reach the panel from the empty state or the dashboard alike.
function mountAdminNav(): void {
  const masthead = document.querySelector<HTMLElement>('.masthead');
  if (!masthead || masthead.querySelector('.admin-nav')) return;
  const nav = document.createElement('nav');
  nav.className = 'admin-nav';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-button';
  button.textContent = t('admin.nav');
  button.addEventListener('click', () => {
    clearError();
    setState({ kind: 'admin', stats: null, users: [], models: [], search: null });
    void refreshAdmin();
  });
  nav.appendChild(button);
  masthead.appendChild(nav);
}

async function refreshAdmin(): Promise<void> {
  try {
    const [stats, users, models, search] = await Promise.all([
      getAdminStats(),
      listAdminUsers(),
      listAdminModels(),
      getAdminSearch(),
    ]);
    setState(reducer(state, { type: 'ADMIN_LOADED', stats, users, models, search }));
  } catch (err) {
    showError('error.loadingAdmin', err);
  }
}

async function boot(): Promise<void> {
  try {
    const me = await getMe();
    if (!me.authenticated) {
      setState({ kind: 'signedOut' });
      return;
    }
    if (me.role === 'admin') {
      mountAdminNav();
    }
    const data = await listQueries();
    // First-time users have no saved queries and get the focused
    // single-input workspace; returning users get the full dashboard.
    if (data.queries.length === 0) {
      setState({ kind: 'empty' });
    } else {
      setState(reducer(state, { type: 'DASHBOARD_LOADED', queries: data.queries, feed: data.feed }));
      // If the server was mid-search when the page loaded (a reload during
      // a slow run), resume polling so the card can land.
      scheduleDashboardPoll();
    }
  } catch (err) {
    showError('error.loadingApp', err);
    setState({ kind: 'signedOut' });
  }
}

// While any query is mid-search (or a subscribed series' dates are still
// being expanded) the dashboard polls itself so the running card flips to its
// results and the pulsing status dot clears without a reload. One timer at a
// time, and it only exists while something is actually in flight.
const POLL_INTERVAL_MS = 4000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function hasInFlightWork(): boolean {
  if (state.kind !== 'dashboard') return false;
  return state.queries.some(
    q => q.status === 'running' || (q.series?.some(s => s.expanding) ?? false)
  );
}

function scheduleDashboardPoll(): void {
  if (pollTimer) return;
  if (!hasInFlightWork()) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshDashboard();
  }, POLL_INTERVAL_MS);
}

async function refreshDashboard(): Promise<void> {
  // A search runs in the background and its poll must stay in the background
  // too: if the user has since navigated away (e.g. into the admin panel),
  // drop the refresh rather than dragging them back to the dashboard.
  if (!canRefreshDashboard(state)) return;
  try {
    const previous = state.kind === 'dashboard' ? state.queries : [];
    const data = await listQueries();
    // Re-check after the fetch resolves — the user may have navigated away
    // while it was in flight, and the result is now stale for this page.
    if (!canRefreshDashboard(state)) return;
    setState(reducer(state, { type: 'DASHBOARD_LOADED', queries: data.queries, feed: data.feed }));
    // A query that finished searching while we were watching opens its
    // review inline — the user just submitted it from here and is waiting
    // on the card, so land them straight on the approval tiles. Queries
    // with series skip this: their review happens one level above (series
    // subscribe buttons on the card, single dates in the calendar).
    if (state.kind === 'dashboard') {
      const dashboardState = state;
      const landed = dashboardState.queries.find(
        q =>
          q.status !== 'running' &&
          q.candidateCount > 0 &&
          (q.series?.length ?? 0) === 0 &&
          previous.some(p => p.id === q.id && p.status === 'running') &&
          dashboardState.editing?.queryId !== q.id &&
          dashboardState.reviewing?.queryId !== q.id
      );
      if (landed) startReview(landed.id);
    }
  } catch (err) {
    showError('error.loadingDashboard', err);
  } finally {
    scheduleDashboardPoll();
  }
}

function startReview(queryId: string): void {
  setState(reducer(state, { type: 'START_REVIEW', queryId }));
  // The card opens immediately; the events for it load async. Which
  // statuses actually reach the card is decided by the reducer (see
  // state.ts's REVIEW_EVENTS_LOADED case).
  getQueryEvents(queryId)
    .then(events => {
      setState(reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId, events }));
    })
    .catch(err => showError('error.loadingEvents', err));
}

function paint() {
  renderWorkspace(root, state, {
    onRequestMagicLink: email => {
      clearError();
      requestMagicLink(email)
        .then(() => setState(reducer(state, { type: 'MAGIC_LINK_SENT' })))
        .catch(err => showError('error.requestingLink', err));
    },
    onSubmitQuery: text => {
      clearError();
      // The search runs in the background now — this only creates the query
      // row. The dashboard (or, for a first-time user, the dashboard the
      // refresh lands them on) picks the results up on its next poll.
      submitQuery(text)
        .then(() => refreshDashboard())
        .catch(err => showError('error.searching', err));
    },
    onStartReview: queryId => {
      clearError();
      startReview(queryId);
    },
    onToggleEditSeries: (queryId, seriesId) => {
      if (state.kind !== 'dashboard' || state.editing?.queryId !== queryId) return;
      const wasSelected = state.editing.series?.find(s => s.id === seriesId)?.selected ?? false;
      clearError();
      setState(reducer(state, { type: 'TOGGLE_EDIT_SERIES', seriesId }));
      // Selecting a series searches its dates right away — the accordion
      // shows a spinner until they land. The subscription itself is only
      // staged and persisted on save.
      if (!wasSelected) {
        expandSeries(queryId, seriesId)
          .then(events => {
            setState(reducer(state, { type: 'EDIT_SERIES_EVENTS_LOADED', queryId, seriesId, events }));
          })
          .catch(err => {
            showError('error.loadingEvents', err);
            // Clear the spinner; the accordion falls back to the preview.
            setState(reducer(state, { type: 'EDIT_SERIES_EVENTS_LOADED', queryId, seriesId, events: [] }));
          });
      }
    },
    onToggleEditSeriesExpand: seriesId => {
      setState(reducer(state, { type: 'TOGGLE_EDIT_SERIES_EXPAND', seriesId }));
    },
    onToggleReviewEvent: id => {
      setState(reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id }));
    },
    onSetReviewInterval: interval => {
      setState(reducer(state, { type: 'SET_REVIEW_INTERVAL', interval }));
    },
    onApproveReview: queryId => {
      if (state.kind !== 'dashboard' || state.reviewing?.queryId !== queryId) return;
      // Snapshot the current decisions now — the user can keep cycling
      // tiles while this request is in flight.
      const approveIds = state.reviewing.events
        .filter(e => e.status === 'candidate' && e.decision === 'approve')
        .map(e => e.id);
      const dismissIds = state.reviewing.events
        .filter(e => e.status === 'candidate' && e.decision === 'dismiss')
        .map(e => e.id);
      clearError();
      // Deliberately unconditional (unlike onSaveEdit's guarded call below):
      // it must fire even when approveIds is empty, because a dismiss-only
      // submit (zero approvals, one or more dismissals) still needs to reach
      // the server. Do not add an `if (approveIds.length > 0)` guard here —
      // that would silently break dismiss-only submits.
      approveEvents(queryId, approveIds, state.reviewing.recurrenceInterval, dismissIds)
        .then(() => {
          setState(reducer(state, { type: 'REVIEW_APPROVED', queryId }));
          refreshDashboard();
        })
        .catch(err => showError('error.approving', err));
    },
    onCancelReview: () => {
      setState(reducer(state, { type: 'CANCEL_REVIEW' }));
    },
    onRetrySearch: queryId => {
      clearError();
      runQuery(queryId)
        .then(() => refreshDashboard())
        .catch(err => showError('error.searching', err));
    },
    onStartEdit: queryId => {
      clearError();
      setState(reducer(state, { type: 'START_EDIT', queryId }));
      // The dashboard card opens immediately; the events for it load async.
      // Which statuses actually reach the card is decided by the reducer
      // (see state.ts's EDIT_EVENTS_LOADED case).
      getQueryEvents(queryId)
        .then(events => {
          setState(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId, events }));
        })
        .catch(err => showError('error.loadingEvents', err));
      // Series queries additionally load their triage list; selecting a row
      // searches its dates (see onToggleEditSeries).
      const hasSeries =
        state.kind === 'dashboard' &&
        (state.queries.find(q => q.id === queryId)?.series?.length ?? 0) > 0;
      if (hasSeries) {
        listSeries(queryId)
          .then(series => {
            setState(reducer(state, { type: 'EDIT_SERIES_LOADED', queryId, series }));
          })
          .catch(err => showError('error.loadingSeries', err));
      }
    },
    onToggleEditEvent: id => {
      setState(reducer(state, { type: 'TOGGLE_EDIT_EVENT', id }));
    },
    onCancelEdit: () => {
      setState(reducer(state, { type: 'CANCEL_EDIT' }));
    },
    onSaveEdit: (queryId, patch) => {
      clearError();
      // Snapshot the staged decisions at save time — the edit card stays
      // interactive while the round-trips run, and we reload once everything
      // has settled so counts and feed links refresh.
      const editing =
        state.kind === 'dashboard' && state.editing?.queryId === queryId ? state.editing : null;
      const drafts = editing?.series ?? [];
      const hasSeriesDrafts = drafts.length > 0;
      // Series delta: staged selection vs last known server status.
      // Dismissing a series cascades to its events server-side, so per-event
      // decisions are only sent for dates of selected series.
      const approveSeries = drafts.filter(s => s.selected && s.status !== 'approved').map(s => s.id);
      const dismissSeries = drafts.filter(s => !s.selected && s.status === 'approved').map(s => s.id);
      const selectedIds = new Set(drafts.filter(s => s.selected).map(s => s.id));
      const inScope = (editing?.events ?? []).filter(e => !hasSeriesDrafts || !e.seriesId || selectedIds.has(e.seriesId));
      const approveIds = inScope.filter(e => e.status === 'candidate' && e.decision === 'approve').map(e => e.id);
      const dismissIds = inScope.filter(e => e.decision === 'dismiss').map(e => e.id);
      updateQuery(queryId, patch)
        .then(() => {
          if (hasSeriesDrafts && (approveSeries.length > 0 || dismissSeries.length > 0)) {
            // Newly approved series expand into dates in the background via
            // the existing per-series path; the open card picks them up on
            // its next poll. Re-seed the drafts from the review response so
            // staged selections settle against the server status.
            return reviewSeries(queryId, approveSeries, dismissSeries).then(updated => {
              setState(reducer(state, { type: 'EDIT_SERIES_LOADED', queryId, series: updated }));
            });
          }
          return undefined;
        })
        .then(() => {
          if (approveIds.length > 0 || dismissIds.length > 0) {
            return approveEvents(queryId, approveIds, undefined, dismissIds);
          }
          return undefined;
        })
        .then(() => getQueryEvents(queryId))
        .then(events => {
          setState(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId, events }));
          refreshDashboard();
        })
        .catch(err => showError('error.saving', err));
    },
    onDeleteQuery: queryId => {
      clearError();
      deleteQuery(queryId)
        .then(() => {
          if (state.kind !== 'dashboard') return;
          if (state.queries.length === 1) {
            setState({ kind: 'empty' });
          } else {
            setState(reducer(state, { type: 'QUERY_DELETED', queryId }));
          }
        })
        .catch(err => showError('error.deleting', err));
    },
    onRotateFeedToken: () => {
      clearError();
      rotateFeedToken()
        .then(({ icsUrl, rssUrl }) => {
          setState(reducer(state, { type: 'FEED_ROTATED', icsUrl, rssUrl }));
        })
        .catch(err => showError('error.rotating', err));
    },
    onSignOut: () => {
      clearError();
      signOut()
        .then(() => setState({ kind: 'signedOut' }))
        .catch(err => showError('error.signingOut', err));
    },
    onDeleteAccount: () => {
      clearError();
      deleteAccount()
        .then(() => setState({ kind: 'signedOut' }))
        .catch(err => showError('error.deletingAccount', err));
    },
    onCloseAdmin: () => {
      clearError();
      void boot();
    },
    onDeleteAdminUser: userId => {
      clearError();
      deleteAdminUser(userId)
        .then(() => refreshAdmin())
        .catch(err => showError('error.deletingUser', err));
    },
    onSetAdminModel: (id, patch) => {
      clearError();
      updateAdminModel(id, patch)
        .then(() => refreshAdmin())
        .catch(err => showError('error.updatingModel', err));
    },
    onAddAdminModel: (id, providerID) => {
      clearError();
      addAdminModel(id, providerID)
        .then(() => refreshAdmin())
        .catch(err => showError('error.addingModel', err));
    },
  });
}

void boot();