import type { WorkspaceState, SelectableEditEvent } from './state';
import { RECURRENCE_INTERVALS } from './types';
import type { EventDetail, FeedSummary, QuerySummary, RecurrenceInterval } from './types';

export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string, recurrenceInterval: RecurrenceInterval) => void;
  onToggleCandidate: (id: string) => void;
  onApprove: () => void;
  onStartEdit: (queryId: string) => void;
  onToggleEditEvent: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (queryId: string, patch: { text: string; recurrenceInterval: RecurrenceInterval }) => void;
  onDeleteQuery: (queryId: string) => void;
  onRotateFeedToken: () => void;
}

const lastRenderedKind = new WeakMap<HTMLElement, WorkspaceState['kind']>();

export function renderWorkspace(
  container: HTMLElement,
  state: WorkspaceState,
  handlers: WorkspaceHandlers
): void {
  const isStateTransition = lastRenderedKind.get(container) !== state.kind;
  const focusedId = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>('[data-id]')?.dataset.id
    : undefined;

  container.innerHTML = '';
  const wrapper = render(state, handlers);
  // Only animate in on an actual state change — re-rendering the same
  // state (e.g. toggling one tile in `review`) must not replay the
  // whole-panel enter animation on every interaction.
  if (isStateTransition) {
    wrapper.classList.add('workspace-enter');
  }
  lastRenderedKind.set(container, state.kind);
  container.appendChild(wrapper);

  // A full re-render tears down and rebuilds every element, so the
  // previously focused control (e.g. a review tile's checkbox) loses
  // focus by default. Restore it on the matching element so keyboard
  // users don't lose their place after each toggle.
  if (focusedId) {
    container.querySelector<HTMLElement>(`[data-id="${focusedId}"] input`)?.focus();
  }
}

function render(state: WorkspaceState, handlers: WorkspaceHandlers): HTMLElement {
  switch (state.kind) {
    case 'signedOut':
      return renderSignedOut(handlers);
    case 'linkSent':
      return renderLinkSent();
    case 'empty':
      return renderEmpty(handlers, state.queryText);
    case 'loading':
      return renderLoading(state.queryText);
    case 'review':
      return renderReview(state.candidates, handlers);
    case 'feedReady':
      return renderFeedReady(state.icsUrl, state.rssUrl);
    case 'dashboard':
      return renderDashboard(state.queries, state.feed, state.editing, handlers);
  }
}

function renderSignedOut(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <h1>Sign in</h1>
    <p class="subtext">No password — we'll email you a link.</p>
    <form class="ruled-form">
      <input class="ruled-input" type="email" name="email" placeholder="you@example.com" required />
      <button class="stamp-button" type="submit">Email me a link</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const email = wrapper.querySelector<HTMLInputElement>('input[type=email]')!.value;
    handlers.onRequestMagicLink(email);
  });
  return wrapper;
}

function renderLinkSent(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <p class="ornament">※</p>
    <p>Check your inbox — the link signs you in.</p>
  `;
  return wrapper;
}

function renderEmpty(handlers: WorkspaceHandlers, queryText?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="ruled-form">
      <label class="entry-label" for="query-input">What do you want to track?</label>
      <input class="ruled-input" id="query-input" name="query" placeholder="e.g. Auer Dult Munich" value="${escapeHtml(queryText ?? '')}" required />
      <button class="stamp-button" type="submit">Search</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text, 'weekly');
  });
  return wrapper;
}

function renderLoading(queryText: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <span class="chip-torn">${escapeHtml(queryText)}</span>
    <p class="loading-status">
      Searching → extracting dates…
      <span class="ticks">
        <span class="tick"></span>
        <span class="tick"></span>
        <span class="tick"></span>
      </span>
    </p>
  `;
  return wrapper;
}

