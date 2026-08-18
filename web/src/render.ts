import type { WorkspaceState, SelectableEditEvent } from './state';
import { RECURRENCE_INTERVALS } from './types';
import type { EventDetail, FeedSummary, QuerySummary, RecurrenceInterval } from './types';
import { getLocale, MONTH_ABBREVS, t, type MessageKey } from './i18n';

export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string, recurrenceInterval?: RecurrenceInterval) => void;
  onToggleCandidate: (id: string) => void;
  onSetReviewInterval: (interval: RecurrenceInterval) => void;
  onApprove: () => void;
  onCancelSearch: () => void;
  onStartEdit: (queryId: string) => void;
  onToggleEditEvent: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (queryId: string, patch: { text: string; recurrenceInterval: RecurrenceInterval }) => void;
  onDeleteQuery: (queryId: string) => void;
  onRotateFeedToken: () => void;
  onGoToDashboard: () => void;
  onStartOver: () => void;
  onSignOut: () => void;
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
    const target = container.querySelector<HTMLElement>(`[data-id="${focusedId}"] input`) ??
      container.querySelector<HTMLElement>(`[data-id="${focusedId}"] select`);
    target?.focus();
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
    case 'noResults':
      return renderNoResults(state.queryText, state.fromDashboard === true, handlers);
    case 'loading':
      return renderLoading(state.queryText, handlers);
    case 'review':
      return renderReview(state, handlers);
    case 'feedReady':
      return renderFeedReady(state.icsUrl, state.rssUrl, handlers);
    case 'dashboard':
      return renderDashboard(state.queries, state.feed, state.editing, handlers);
  }
}

function renderSignedOut(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <h1>${t('signIn.title')}</h1>
    <p class="subtext">${t('signIn.pitch')}</p>
    <p class="subtext">${t('signIn.noPassword')}</p>
    <form class="ruled-form">
      <input class="ruled-input" type="email" name="email" placeholder="${t('signIn.placeholder')}" required />
      <button class="stamp-button" type="submit">${t('signIn.button')}</button>
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
    <p>${t('linkSent.text')}</p>
  `;
  return wrapper;
}

function renderEmpty(handlers: WorkspaceHandlers, queryText?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="ruled-form">
      <label class="entry-label" for="query-input">${t('empty.label')}</label>
      <input class="ruled-input" id="query-input" name="query" placeholder="${t('empty.placeholder')}" value="${escapeHtml(queryText ?? '')}" required />
      <button class="stamp-button" type="submit">${t('empty.button')}</button>
    </form>
    <p class="subtext how-it-works">${t('empty.howItWorks')}</p>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  return wrapper;
}

// A search that completes but surfaces no candidate dates. The search is
// saved (it will be re-run on schedule), but the user wants a way to adjust
// the term or search again right now instead of staring at an empty review.
function renderNoResults(queryText: string, fromDashboard: boolean, handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <span class="chip-torn">${escapeHtml(queryText)}</span>
    <p class="subtext no-results-message">${t('noResults.message', { query: escapeHtml(queryText) })}</p>
    <form class="ruled-form">
      <label class="entry-label" for="no-results-input">${t('empty.label')}</label>
      <input class="ruled-input" id="no-results-input" name="query" value="${escapeHtml(queryText)}" placeholder="${t('empty.placeholder')}" required />
      <button class="stamp-button" type="submit">${t('noResults.searchAgain')}</button>
    </form>
    <div class="edit-actions">
      <button class="stamp-button stamp-button-quiet" type="button" data-action="no-results-cancel">${fromDashboard ? t('noResults.backToDashboard') : t('noResults.cancel')}</button>
    </div>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  wrapper.querySelector('button[data-action=no-results-cancel]')!.addEventListener('click', () => {
    if (fromDashboard) handlers.onGoToDashboard();
    else handlers.onStartOver();
  });
  return wrapper;
}

// A search that hits opencode retry/fallback (see opencodeClient.ts) can
// run well past a normal search's ~30-45s — confirmed against production
// logs on 2026-08-17. Reassure the user instead of leaving a static message
// that starts to look stuck.
const LONGER_THAN_USUAL_DELAY_MS = 60_000;

function renderLoading(queryText: string, handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <span class="chip-torn">${escapeHtml(queryText)}</span>
    <p class="loading-status">
      <span class="loading-status-text">${t('loading.status')}</span>
      <span class="ticks">
        <span class="tick"></span>
        <span class="tick"></span>
        <span class="tick"></span>
      </span>
    </p>
    <button class="stamp-button stamp-button-quiet" type="button" data-action="cancel-search">${t('loading.cancel')}</button>
  `;
  wrapper.querySelector('button[data-action=cancel-search]')!.addEventListener('click', () => {
    handlers.onCancelSearch();
  });
  const statusText = wrapper.querySelector('.loading-status-text')!;
  setTimeout(() => {
    // The wrapper is torn down (state resolved, failed, or cancelled) long
    // before most searches ever reach this delay — skip a pointless write
    // to a detached node rather than track a cancellation handle for it.
    // (Not `isConnected`: that's relative to `document`, and callers in
    // tests render into a container that's never attached to it.)
    if (!wrapper.parentElement) return;
    statusText.textContent = t('loading.longer');
  }, LONGER_THAN_USUAL_DELAY_MS);
  return wrapper;
}

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
  return parsed ? MONTH_ABBREVS[getLocale()][parsed.month - 1] : '?';
}

