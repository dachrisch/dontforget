import type { AdminState, WorkspaceState, SelectableEditEvent, ReviewingDraft, EditingDraft } from './state';
import { RECURRENCE_INTERVALS } from './types';
import type { EventDetail, FeedSummary, QuerySummary, RecurrenceInterval, BillingStatus } from './types';
import { getLocale, MONTH_ABBREVS, t, type MessageKey } from './i18n';

export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string) => void;
  onStartEdit: (queryId: string) => void;
  onToggleEditEvent: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (queryId: string, patch: { text: string; recurrenceInterval: RecurrenceInterval }) => void;
  onDeleteQuery: (queryId: string) => void;
  onRotateFeedToken: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
  onStartReview: (queryId: string) => void;
  onToggleReviewEvent: (id: string) => void;
  onSetReviewInterval: (interval: RecurrenceInterval) => void;
  onApproveReview: (queryId: string) => void;
  onCancelReview: () => void;
  onRetrySearch: (queryId: string) => void;
  onCloseAdmin: () => void;
  onDeleteAdminUser: (userId: string) => void;
  onUpgrade: () => void;
  onManageBilling: () => void;
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
  // state (e.g. toggling one tile in a review card) must not replay the
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
      return renderEmpty(handlers);
    case 'dashboard':
      return renderDashboard(state.queries, state.feed, state.editing, state.reviewing, state.billing, handlers);
    case 'admin':
      return renderAdmin(state, handlers);
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

function renderEmpty(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="ruled-form">
      <label class="entry-label" for="query-input">${t('empty.label')}</label>
      <input class="ruled-input" id="query-input" name="query" placeholder="${t('empty.placeholder')}" required />
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

// One calendar feed row: label, and the feed's actions. The ICS row leads
// with big "add to" buttons per calendar app and tucks the download and
// copy away as small icons; the RSS row offers a small open-feed link and
// copy. The raw URL is deliberately hidden — copy hands it to the
// clipboard.
function renderFeedRow(label: string, url: string, kind: 'ics' | 'rss'): string {
  const addButtons = kind === 'ics'
    ? `
    <div class="feed-add-buttons">
      ${CALENDAR_PROVIDERS.map(provider => {
        const name = t(provider.labelKey);
        const labelText = t('calendarAdd.aria', { name });
        return `
        <a class="feed-add-button" href="${escapeHtml(provider.href(url))}" target="_blank" rel="noopener" title="${escapeHtml(labelText)}" aria-label="${escapeHtml(labelText)}">
          <img class="feed-add-brand" src="${provider.icon}" alt="" aria-hidden="true" />
          ${escapeHtml(name)}
        </a>`;
      }).join('')}
    </div>`
    : '';

  const smallAction = kind === 'ics'
    ? `<a class="feed-action" href="${escapeHtml(url)}" download title="${escapeHtml(t('calendarAction.download'))}" aria-label="${escapeHtml(t('calendarAction.download'))}">${DOWNLOAD_ICON}</a>`
    : `<a class="feed-action" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(t('calendarAction.openRss'))}" aria-label="${escapeHtml(t('calendarAction.openRss'))}">${RSS_ICON}</a>`;

  return `
    <div class="ledger-row">
      <span class="ledger-label">${label}</span>
      <span class="ledger-value-cell">
        ${smallAction}
        <button type="button" class="feed-action copy-button" data-copy="${escapeHtml(url)}" title="${escapeHtml(t('common.copy'))}" aria-label="${escapeHtml(t('common.copy'))}">${COPY_ICON}</button>
      </span>
    </div>${addButtons}
  `;
}

function renderBillingRow(billing: BillingStatus | null, handlers: WorkspaceHandlers): string {
  if (!billing) return '';
  if (billing.subscribed) {
    return `<p class="subtext">${t('billing.subscribed', { count: billing.activeQueryCount })}</p>
      <button type="button" class="stamp-button stamp-button-quiet" data-action="manage-billing">${t('billing.manage')}</button>`;
  }
  return `<p class="subtext">${t('billing.freeLimit', {
    count: billing.freeLimit - billing.activeQueryCount,
  })} · ${t('billing.perQuery', { price: billing.pricePerExtraQuery })}</p>
    <button type="button" class="stamp-button stamp-button-quiet" data-action="upgrade">${t('billing.upgrade')}</button>`;
}

// Monochrome line icons for the action buttons. They inherit the button
// color via `currentColor`, so the hover state just changes the text color.
const COPY_ICON = `<svg class="feed-action-icon icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
const CHECK_ICON = `<svg class="feed-action-icon icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>`;
const DOWNLOAD_ICON = `<svg class="feed-action-icon icon-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="M6 9l6 6 6-6"/><path d="M4 20h16"/></svg>`;
const RSS_ICON = `<svg class="feed-action-icon icon-rss" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>`;

// Calendar apps subscribe to the ICS feed over the `webcal://` scheme; the
// endpoint itself is plain HTTP, so this is just an alias for https.
function webcalUrl(url: string): string {
  return url.replace(/^https?:\/\//i, 'webcal://');
}

// Google's "add calendar" flow accepts the subscription URL in `cid`.
function googleCalendarUrl(icsUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(icsUrl))}`;
}

// Outlook's add-from-web page subscribes to the URL in `url`. `.live.com`
// covers personal accounts; `outlook.office.com` is for work/school.
function outlookCalendarUrl(icsUrl: string): string {
  return `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(webcalUrl(icsUrl))}`;
}

// Apple Calendar has no deep link to subscribe programmatically — pointing
// at the `webcal://` URL opens its "Add subscription" confirmation, so that
// URL is used verbatim.
const CALENDAR_PROVIDERS: Array<{
  icon: string;
  labelKey: MessageKey;
  href: (url: string) => string;
}> = [
  { icon: '/icons/google-calendar.svg', labelKey: 'calendarAdd.google', href: googleCalendarUrl },
  { icon: '/icons/apple-calendar.svg', labelKey: 'calendarAdd.apple', href: webcalUrl },
  { icon: '/icons/outlook.svg', labelKey: 'calendarAdd.outlook', href: outlookCalendarUrl },
];

function wireCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.copy-button').forEach(button => {
    button.addEventListener('click', async () => {
      const url = button.dataset.copy;
      if (!url) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        }
        button.innerHTML = CHECK_ICON;
        setTimeout(() => {
          button.innerHTML = COPY_ICON;
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

// A search that hits opencode retry/fallback (see opencodeClient.ts) can
// run well past a normal search's ~30-45s — confirmed against production
// logs on 2026-08-17. Reassure the user instead of leaving a static status
// that starts to look stuck.
const LONGER_THAN_USUAL_DELAY_MS = 60_000;

function renderDashboard(
  queries: QuerySummary[],
  feed: FeedSummary | null,
  editing: EditingDraft | null,
  reviewing: ReviewingDraft | null,
  billing: BillingStatus | null,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');

  const cards = queries
    .map(query => {
      const isEditing = editing?.queryId === query.id;
      const isReviewing = reviewing?.queryId === query.id;
      if (isEditing) return renderEditCard(editing);
      if (isReviewing) return renderReviewCard(reviewing);
      return renderQueryCard(query);
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
            ${renderFeedRow(t('common.calendarIcs'), feed.icsUrl, 'ics')}
            ${renderFeedRow(t('common.rss'), feed.rssUrl, 'rss')}
            <div class="ledger-row">
              <span class="ledger-label">${t('dashboard.lastSynced')}</span>
              <span class="ledger-value">${feed.lastFetchedAt ? escapeHtml(formatTimestamp(feed.lastFetchedAt)) : t('dashboard.never')}</span>
            </div>
            <button type="button" class="stamp-button stamp-button-quiet" data-action="rotate-feed">${t('dashboard.rotate')}</button>
            <p class="subtext">${t('dashboard.rotateSubtext')}</p>`
          : `<p class="subtext">${t('dashboard.noCalendar')}</p>`
      }
    </section>
    <section class="billing-summary" aria-label="${t('billing.title')}">
      ${renderBillingRow(billing, handlers)}
    </section>
    <div class="dashboard-footer">
      <button type="button" class="link-button link-button-danger" data-action="delete-account">${t('dashboard.deleteAccount')}</button>
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

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=review]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onStartReview(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=retry]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onRetrySearch(button.closest<HTMLElement>('.query-card')!.dataset.id!);
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

  wrapper.querySelector<HTMLButtonElement>('button[data-action=delete-account]')?.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.dataset.confirmed !== 'true') {
      button.dataset.confirmed = 'true';
      button.textContent = t('dashboard.confirmDeleteAccount');
      return;
    }
    handlers.onDeleteAccount();
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=upgrade]')?.addEventListener('click', () => {
    handlers.onUpgrade();
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=manage-billing]')?.addEventListener('click', () => {
    handlers.onManageBilling();
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

  wrapper.querySelectorAll<HTMLInputElement>('.query-card-reviewing .day-tile input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('click', () => {
      const id = checkbox.closest<HTMLElement>('.day-tile')!.dataset.id!;
      handlers.onToggleReviewEvent(id);
    });
  });

  wrapper.querySelectorAll<HTMLAnchorElement>('.query-card-reviewing .day-tile-source').forEach(a => {
    a.addEventListener('click', e => e.stopPropagation());
  });

  wrapper.querySelectorAll<HTMLSelectElement>('.query-card-reviewing select[name=reviewInterval]').forEach(select => {
    select.addEventListener('change', e => {
      const interval = (e.target as HTMLSelectElement).value as RecurrenceInterval;
      handlers.onSetReviewInterval(interval);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card-reviewing button[data-action=approve-review]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onApproveReview(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card-reviewing button[data-action=cancel-review]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onCancelReview();
    });
  });

  // A search that runs long gets a reassurance once it crosses the "longer
  // than usual" threshold. The wrapper reference doubles as the liveness
  // check: after the next poll re-renders, this wrapper is detached from the
  // container and the write is skipped.
  const runningStatusTexts = wrapper.querySelectorAll<HTMLElement>('.query-card-running .query-card-status-text');
  if (runningStatusTexts.length > 0) {
    setTimeout(() => {
      if (!wrapper.parentElement) return;
      runningStatusTexts.forEach(el => {
        el.textContent = t('queryCard.searchingLong');
      });
    }, LONGER_THAN_USUAL_DELAY_MS);
  }

  return wrapper;
}

function renderAdmin(state: AdminState, handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  const stats = state.stats;
  const statsCards = stats
    ? `
    <div class="admin-stats">
      <div class="admin-stat">
        <span class="admin-stat-value">${stats.totalUsers}</span>
        <span class="admin-stat-label">${t('admin.statsUsers')}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-value">${stats.totalQueries}</span>
        <span class="admin-stat-label">${t('admin.statsQueries')}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-value">${stats.approvedEvents}</span>
        <span class="admin-stat-label">${t('admin.statsApproved')}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-value">${stats.activeUsers7d}</span>
        <span class="admin-stat-label">${t('admin.statsActive')}</span>
      </div>
    </div>`
    : `<p class="subtext">${t('admin.loading')}</p>`;

  const userRows = state.users
    .map(
      user => `
    <div class="admin-user-row" data-id="${user.id}">
      <span class="ledger-label">${escapeHtml(user.email)}</span>
      <span class="ledger-value">${escapeHtml(user.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleUser'))}</span>
      <span class="ledger-value">${user.queryCount}</span>
      <button type="button" class="link-button link-button-danger" data-action="delete-user">${t('admin.deleteUser')}</button>
    </div>`
    )
    .join('');

  wrapper.innerHTML = `
    <h1>${t('admin.title')}</h1>
    ${statsCards}
    <section class="admin-users" aria-label="${t('admin.users')}">
      <div class="admin-user-row admin-user-head" aria-hidden="true">
        <span class="ledger-label">${t('admin.email')}</span>
        <span class="ledger-value">${t('admin.role')}</span>
        <span class="ledger-value">${t('admin.queries')}</span>
        <span></span>
      </div>
      ${userRows.length > 0 ? userRows : `<p class="subtext">${t('admin.noUsers')}</p>`}
    </section>
    <div class="dashboard-footer">
      <button type="button" class="link-button" data-action="close-admin">${t('admin.back')}</button>
      <button type="button" class="link-button" data-action="sign-out">${t('dashboard.signOut')}</button>
    </div>
  `;

  wrapper.querySelectorAll<HTMLButtonElement>('button[data-action=delete-user]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.confirmed !== 'true') {
        button.dataset.confirmed = 'true';
        button.textContent = t('admin.confirmDeleteUser');
        return;
      }
      const id = button.closest<HTMLElement>('.admin-user-row')!.dataset.id!;
      handlers.onDeleteAdminUser(id);
    });
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=close-admin]')?.addEventListener('click', () => {
    handlers.onCloseAdmin();
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=sign-out]')?.addEventListener('click', () => {
    handlers.onSignOut();
  });

  return wrapper;
}

function renderQueryCard(query: QuerySummary): string {
  if (query.status === 'running') {
    return `
      <article class="query-card query-card-running" data-id="${query.id}">
        <div class="query-card-head">
          <span class="query-card-text">${escapeHtml(query.text)}</span>
          <div class="query-card-actions">
            <button type="button" class="link-button" data-action="edit">${t('queryCard.edit')}</button>
            <button type="button" class="link-button link-button-danger" data-action="delete">${t('queryCard.delete')}</button>
          </div>
        </div>
        <p class="loading-status query-card-status">
          <span class="query-card-status-text">${t('queryCard.searching')}</span>
          <span class="ticks">
            <span class="tick"></span>
            <span class="tick"></span>
            <span class="tick"></span>
          </span>
        </p>
      </article>
    `;
  }

  if (query.status === 'failed') {
    return `
      <article class="query-card query-card-failed" data-id="${query.id}">
        <div class="query-card-head">
          <span class="query-card-text">${escapeHtml(query.text)}</span>
          <div class="query-card-actions">
            <button type="button" class="link-button" data-action="edit">${t('queryCard.edit')}</button>
            <button type="button" class="link-button link-button-danger" data-action="delete">${t('queryCard.delete')}</button>
          </div>
        </div>
        <p class="subtext">${t('queryCard.failed')}</p>
        <button class="stamp-button stamp-button-quiet" type="button" data-action="retry">${t('queryCard.retry')}</button>
      </article>
    `;
  }

  const eventSummary = [];
  if (query.approvedCount > 0) eventSummary.push(t('queryCard.approved', { count: query.approvedCount }));
  if (query.candidateCount > 0) eventSummary.push(t('queryCard.pending', { count: query.candidateCount }));
  const reviewAction = query.candidateCount > 0
    ? `<button type="button" class="link-button" data-action="review">${t('queryCard.review')}</button>`
    : '';
  return `
    <article class="query-card" data-id="${query.id}">
      <div class="query-card-head">
        <span class="query-card-text">${escapeHtml(query.text)}</span>
        <div class="query-card-actions">
          ${reviewAction}
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

function renderReviewCard(reviewing: ReviewingDraft): string {
  // reviewing.events is guaranteed candidate-only by the reducer's
  // REVIEW_EVENTS_LOADED case — no approved/dismissed bucket to split out.
  const selectedCount = reviewing.events.filter(e => e.decision === 'approve').length;

  const eventTiles = reviewing.events.map(e => renderSelectableTile(e)).join('');

  const eventsSection = reviewing.events.length > 0
    ? `
      <div class="edit-events">
        <label class="entry-label">${t('edit.events')}</label>
        <div class="tile-grid edit-tile-grid">${eventTiles}</div>
      </div>`
    : `<p class="subtext">${t('edit.noEvents')}</p>`;

  return `
    <article class="query-card query-card-reviewing" data-id="${reviewing.queryId}">
      <div class="interval-wrap review-interval">
        <label class="interval-label" for="review-interval">${t('review.checkAgain')}</label>
        ${renderIntervalSelect('reviewInterval', reviewing.recurrenceInterval)}
      </div>
      ${eventsSection}
      <p class="subtext">${t('review.subtext')}</p>
      <div class="edit-actions">
        <button class="stamp-button" type="button" data-action="approve-review">${t('review.approve', { count: selectedCount })}</button>
        <button class="stamp-button stamp-button-quiet" type="button" data-action="cancel-review">${t('review.notNow')}</button>
      </div>
    </article>
  `;
}

function renderEditCard(
  editing: EditingDraft
): string {
  const approved = editing.events.filter(e => e.status === 'approved');
  const pending = editing.events.filter(e => e.status === 'candidate');
  const selectedCount = pending.filter(e => e.decision === 'approve').length;

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
  const stateClass =
    event.decision === 'approve' ? 'day-tile-decision-approve' :
    event.decision === 'dismiss' ? 'day-tile-decision-dismiss' : '';
  const decisionLabel =
    event.decision === 'approve' ? t('edit.decisionApprove') :
    event.decision === 'dismiss' ? t('edit.decisionDismiss') : '';
  return `
    <label class="day-tile ${stateClass}" data-id="${event.id}">
      <input type="checkbox" ${event.decision === 'approve' ? 'checked' : ''} />
      <span class="day-tile-month">${monthAbbrev(event.startDate)}</span>
      <span class="day-tile-day">${dayNumber(event.startDate)}</span>
      <span class="day-tile-caption">${escapeHtml(formatRange(event.startDate, event.endDate))} · ${escapeHtml(event.label)}</span>
      ${decisionLabel ? `<span class="day-tile-decision-label">${decisionLabel}</span>` : ''}
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