import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDateline, renderMasthead, startWordmarkAnimation } from './masthead';

describe('formatDateline', () => {
  it('formats a date as "Weekday, D Month YYYY"', () => {
    expect(formatDateline(new Date(2026, 7, 9))).toBe('Sunday, 9 August 2026');
  });

  it('does not zero-pad the day number', () => {
    expect(formatDateline(new Date(2026, 0, 5))).toBe('Monday, 5 January 2026');
  });
});

describe('renderMasthead', () => {
  it('renders the wordmark and the given date', () => {
    const masthead = renderMasthead(new Date(2026, 7, 9));
    expect(masthead.classList.contains('masthead')).toBe(true);
    expect(masthead.textContent).toContain('Sunday, 9 August 2026');
  });

  it('renders "forget" as the base word with stem and sizer', () => {
    const masthead = renderMasthead();
    expect(masthead.querySelector('.wordmark-sizer')?.textContent).toBe('forget');
    expect(masthead.querySelector('.wordmark-stem')?.textContent).toBe("don't");
  });

  it('defaults to today when no date is passed', () => {
    const masthead = renderMasthead();
    expect(masthead.querySelector('.masthead-dateline')!.textContent).toMatch(/\d{4}$/);
  });
});

describe('startWordmarkAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('takes the stem out of flex flow (not just fades it) while the payoff word shows', async () => {
    document.body.innerHTML = '';
    document.body.appendChild(renderMasthead(new Date(2026, 7, 9)));
    startWordmarkAnimation();

    const stem = document.querySelector<HTMLElement>('.wordmark-stem')!;

    // Past the three struck-word cycles, into the payoff cycle.
    await vi.advanceTimersByTimeAsync(3 * (30 + 260 + 200 + 160 + 120));
    expect(stem.classList.contains('is-payoff-hidden')).toBe(true);

    // Past the payoff cycle, back to the settled base word.
    await vi.advanceTimersByTimeAsync(30 + 260 + 120);
    expect(stem.classList.contains('is-payoff-hidden')).toBe(false);
  });
});