function dayNumber(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? String(parsed.day) : '?';
}

function formatIsoDate(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  const abbrev = MONTH_ABBREVS[getLocale()][parsed.month - 1];
  return getLocale() === 'de'
    ? `${parsed.day}. ${abbrev} ${parsed.year}`
    : `${abbrev} ${parsed.day}, ${parsed.year}`;
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
  const locale = getLocale() === 'de' ? 'de-DE' : 'en-US';
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderReview(
  state: { candidates: Array<{ id: string; label: string; startDate: string; endDate: string; sourceUrl: string; selected: boolean }>; selectedInterval: RecurrenceInterval; suggestedInterval: RecurrenceInterval | null },
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');
  const tiles = state.candidates
    .map(
      c => `
      <label class="day-tile ${c.selected ? 'day-tile-selected' : ''}" data-id="${c.id}">
        <input type="checkbox" ${c.selected ? 'checked' : ''} />
        <span class="day-tile-month">${monthAbbrev(c.startDate)}</span>
        <span class="day-tile-day">${dayNumber(c.startDate)}</span>
        <span class="day-tile-caption">${escapeHtml(formatRange(c.startDate, c.endDate))} · ${escapeHtml(c.label)}</span>
        <a class="day-tile-source" href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">${t('common.source')}</a>
      </label>`
    )
    .join('');
  wrapper.innerHTML = `
    <div class="tile-grid">${tiles}</div>
    <div class="interval-wrap review-interval">
      <label class="interval-label" for="review-interval">${t('review.checkAgain')}</label>
      ${renderIntervalSelect('reviewInterval', state.selectedInterval)}
      ${state.suggestedInterval ? `<span class="interval-hint">${t('review.aiSuggested', { interval: intervalLabel(state.suggestedInterval) })}</span>` : ''}
    </div>
    <p class="subtext">${t('review.subtext')}</p>
    <button class="stamp-button" type="button" data-action="approve">${t('review.approve', { count: state.candidates.filter(c => c.selected).length })}</button>
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
  wrapper.querySelector<HTMLSelectElement>('select[name=reviewInterval]')!.addEventListener('change', e => {
    const interval = (e.target as HTMLSelectElement).value as RecurrenceInterval;
    handlers.onSetReviewInterval(interval);
  });
  wrapper.querySelector('button[data-action=approve]')!.addEventListener('click', () => {
    handlers.onApprove();
  });
  return wrapper;
}

function renderFeedReady(icsUrl: string, rssUrl: string, handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <h2 class="dashboard-section-title">${t('feedReady.title')}</h2>
    <p class="subtext">${t('feedReady.subtext')}</p>
    ${renderFeedRow(t('common.calendarIcs'), icsUrl)}
    ${renderFeedRow(t('common.rss'), rssUrl)}
    <div class="edit-actions">
      <button class="stamp-button" type="button" data-action="dashboard">${t('feedReady.dashboard')}</button>
      <button class="stamp-button stamp-button-quiet" type="button" data-action="search-another">${t('feedReady.searchAnother')}</button>
    </div>
  `;
  wireCopyButtons(wrapper);
  wrapper.querySelector('button[data-action=dashboard]')!.addEventListener('click', () => {
    handlers.onGoToDashboard();
  });
  wrapper.querySelector('button[data-action=search-another]')!.addEventListener('click', () => {
    handlers.onStartOver();
  });
  return wrapper;
}

// One calendar feed row: label, the copyable URL, and a copy button.
function renderFeedRow(label: string, url: string): string {
  return `
    <div class="ledger-row">
      <span class="ledger-label">${label}</span>
      <span class="ledger-value-cell">
        <a class="ledger-value" href="${escapeHtml(url)}">${escapeHtml(url)}</a>
        <button type="button" class="copy-button" data-copy="${escapeHtml(url)}">${t('common.copy')}</button>
      </span>
    </div>
  `;
}

function wireCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.copy-button').forEach(button => {
    button.addEventListener('click', async () => {
      const url = button.dataset.copy;
      if (!url) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        }
        button.textContent = t('common.copied');
        setTimeout(() => {
          button.textContent = t('common.copy');
        }, 1500);
      } catch {
        // Clipboard unavailable — leave the URL selectable/copyable by hand.
      }
    });
  });
}