const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// startDate/endDate come from LLM-extracted search results (see
// src/search/opencodeClient.ts), not a validated schema — malformed
// values must degrade to the raw string, never to "undefined".
function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  if (!ISO_DATE_RE.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function monthAbbrev(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? MONTH_ABBREVS[parsed.month - 1] : '?';
}

function dayNumber(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? String(parsed.day) : '?';
}

function formatIsoDate(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? `${MONTH_ABBREVS[parsed.month - 1]} ${parsed.day}, ${parsed.year}` : iso;
}

function formatRange(startDate: string, endDate: string): string {
  if (startDate === endDate) return formatIsoDate(startDate);
  return `${formatIsoDate(startDate)}–${formatIsoDate(endDate)}`;
}

// lastRunAt / lastFetchedAt are full ISO timestamps from the backend, not
// the YYYY-MM-DD dates above — degrade to the raw string on any parse issue.
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderReview(
  candidates: Array<{ id: string; label: string; startDate: string; endDate: string; sourceUrl: string; selected: boolean }>,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');
  const tiles = candidates
    .map(
      c => `
      <label class="day-tile ${c.selected ? 'day-tile-selected' : ''}" data-id="${c.id}">
        <input type="checkbox" ${c.selected ? 'checked' : ''} />
        <span class="day-tile-month">${monthAbbrev(c.startDate)}</span>
        <span class="day-tile-day">${dayNumber(c.startDate)}</span>
        <span class="day-tile-caption">${escapeHtml(formatRange(c.startDate, c.endDate))} · ${escapeHtml(c.label)}</span>
        <a class="day-tile-source" href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">source</a>
      </label>`
    )
    .join('');
  wrapper.innerHTML = `
    <div class="tile-grid">${tiles}</div>
    <button class="stamp-button" type="button" data-action="approve">Approve selected (${candidates.filter(c => c.selected).length})</button>
  `;
  wrapper.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('click', () => {
      const id = checkbox.closest<HTMLElement>('.day-tile')!.dataset.id!;
      handlers.onToggleCandidate(id);
    });
  });
  wrapper.querySelectorAll<HTMLAnchorElement>('.day-tile-source').forEach(a => {
    a.addEventListener('click', e => e.stopPropagation());
  });
  wrapper.querySelector('button[data-action=approve]')!.addEventListener('click', () => {
    handlers.onApprove();
  });
  return wrapper;
}

