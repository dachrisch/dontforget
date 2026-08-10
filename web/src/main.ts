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
} from './api';
import { renderMasthead } from './masthead';

const root = document.getElementById('root')!;
root.before(renderMasthead());

const errorBanner = document.createElement('p');
errorBanner.className = 'error-banner';
errorBanner.hidden = true;
root.before(errorBanner);

function showError(context: string, err: unknown): void {
  console.error(`[dontforget] ${context} failed:`, err);
  errorBanner.textContent = `Something went wrong while ${context}. Please try again.`;
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

async function refreshDashboard(): Promise<void> {
  try {
    const data = await listQueries();
    setState(
      reducer(state, {
        type: 'DASHBOARD_LOADED',
        queries: data.queries,
        feed: data.feed,
      })
    );
  } catch (err) {
    showError('loading your dashboard', err);
  }
}

function paint() {
  renderWorkspace(root, state, {
    onRequestMagicLink: email => {
      clearError();
      requestMagicLink(email)
        .then(() => setState(reducer(state, { type: 'MAGIC_LINK_SENT' })))
        .catch(err => showError('requesting your sign-in link', err));
    },
    onSubmitQuery: (text, recurrenceInterval) => {
      // Snapshot origin before the optimistic transition — after it the
      // state is already `loading` and the dashboard data is gone.
      const fromDashboard = state.kind === 'dashboard';
      clearError();
      setState(reducer(state, { type: 'SUBMIT_QUERY', text }));
      submitQuery(text, recurrenceInterval)
        .then(({ queryId, candidates }) => {
          setState(reducer(state, { type: 'QUERY_RESOLVED', queryId, candidates }));
        })
        .catch(err => {
          showError('searching', err);
          // A returning user's failed search should return them to their
          // saved queries, not a blank workspace.
          if (fromDashboard) refreshDashboard();
          else setState(reducer(state, { type: 'QUERY_FAILED' }));
        });
    },
    onToggleCandidate: id => {
      setState(reducer(state, { type: 'TOGGLE_CANDIDATE', id }));
    },
    onApprove: () => {
      if (state.kind !== 'review') return;
      const fromDashboard = state.fromDashboard === true;
      // Snapshot the current selection now — the user can keep toggling
      // checkboxes while this request is in flight, and the confirmation
      // screen must reflect what was actually sent (and persisted), not
      // whatever `state` has drifted to by the time the response arrives.
      const approved = state.candidates.filter(c => c.selected);
      const eventIds = approved.map(c => c.id);
      clearError();
      approveEvents(state.queryId, eventIds)
        .then(({ icsUrl, rssUrl }) => {
          if (fromDashboard) {
            refreshDashboard();
          } else {
            setState(reducer(state, { type: 'APPROVE_RESOLVED', icsUrl, rssUrl, approved }));
          }
        })
        .catch(err => showError('approving events', err));
    },
    onStartEdit: queryId => {
      clearError();
      setState(reducer(state, { type: 'START_EDIT', queryId }));
      // The dashboard card opens immediately; the events for it load async.
      getQueryEvents(queryId)
        .then(events => setState(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId, events })))
        .catch(err => showError('loading events', err));
    },
    onToggleEditEvent: id => {
      setState(reducer(state, { type: 'TOGGLE_EDIT_EVENT', id }));
    },
    onCancelEdit: () => {
      setState(reducer(state, { type: 'CANCEL_EDIT' }));
    },
    onSaveEdit: (queryId, patch) => {
      clearError();
      // Snapshot the selected candidates at save time; the edit card stays
      // interactive while the PATCH + approve round-trips, and we reload the
      // dashboard once both have settled so counts and feed links refresh.
      const selectedIds =
        state.kind === 'dashboard' && state.editing?.queryId === queryId
          ? state.editing.events.filter(e => e.status === 'candidate' && e.selected).map(e => e.id)
          : [];
      updateQuery(queryId, patch)
        .then(() => {
          if (selectedIds.length > 0) return approveEvents(queryId, selectedIds);
          return undefined;
        })
        .then(() => refreshDashboard())
        .catch(err => showError('saving changes', err));
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
        .catch(err => showError('deleting query', err));
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
      }
    });
  })
  .catch(err => {
    showError('loading dontforget', err);
    setState({ kind: 'signedOut' });
  });