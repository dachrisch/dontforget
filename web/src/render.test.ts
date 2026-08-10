import { describe, it, expect, vi } from 'vitest';
import { renderWorkspace, type WorkspaceHandlers } from './render';

function noopHandlers(): WorkspaceHandlers {
  return {
    onRequestMagicLink: vi.fn(),
    onSubmitQuery: vi.fn(),
    onToggleCandidate: vi.fn(),
    onApprove: vi.fn(),
  };
}

describe('renderWorkspace', () => {
  it('renders the sign-in state and wires the magic-link handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'signedOut' }, handlers);

    expect(container.textContent).toContain('Sign in');
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
    expect(container.querySelector('.stamp-button')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!;
    expect(input.classList.contains('ruled-input')).toBe(true);
    input.value = 'a@example.com';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onRequestMagicLink).toHaveBeenCalledWith('a@example.com');
  });

  it('renders the link-sent confirmation', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'linkSent' }, noopHandlers());
    expect(container.textContent).toMatch(/check your inbox/i);
    expect(container.querySelector('.ornament')).not.toBeNull();
  });

  it('renders the empty workspace and submits a query on enter', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'empty' }, handlers);

    expect(container.querySelector('.stamp-button')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    expect(input.classList.contains('ruled-input')).toBe(true);
    input.value = 'Auer Dult Munich';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich');
  });

  it('prefills the query input when returning to empty after a failed search', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'empty', queryText: 'Auer Dult Munich' }, noopHandlers());

    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    expect(input.value).toBe('Auer Dult Munich');
  });

  it('renders the loading state with a torn-ticket chip and ticking indicator', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());
    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toMatch(/searching/i);
    expect(container.querySelector('.chip-torn')).not.toBeNull();
    expect(container.querySelectorAll('.tick')).toHaveLength(3);
  });

  it('renders candidates as calendar-day tiles and toggles selection on click', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e1',
            label: 'Frühjahrsdult',
            startDate: '2026-04-11',
            endDate: '2026-04-11',
            sourceUrl: 'u',
            status: 'candidate',
            selected: true,
          },
        ],
      },
      handlers
    );

    expect(container.textContent).toContain('Frühjahrsdult');
    expect(container.textContent).toContain('APR');
    expect(container.textContent).toContain('11');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-selected')).toBe(true);

    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    expect(handlers.onToggleCandidate).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve]')!.click();
    expect(handlers.onApprove).toHaveBeenCalled();
  });

  it('shows a date range and an unselected style when start and end differ', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e2',
            label: 'Oktoberfest',
            startDate: '2026-09-19',
            endDate: '2026-10-04',
            sourceUrl: 'u',
            status: 'candidate',
            selected: false,
          },
        ],
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('SEP 19, 2026–OCT 4, 2026');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-selected')).toBe(false);
  });

  it('only replays the enter animation on an actual state change, not a same-state re-render', () => {
    const container = document.createElement('div');
    const candidate = {
      id: 'e1',
      label: 'Frühjahrsdult',
      startDate: '2026-04-11',
      endDate: '2026-04-11',
      sourceUrl: 'u',
      status: 'candidate' as const,
      selected: true,
    };
    renderWorkspace(container, { kind: 'review', queryId: 'q1', candidates: [candidate] }, noopHandlers());
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);

    renderWorkspace(
      container,
      { kind: 'review', queryId: 'q1', candidates: [{ ...candidate, selected: false }] },
      noopHandlers()
    );
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(false);

    renderWorkspace(container, { kind: 'loading', queryText: 'x' }, noopHandlers());
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
  });

  it('falls back to the raw string for a malformed date instead of "undefined"', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e3',
            label: 'Mystery Fest',
            startDate: 'not-a-date',
            endDate: 'not-a-date',
            sourceUrl: 'u',
            status: 'candidate',
            selected: false,
          },
        ],
      },
      noopHandlers()
    );

    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).toContain('not-a-date');
    expect(container.querySelector('.day-tile-month')!.textContent).toBe('?');
    expect(container.querySelector('.day-tile-day')!.textContent).toBe('?');
  });

  it('renders the feed-ready state as ledger rows with both URLs', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'feedReady',
        icsUrl: 'https://x/f/t.ics',
        rssUrl: 'https://x/f/t.rss',
        approved: [],
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('https://x/f/t.ics');
    expect(container.textContent).toContain('https://x/f/t.rss');
    expect(container.querySelectorAll('.ledger-row')).toHaveLength(2);
  });
});