function renderFeedReady(icsUrl: string, rssUrl: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <p class="subtext">Future runs add new dates automatically — nothing to approve next time.</p>
    <div class="ledger-row">
      <span class="ledger-label">Calendar (ICS)</span>
      <a class="ledger-value" href="${escapeHtml(icsUrl)}">${escapeHtml(icsUrl)}</a>
    </div>
    <div class="ledger-row">
      <span class="ledger-label">RSS</span>
      <a class="ledger-value" href="${escapeHtml(rssUrl)}">${escapeHtml(rssUrl)}</a>
    </div>
  `;
  return wrapper;
}

const INTERVAL_LABELS: Record<RecurrenceInterval, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

function renderIntervalSelect(
  name: string,
  selected: RecurrenceInterval
): string {
  const options = RECURRENCE_INTERVALS.map(
    interval => `<option value="${interval}" ${interval === selected ? 'selected' : ''}>${INTERVAL_LABELS[interval]}</option>`
  ).join('');
  return `<select class="ruled-select" name="${name}">${options}</select>`;
}

function renderDashboard(
  queries: QuerySummary[],
  feed: FeedSummary | null,
  editing: {
    queryId: string;
    text: string;
    recurrenceInterval: RecurrenceInterval;
    events: SelectableEditEvent[];
  } | null,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');

  const cards = queries
    .map(query => {
      const isEditing = editing?.queryId === query.id;
      return isEditing ? renderEditCard(editing) : renderQueryCard(query);
    })
    .join('');

  wrapper.innerHTML = `
    <form class="ruled-form dashboard-add">
      <label class="entry-label" for="dashboard-query-input">What do you want to track?</label>
      <input class="ruled-input" id="dashboard-query-input" name="query" placeholder="e.g. Auer Dult Munich" required />
      <div class="interval-wrap">
        <label class="interval-label" for="dashboard-interval">Re-runs</label>
        ${renderIntervalSelect('recurrenceInterval', 'weekly')}
      </div>
      <button class="stamp-button" type="submit">Search</button>
    </form>

    ${queries.length > 0 ? `<section class="query-list" aria-label="Saved queries">${cards}</section>` : ''}

    <section class="feed-summary" aria-label="Your calendar feed">
      <h2 class="dashboard-section-title">Your calendar</h2>
      ${
        feed
          ? `
            <div class="ledger-row">
              <span class="ledger-label">Calendar (ICS)</span>
              <a class="ledger-value" href="${escapeHtml(feed.icsUrl)}">${escapeHtml(feed.icsUrl)}</a>
            </div>
            <div class="ledger-row">
              <span class="ledger-label">RSS</span>
              <a class="ledger-value" href="${escapeHtml(feed.rssUrl)}">${escapeHtml(feed.rssUrl)}</a>
            </div>
            <div class="ledger-row">
              <span class="ledger-label">Last fetched</span>
              <span class="ledger-value">${feed.lastFetchedAt ? escapeHtml(formatTimestamp(feed.lastFetchedAt)) : 'Never'}</span>
            </div>
            <button type="button" class="stamp-button stamp-button-quiet" data-action="rotate-feed">Rotate feed URL</button>
            <p class="subtext">Leaked or shared your calendar link by mistake? Rotating mints a new one and breaks the old link immediately.</p>`
          : `<p class="subtext">No calendar yet — approve your first search results to mint your private feed link.</p>`
      }
    </section>
  `;

  wrapper.querySelector<HTMLFormElement>('.dashboard-add')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('.dashboard-add input[name=query]')!.value;
    const interval = wrapper.querySelector<HTMLSelectElement>('.dashboard-add select[name=recurrenceInterval]')!.value;
    handlers.onSubmitQuery(text, interval as RecurrenceInterval);
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=edit]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onStartEdit(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=delete]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.confirmed !== 'true') {
        button.dataset.confirmed = 'true';
        button.textContent = 'Confirm delete?';
        return;
      }
      handlers.onDeleteQuery(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.feed-summary button[data-action=rotate-feed]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.confirmed !== 'true') {
        button.dataset.confirmed = 'true';
        button.textContent = 'Confirm rotate?';
        return;
      }
      handlers.onRotateFeedToken();
    });
  });

  wrapper.querySelectorAll<HTMLInputElement>('.query-card-editing .day-tile input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('click', () => {
      const id = checkbox.closest<HTMLElement>('.day-tile')!.dataset.id!;
      handlers.onToggleEditEvent(id);
    });
  });

  wrapper.querySelectorAll<HTMLAnchorElement>('.query-card-editing .day-tile-source').forEach(a => {
    a.addEventListener('click', e => e.stopPropagation());
  });

  wrapper.querySelectorAll<HTMLFormElement>('.query-card form.edit-form').forEach(form => {
    const card = form.closest<HTMLElement>('.query-card')!;
    const queryId = card.dataset.id!;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const text = form.querySelector<HTMLInputElement>('input[name=editText]')!.value;
      if (!text.trim()) return;
      const interval = form.querySelector<HTMLSelectElement>('select[name=editInterval]')!.value;
      handlers.onSaveEdit(queryId, { text, recurrenceInterval: interval as RecurrenceInterval });
    });
    form.querySelector<HTMLButtonElement>('button[data-action=cancel]')!.addEventListener('click', () => {
      handlers.onCancelEdit();
    });
  });

  return wrapper;
}

function renderQueryCard(query: QuerySummary): string {
  const eventSummary = [];
  if (query.approvedCount > 0) eventSummary.push(`${query.approvedCount} approved`);
  if (query.candidateCount > 0) eventSummary.push(`${query.candidateCount} pending approval`);
  return `
    <article class="query-card" data-id="${query.id}">
      <div class="query-card-head">
        <span class="query-card-text">${escapeHtml(query.text)}</span>
        <div class="query-card-actions">
          <button type="button" class="link-button" data-action="edit">Edit</button>
          <button type="button" class="link-button link-button-danger" data-action="delete">Delete</button>
        </div>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">Re-runs</span>
        <span class="ledger-value">${INTERVAL_LABELS[query.recurrenceInterval]}</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">Last run</span>
        <span class="ledger-value">${query.lastRunAt ? escapeHtml(formatTimestamp(query.lastRunAt)) : 'Never'}</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">Events</span>
        <span class="ledger-value">${eventSummary.length > 0 ? escapeHtml(eventSummary.join(' · ')) : 'None yet'}</span>
      </div>
    </article>
  `;
}

function renderEditCard(
  editing: { queryId: string; text: string; recurrenceInterval: RecurrenceInterval; events: SelectableEditEvent[] }
): string {
  const approved = editing.events.filter(e => e.status === 'approved');
  const pending = editing.events.filter(e => e.status === 'candidate');
  const selectedCount = pending.filter(e => e.selected).length;

  const eventTiles = [
    ...pending.map(e => renderSelectableTile(e)),
    ...approved.map(e => renderApprovedTile(e)),
  ].join('');

  const eventsSection = editing.events.length > 0
    ? `
      <div class="edit-events">
        <label class="entry-label">Events</label>
        <div class="tile-grid edit-tile-grid">${eventTiles}</div>
        <p class="subtext">Saving approves the selected pending dates. ${pending.length > 0 ? `${approved.length} approved · ${pending.length} pending approval.` : ''}</p>
      </div>`
    : `
      <p class="subtext">No events extracted yet for this query yet.</p>`;

  return `
    <article class="query-card query-card-editing" data-id="${editing.queryId}">
      <form class="edit-form ruled-form">
        <label class="entry-label" for="edit-text">Query</label>
        <input class="ruled-input" id="edit-text" name="editText" value="${escapeHtml(editing.text)}" required />
        <div class="interval-wrap">
          <label class="interval-label" for="edit-interval">Re-runs</label>
          ${renderIntervalSelect('editInterval', editing.recurrenceInterval)}
        </div>
        ${eventsSection}
        <div class="edit-actions">
          <button class="stamp-button" type="submit" data-action="save">Save and approve (${selectedCount})</button>
          <button class="stamp-button stamp-button-quiet" type="button" data-action="cancel">Cancel</button>
        </div>
      </form>
    </article>
  `;
}

function renderSelectableTile(event: SelectableEditEvent): string {
  return `
    <label class="day-tile ${event.selected ? 'day-tile-selected' : ''}" data-id="${event.id}">
      <input type="checkbox" ${event.selected ? 'checked' : ''} />
      <span class="day-tile-month">${monthAbbrev(event.startDate)}</span>
      <span class="day-tile-day">${dayNumber(event.startDate)}</span>
      <span class="day-tile-caption">${escapeHtml(formatRange(event.startDate, event.endDate))} · ${escapeHtml(event.label)}</span>
      <a class="day-tile-source" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener">source</a>
    </label>`;
}

function renderApprovedTile(event: EventDetail): string {
  return `
    <span class="day-tile day-tile-approved" data-id="${event.id}">
      <span class="day-tile-month">${monthAbbrev(event.startDate)}</span>
      <span class="day-tile-day">${dayNumber(event.startDate)}</span>
      <span class="day-tile-caption">${escapeHtml(formatRange(event.startDate, event.endDate))} · ${escapeHtml(event.label)} · approved</span>
    </span>`;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}