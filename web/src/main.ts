import './style.css';
import { reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import {
  requestMagicLink,
  checkSession,
  submitQuery,
  approveEvents,
  listQueries,
  updateQuery,
  getQueryEvents,
  deleteQuery,
  rotateFeedToken,
  runQuery,
  signOut,
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

// While any query is mid-search the dashboard polls itself so the running
// card flips to its results without a reload. One timer at a time, and it
// only exists while something is actually running.
const POLL_INTERVAL_MS = 4000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDashboardPoll(): void {
  if (pollTimer) return;
  if (state.kind !== 'dashboard') return;
  if (!state.queries.some(q => q.status === 'running')) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshDashboard();
  }, POLL_INTERVAL_MS);
}

async function refreshDashboard(): Promise<void> {
  try {
    const previous = state.kind === 'dashboard' ? state.queries : [];
    const data = await listQueries();
    setState(reducer(state, { type: 'DASHBOARD_LOADED', queries: data.queries, feed: data.feed }));
    // A query that finished searching while we were watching opens its
    // review inline — the user just submitted it from here and is waiting
    // on the card, so land them straight on the approval tiles.
    if (state.kind === 'dashboard') {
      const dashboardState = state;
      const landed = dashboardState.queries.find(
        q =>
          q.status !== 'running' &&
          q.candidateCount > 0 &&
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
    },
    onToggleEditEvent: id => {
      setState(reducer(state, { type: 'TOGGLE_EDIT_EVENT', id }));
    },
    onCancelEdit: () => {
      setState(reducer(state, { type: 'CANCEL_EDIT' }));
    },
    onSaveEdit: (queryId, patch) => {
      clearError();
      // Snapshot the decided candidates at save time; the edit card stays
      // interactive while the PATCH + approve round-trips, and we reload the
      // dashboard once both have settled so counts and feed links refresh.
      const editingEvents =
        state.kind === 'dashboard' && state.editing?.queryId === queryId ? state.editing.events : [];
      const approveIds = editingEvents.filter(e => e.status === 'candidate' && e.decision === 'approve').map(e => e.id);
      const dismissIds = editingEvents.filter(e => e.status === 'candidate' && e.decision === 'dismiss').map(e => e.id);
      updateQuery(queryId, patch)
        .then(() => {
          if (approveIds.length > 0 || dismissIds.length > 0) {
            return approveEvents(queryId, approveIds, undefined, dismissIds);
          }
          return undefined;
        })
        .then(() => refreshDashboard())
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
  });
}

checkSession()
  .then(authenticated => {
    if (!authenticated) {
      setState({ kind: 'signedOut' });
      return;
    }
    return listQueries().then(data => {
      // First-time users have no saved queries and get the focused
      // single-input workspace; returning users get the full dashboard.
      if (data.queries.length === 0) {
        setState({ kind: 'empty' });
      } else {
        setState(
          reducer(state, { type: 'DASHBOARD_LOADED', queries: data.queries, feed: data.feed })
        );
        // If the server was mid-search when the page loaded (a reload during
        // a slow run), resume polling so the card can land.
        scheduleDashboardPoll();
      }
    });
  })
  .catch(err => {
    showError('error.loadingApp', err);
    setState({ kind: 'signedOut' });
  });