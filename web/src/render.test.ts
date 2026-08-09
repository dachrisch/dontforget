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
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!;
    input.value = 'a@example.com';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onRequestMagicLink).toHaveBeenCalledWith('a@example.com');
  });

  it('renders the link-sent confirmation', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'linkSent' }, noopHandlers());
    expect(container.textContent).toMatch(/check your inbox/i);
  });

  it('renders the empty workspace and submits a query on enter', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'empty' }, handlers);

    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    input.value = 'Auer Dult Munich';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich');
  });

  it('renders the loading state', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());
    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toMatch(/searching/i);
  });

  it('renders candidate rows and toggles on click', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate', selected: true },
        ],
      },
      handlers
    );

    expect(container.textContent).toContain('Frühjahrsdult');
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    expect(handlers.onToggleCandidate).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve]')!.click();
    expect(handlers.onApprove).toHaveBeenCalled();
  });

  it('renders the feed-ready state with both URLs', () => {
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
  });
});