const INTERVAL_LABEL_KEYS: Record<RecurrenceInterval, MessageKey> = {
  weekly: 'interval.weekly',
  monthly: 'interval.monthly',
  quarterly: 'interval.quarterly',
  yearly: 'interval.yearly',
};

function intervalLabel(interval: RecurrenceInterval): string {
  return t(INTERVAL_LABEL_KEYS[interval]);
}

function renderIntervalSelect(
  name: string,
  selected: RecurrenceInterval
): string {
  const options = RECURRENCE_INTERVALS.map(
    interval => `<option value="${interval}" ${interval === selected ? 'selected' : ''}>${intervalLabel(interval)}</option>`
  ).join('');
  return `<select class="ruled-select" name="${name}" data-id="${name}">${options}</select>`;
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
      <label class="entry-label" for="dashboard-query-input">${t('empty.label')}</label>
      <input class="ruled-input" id="dashboard-query-input" name="query" placeholder="${t('empty.placeholder')}" required />
      <button class="stamp-button" type="submit">${t('empty.button')}</button>
    </form>

    ${queries.length > 0 ? `<section class="query-list" aria-label="${t('dashboard.savedQueries')}">${cards}</section>` : ''}

    <section class="feed-summary" aria-label="${t('dashboard.yourCalendar')}">
      <h2 class="dashboard-section-title">${t('dashboard.yourCalendar')}</h2>
      ${
        feed
          ? `
            ${renderFeedRow(t('common.calendarIcs'), feed.icsUrl)}
            ${renderFeedRow(t('common.rss'), feed.rssUrl)}
            <div class="ledger-row">
              <span class="ledger-label">${t('dashboard.lastSynced')}</span>
              <span class="ledger-value">${feed.lastFetchedAt ? escapeHtml(formatTimestamp(feed.lastFetchedAt)) : t('dashboard.never')}</span>
            </div>
            <button type="button" class="stamp-button stamp-button-quiet" data-action="rotate-feed">${t('dashboard.rotate')}</button>
            <p class="subtext">${t('dashboard.rotateSubtext')}</p>`
          : `<p class="subtext">${t('dashboard.noCalendar')}</p>`
      }
    </section>
    <div class="dashboard-footer">
      <button type="button" class="link-button" data-action="sign-out">${t('dashboard.signOut')}</button>
    </div>
  `;

  wrapper.querySelector<HTMLFormElement>('.dashboard-add')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('.dashboard-add input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  wireCopyButtons(wrapper);

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=edit]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onStartEdit(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=delete]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.confirmed !== 'true') {
        button.dataset.confirmed = 'true';
        button.textContent = t('queryCard.confirmDelete');
        return;
      }
      handlers.onDeleteQuery(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.feed-summary button[data-action=rotate-feed]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.confirmed !== 'true') {
        button.dataset.confirmed = 'true';
        button.textContent = t('dashboard.confirmRotate');
        return;
      }
      handlers.onRotateFeedToken();
    });
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=sign-out]')?.addEventListener('click', () => {
    handlers.onSignOut();
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
  if (query.approvedCount > 0) eventSummary.push(t('queryCard.approved', { count: query.approvedCount }));
  if (query.candidateCount > 0) eventSummary.push(t('queryCard.pending', { count: query.candidateCount }));
  return `
    <article class="query-card" data-id="${query.id}">
      <div class="query-card-head">
        <span class="query-card-text">${escapeHtml(query.text)}</span>
        <div class="query-card-actions">
          <button type="button" class="link-button" data-action="edit">${t('queryCard.edit')}</button>
          <button type="button" class="link-button link-button-danger" data-action="delete">${t('queryCard.delete')}</button>
        </div>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">${t('queryCard.reruns')}</span>
        <span class="ledger-value">${intervalLabel(query.recurrenceInterval)}</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">${t('queryCard.lastRun')}</span>
        <span class="ledger-value">${query.lastRunAt ? escapeHtml(formatTimestamp(query.lastRunAt)) : t('dashboard.never')}</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">${t('queryCard.events')}</span>
        <span class="ledger-value">${eventSummary.length > 0 ? escapeHtml(eventSummary.join(' · ')) : t('queryCard.noneYet')}</span>
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
        <label class="entry-label">${t('edit.events')}</label>
        <div class="tile-grid edit-tile-grid">${eventTiles}</div>
        <p class="subtext">${t('edit.saveHint', {
          summary: pending.length > 0
            ? `${t('queryCard.approved', { count: approved.length })} · ${t('queryCard.pending', { count: pending.length })}.`
            : '',
        })}</p>
      </div>`
    : `
      <p class="subtext">${t('edit.noEvents')}</p>`;

  return `
    <article class="query-card query-card-editing" data-id="${editing.queryId}">
      <form class="edit-form ruled-form">
        <label class="entry-label" for="edit-text">${t('edit.query')}</label>
        <input class="ruled-input" id="edit-text" name="editText" value="${escapeHtml(editing.text)}" required />
        <div class="interval-wrap">
          <label class="interval-label" for="edit-interval">${t('review.checkAgain')}</label>
          ${renderIntervalSelect('editInterval', editing.recurrenceInterval)}
        </div>
        ${eventsSection}
        <div class="edit-actions">
          <button class="stamp-button" type="submit" data-action="save">${t('edit.saveAndApprove', { count: selectedCount })}</button>
          <button class="stamp-button stamp-button-quiet" type="button" data-action="cancel">${t('edit.cancel')}</button>
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
      <a class="day-tile-source" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener">${t('common.source')}</a>
    </label>`;
}

function renderApprovedTile(event: EventDetail): string {
  return `
    <span class="day-tile day-tile-approved" data-id="${event.id}">
      <span class="day-tile-month">${monthAbbrev(event.startDate)}</span>
      <span class="day-tile-day">${dayNumber(event.startDate)}</span>
      <span class="day-tile-caption">${escapeHtml(formatRange(event.startDate, event.endDate))} · ${escapeHtml(event.label)} · ${t('common.approved')}</span>
    </span>`;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}