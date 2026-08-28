# Workspace Visual Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the currently-unstyled `dontforget` workspace UI (`web/`) a distinct paper-and-ink, almanac-inspired visual identity, without changing the state machine or backend.

**Architecture:** One new global stylesheet (`web/src/style.css`) built on CSS custom-property design tokens (with a `prefers-color-scheme: dark` override block), one new self-contained masthead component (`web/src/masthead.ts`), and targeted class-name/markup additions to each state renderer in the existing `web/src/render.ts`. The `review` state's candidate list is restructured from plain rows into a calendar-day-tile grid; every other state keeps its current DOM shape and just gains styling hooks.

**Tech Stack:** Vite + vanilla TypeScript (no framework), Vitest + jsdom for tests, plain CSS (no preprocessor, no CSS-in-JS, no new npm dependencies).

## Global Constraints

- No new runtime or dev npm dependencies — `web/package.json` stays as-is (spec: Implementation approach).
- The display font is self-hosted (`web/public/fonts/`) — no font CDN network dependency at runtime (spec: Implementation approach, Typography).
- Border radius is 2px maximum everywhere; no drop shadows except the single hairline panel border (spec: Shape & elevation).
- Dark mode is driven only by `prefers-color-scheme` — no user-facing theme toggle (spec: Dark mode).
- No new functionality beyond styling (e.g. no copy-to-clipboard button on feed URLs, no icon set) (spec: Out of scope).
- `web/src/state.ts`, `web/src/api.ts`, and the backend are not modified (spec: scope).
- `data-id` and `data-action` attributes on interactive elements must be preserved unchanged so handler-wiring tests keep passing (spec: Testing impact).

---

## Task 1: Design tokens, base stylesheet, self-hosted font, transition infrastructure

**Files:**
- Create: `web/public/fonts/playfair-display-700.woff2`
- Create: `web/src/style.css`
- Create: `web/src/style.test.ts`
- Modify: `web/src/main.ts:1` (add CSS import)
- Modify: `web/src/render.ts:10-17` (add transition class to rendered wrapper)
- Modify: `web/src/render.test.ts:14-25` (assert the transition class)

**Interfaces:**
- Produces: CSS custom properties `--paper`, `--paper-alt`, `--ink`, `--ink-muted`, `--rule`, `--accent`, `--font-display`, `--font-body`, `--radius` on `:root`, overridden under `@media (prefers-color-scheme: dark)`. CSS class `.workspace-enter` (fade/slide-in animation). Font family `'Playfair Display'` weight 700 available globally.
- Consumes: nothing (foundational task).

- [ ] **Step 1: Write the failing tests**

Create `web/src/style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf-8');

describe('style.css', () => {
  it('defines the light paper-and-ink token palette', () => {
    expect(css).toContain('--paper: #f7f3e9;');
    expect(css).toContain('--ink: #1f1b16;');
    expect(css).toContain('--accent: #a4302a;');
  });

  it('overrides tokens for dark mode', () => {
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toContain('--paper: #1c1a16;');
    expect(css).toContain('--accent: #d9714f;');
  });

  it('self-hosts the display font instead of loading it from a CDN', () => {
    expect(css).toContain('@font-face');
    expect(css).toContain('/fonts/playfair-display-700.woff2');
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('defines the shared state-transition animation', () => {
    expect(css).toMatch(/@keyframes\s+workspace-enter/);
    expect(css).toContain('.workspace-enter');
  });
});
```

Modify `web/src/render.test.ts` — add one assertion to the existing first test (do not otherwise change it):

```ts
  it('renders the sign-in state and wires the magic-link handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'signedOut' }, handlers);

    expect(container.textContent).toContain('Sign in');
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!;
    input.value = 'a@example.com';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onRequestMagicLink).toHaveBeenCalledWith('a@example.com');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test`
Expected: `style.test.ts` fails (file `./style.css` does not exist yet — `readFileSync` throws `ENOENT`); the modified `render.test.ts` test fails on the new `classList.contains('workspace-enter')` assertion (`false`).

- [ ] **Step 3: Download the self-hosted font**

```bash
cd web
mkdir -p public/fonts
curl -s -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" -o /tmp/playfair-display.css
FONT_URL=$(grep -B1 "unicode-range: U+0000-00FF," /tmp/playfair-display.css | grep -o "https://fonts.gstatic.com/[^)]*\.woff2")
curl -s -o public/fonts/playfair-display-700.woff2 "$FONT_URL"
file public/fonts/playfair-display-700.woff2
```

**Do not just take the first `@font-face` block in the response with `head -n1`** — Google's CSS2 endpoint returns one block per Unicode subset (cyrillic, vietnamese, latin-ext, latin, in that order for this family), and the first block is *not* Latin. Selecting the wrong subset silently produces a valid-looking woff2 file that contains zero Latin glyphs, so every element using the display font falls back to its fallback font with no visible error. You must select the block whose `unicode-range` starts with `U+0000-00FF` (the Latin subset) specifically, as the command above does.

Expected `file` output: `Web Open Font Format` (not `HTML document` — if it says HTML, the User-Agent didn't get a woff2 URL back; retry with a more recent Chrome UA string). Confirm the file is the Latin subset's size (~23KB for this family/weight, not ~12KB — a 12KB file here is the cyrillic subset, the wrong one).

- [ ] **Step 4: Create `web/src/style.css`**

```css
:root {
  --paper: #f7f3e9;
  --paper-alt: #efe8d8;
  --ink: #1f1b16;
  --ink-muted: #6b6255;
  --rule: #d8cfb8;
  --accent: #a4302a;

  --font-display: 'Playfair Display', Georgia, serif;
  --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

  --radius: 2px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1c1a16;
    --paper-alt: #262319;
    --ink: #ede6d3;
    --ink-muted: #a89e88;
    --rule: #3a352a;
    --accent: #d9714f;
  }
}

@font-face {
  font-family: 'Playfair Display';
  src: url('/fonts/playfair-display-700.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.5;
}

#root {
  max-width: 640px;
  margin: 2rem auto;
  padding: 2rem;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.error-banner {
  max-width: 640px;
  margin: 1rem auto 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 0.9rem;
}

h1, h2 {
  font-family: var(--font-display);
  font-weight: 700;
  margin: 0 0 0.5rem;
}

.subtext {
  color: var(--ink-muted);
}

@keyframes workspace-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.workspace-enter {
  animation: workspace-enter 150ms ease-out;
}
```

- [ ] **Step 5: Wire the stylesheet into the app**

In `web/src/main.ts`, add as the first line:

```ts
import './style.css';
```

- [ ] **Step 6: Add the transition class in the render dispatcher**

In `web/src/render.ts`, replace the `renderWorkspace` function (lines 10-17):

```ts
export function renderWorkspace(
  container: HTMLElement,
  state: WorkspaceState,
  handlers: WorkspaceHandlers
): void {
  container.innerHTML = '';
  const wrapper = render(state, handlers);
  wrapper.classList.add('workspace-enter');
  container.appendChild(wrapper);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS — all `style.test.ts` cases and the full `render.test.ts` suite.

- [ ] **Step 8: Commit**

```bash
git add web/public/fonts/playfair-display-700.woff2 web/src/style.css web/src/style.test.ts web/src/main.ts web/src/render.ts web/src/render.test.ts
git commit -m "feat(web): add paper-and-ink design tokens, self-hosted display font, transition class"
```

---

## Task 2: Masthead (wordmark, rule, dateline)

**Files:**
- Create: `web/src/masthead.ts`
- Create: `web/src/masthead.test.ts`
- Modify: `web/src/main.ts` (insert masthead before `root`)
- Modify: `web/src/style.css` (masthead styles)

**Interfaces:**
- Consumes: design tokens from Task 1 (`--font-display`, `--rule`, `--ink-muted`, etc.)
- Produces: `formatDateline(date: Date): string` and `renderMasthead(today?: Date): HTMLElement` exported from `web/src/masthead.ts`. Classes `.masthead`, `.masthead-title`, `.masthead-rule`, `.masthead-dateline`.

- [ ] **Step 1: Write the failing test**

Create `web/src/masthead.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatDateline, renderMasthead } from './masthead';

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
    expect(masthead.textContent).toContain('dontforget');
    expect(masthead.textContent).toContain('Sunday, 9 August 2026');
  });

  it('defaults to today when no date is passed', () => {
    const masthead = renderMasthead();
    expect(masthead.querySelector('.masthead-dateline')!.textContent).toMatch(/\d{4}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- masthead`
Expected: FAIL — `./masthead` module not found.

- [ ] **Step 3: Create `web/src/masthead.ts`**

```ts
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDateline(date: Date): string {
  const day = DAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[date.getMonth()];
  return `${day}, ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function renderMasthead(today: Date = new Date()): HTMLElement {
  const masthead = document.createElement('header');
  masthead.className = 'masthead';
  masthead.innerHTML = `
    <h1 class="masthead-title">dontforget</h1>
    <div class="masthead-rule"></div>
    <p class="masthead-dateline">${formatDateline(today)}</p>
  `;
  return masthead;
}
```

- [ ] **Step 4: Wire it into `main.ts`**

In `web/src/main.ts`, add the import at the top (after the `style.css` import) and insert the masthead before the existing `errorBanner` insertion:

```ts
import './style.css';
import { reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import { requestMagicLink, checkSession, submitQuery, approveEvents } from './api';
import { renderMasthead } from './masthead';

const root = document.getElementById('root')!;
root.before(renderMasthead());

const errorBanner = document.createElement('p');
errorBanner.className = 'error-banner';
errorBanner.hidden = true;
root.before(errorBanner);
```

(`root.before(...)` always inserts immediately before `root` itself, so calling it for the masthead first and the error banner second produces the order: masthead, error banner, root — exactly the intended layout.)

- [ ] **Step 5: Add masthead styles**

Append to `web/src/style.css`:

```css
.masthead {
  max-width: 640px;
  margin: 2rem auto 0;
  padding: 0 2rem;
  text-align: center;
}

.masthead-title {
  font-size: 2rem;
  letter-spacing: 0.02em;
}

.masthead-rule {
  height: 4px;
  margin: 0.5rem 0;
  border-top: 3px solid var(--ink);
  border-bottom: 1px solid var(--ink);
}

.masthead-dateline {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS — full suite including `masthead.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add web/src/masthead.ts web/src/masthead.test.ts web/src/main.ts web/src/style.css
git commit -m "feat(web): add newspaper-style masthead with live dateline"
```

---

## Task 3: Sign-in, link-sent, and empty-search states

**Files:**
- Modify: `web/src/render.ts:36-74` (`renderSignedOut`, `renderLinkSent`, `renderEmpty`)
- Modify: `web/src/render.test.ts` (extend the sign-in, link-sent, and empty tests)
- Modify: `web/src/style.css` (ruled-input, stamp-button, ornament styles)

**Interfaces:**
- Consumes: design tokens from Task 1.
- Produces: CSS classes `.ruled-form`, `.ruled-input`, `.stamp-button`, `.entry-label`, `.ornament` for reuse by later tasks (loading and review states reuse `.stamp-button`).

- [ ] **Step 1: Write the failing tests**

In `web/src/render.test.ts`, extend the existing three tests (sign-in, link-sent, empty) with class assertions — replace them with:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test`
Expected: FAIL — the three new class-presence assertions fail (`.stamp-button` / `.ruled-input` / `.ornament` don't exist yet).

- [ ] **Step 3: Update the three render functions**

In `web/src/render.ts`, replace `renderSignedOut`, `renderLinkSent`, and `renderEmpty` (lines 36-74):

```ts
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

function renderEmpty(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="ruled-form">
      <label class="entry-label" for="query-input">What do you want to track?</label>
      <input class="ruled-input" id="query-input" name="query" placeholder="e.g. Auer Dult Munich" required />
      <button class="stamp-button" type="submit">Search</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  return wrapper;
}
```

- [ ] **Step 4: Add the shared styles**

Append to `web/src/style.css`:

```css
.ruled-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1rem;
}

.entry-label {
  font-family: var(--font-display);
  font-size: 1.1rem;
}

.ruled-input {
  border: none;
  border-bottom: 1px solid var(--rule);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 1rem;
  padding: 0.5rem 0.25rem;
  outline: none;
}

.ruled-input:focus {
  border-bottom-color: var(--accent);
}

.stamp-button {
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  color: var(--accent);
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
  transition: transform 100ms ease;
}

.stamp-button:active {
  transform: scale(0.97);
}

.ornament {
  font-size: 1.5rem;
  color: var(--accent);
  margin: 0 0 0.5rem;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS — full suite.

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts web/src/style.css
git commit -m "feat(web): style sign-in, link-sent, and search entry states"
```

---

## Task 4: Loading state (torn ticket + ticking indicator)

**Files:**
- Modify: `web/src/render.ts` (`renderLoading`)
- Modify: `web/src/render.test.ts` (extend the loading test)
- Modify: `web/src/style.css` (chip, ticks, keyframes)

**Interfaces:**
- Consumes: `.subtext`, tokens from Task 1.
- Produces: classes `.chip-torn`, `.loading-status`, `.ticks`, `.tick`; keyframe `tick-pulse`.

- [ ] **Step 1: Write the failing test**

Replace the loading test in `web/src/render.test.ts`:

```ts
  it('renders the loading state with a torn-ticket chip and ticking indicator', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());
    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toMatch(/searching/i);
    expect(container.querySelector('.chip-torn')).not.toBeNull();
    expect(container.querySelectorAll('.tick')).toHaveLength(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- render`
Expected: FAIL — `.chip-torn` and `.tick` don't exist yet (`querySelectorAll('.tick')` returns length 0).

- [ ] **Step 3: Update `renderLoading`**

In `web/src/render.ts`, replace the `renderLoading` function:

```ts
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
```

- [ ] **Step 4: Add styles**

Append to `web/src/style.css`:

```css
.chip-torn {
  display: inline-block;
  border: 1px dashed var(--rule);
  border-radius: var(--radius);
  padding: 0.25rem 0.6rem;
  font-size: 0.85rem;
  color: var(--ink-muted);
}

.loading-status {
  margin-top: 1rem;
  color: var(--ink-muted);
}

.ticks {
  display: inline-flex;
  gap: 0.3rem;
  margin-left: 0.4rem;
  vertical-align: middle;
}

.tick {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rule);
  animation: tick-pulse 1.2s ease-in-out infinite;
}

.tick:nth-child(2) {
  animation-delay: 0.2s;
}

.tick:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes tick-pulse {
  0%, 80%, 100% {
    background: var(--rule);
  }
  40% {
    background: var(--accent);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts web/src/style.css
git commit -m "feat(web): style loading state with torn-ticket chip and ticking indicator"
```

---

## Task 5: Review state — calendar-day tiles

**Files:**
- Modify: `web/src/render.ts:85-114` (`renderReview`, plus new private helpers)
- Modify: `web/src/render.test.ts` (replace the review test, add a range-formatting case)
- Modify: `web/src/style.css` (tile grid)

**Interfaces:**
- Consumes: `.stamp-button`, tokens from Task 1. `CandidateEvent` shape from `web/src/types.ts` (`startDate`/`endDate` are `YYYY-MM-DD` strings).
- Produces: classes `.tile-grid`, `.day-tile`, `.day-tile-selected`, `.day-tile-month`, `.day-tile-day`, `.day-tile-caption`, `.day-tile-source`. Private helpers `parseIsoDate`, `monthAbbrev`, `dayNumber`, `formatIsoDate`, `formatRange` in `render.ts` (not exported — covered via rendered-output assertions, consistent with this file's existing test style).

- [ ] **Step 1: Write the failing tests**

Replace the review test in `web/src/render.test.ts` and add a second one for ranges:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- render`
Expected: FAIL — `.day-tile` / `.day-tile-selected` don't exist, and the month-abbreviation/range text isn't rendered yet.

- [ ] **Step 3: Update `renderReview`**

In `web/src/render.ts`, replace `renderReview` (lines 85-114) and add the helper functions immediately above it:

```ts
const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function monthAbbrev(iso: string): string {
  return MONTH_ABBREVS[parseIsoDate(iso).month - 1];
}

function dayNumber(iso: string): string {
  return String(parseIsoDate(iso).day);
}

function formatIsoDate(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return `${MONTH_ABBREVS[month - 1]} ${day}, ${year}`;
}

function formatRange(startDate: string, endDate: string): string {
  if (startDate === endDate) return formatIsoDate(startDate);
  return `${formatIsoDate(startDate)}–${formatIsoDate(endDate)}`;
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
```

(The `.day-tile-source` click listener stops propagation so clicking "source" follows the link without also toggling the tile's selection — the `<label>` wrapping the checkbox would otherwise forward that click as a toggle too.)

- [ ] **Step 4: Add tile-grid styles**

Append to `web/src/style.css`:

```css
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}

.day-tile {
  display: block;
  position: relative;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-alt);
  padding: 0.5rem;
  cursor: pointer;
  color: var(--ink-muted);
  transition: border-color 100ms ease, background-color 100ms ease, color 100ms ease;
}

.day-tile-selected {
  border: 2px solid var(--accent);
  background: var(--paper);
  color: var(--ink);
}

.day-tile input[type='checkbox'] {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.day-tile-month {
  display: block;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  color: var(--accent);
  text-transform: uppercase;
}

.day-tile-day {
  display: block;
  font-family: var(--font-display);
  font-size: 1.75rem;
  line-height: 1.1;
}

.day-tile-caption {
  display: block;
  font-size: 0.75rem;
  margin-top: 0.25rem;
}

.day-tile-source {
  display: block;
  font-size: 0.7rem;
  margin-top: 0.25rem;
  color: var(--ink-muted);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS — full suite.

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts web/src/style.css
git commit -m "feat(web): render review candidates as calendar-day tiles"
```

---

## Task 6: Feed-ready state (ledger rows)

**Files:**
- Modify: `web/src/render.ts:116-124` (`renderFeedReady`)
- Modify: `web/src/render.test.ts` (extend the feed-ready test)
- Modify: `web/src/style.css` (ledger row styles)

**Interfaces:**
- Consumes: `.subtext`, tokens from Task 1.
- Produces: classes `.ledger-row`, `.ledger-label`, `.ledger-value`.

- [ ] **Step 1: Write the failing test**

Replace the feed-ready test in `web/src/render.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- render`
Expected: FAIL — `.ledger-row` doesn't exist (`querySelectorAll` returns length 0).

- [ ] **Step 3: Update `renderFeedReady`**

In `web/src/render.ts`, replace the `renderFeedReady` function (lines 116-124):

```ts
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
```

- [ ] **Step 4: Add ledger-row styles**

Append to `web/src/style.css`:

```css
.ledger-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--rule);
  font-size: 0.85rem;
}

.ledger-row:last-child {
  border-bottom: none;
}

.ledger-label {
  color: var(--ink-muted);
  white-space: nowrap;
}

.ledger-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
  text-align: right;
  color: var(--ink);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS — full suite (all tasks combined).

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts web/src/style.css
git commit -m "feat(web): style feed-ready state as ledger rows"
```

---

## Task 7: Manual visual verification (light and dark)

**Files:** none — verification only, no code changes.

**Interfaces:** none.

- [ ] **Step 1: Start the dev database**

```bash
cd dontforget
./scripts/spinup_dev_db.sh
```

Capture the printed IP.

- [ ] **Step 2: Export environment and start the backend**

```bash
export DATABASE_URL="mongodb://<IP-from-step-1>:27019/dontforget"
export PUBLIC_BASE_URL="http://localhost:3000"
export SEARXNG_BASE_URL="https://search.lehel.xyz"
export SEARXNG_TOKEN="<from container repo's ansible/plays/vars/secrets.yml, vault_searxng_brave_token>"
export OPENCODE_BASE_URL="https://code.lehel.xyz"
export OPENCODE_API_KEY="<from container repo's ansible/plays/vars/secrets.yml, opencode.api_key>"
npm run dev
```

- [ ] **Step 3: Start the frontend dev server (second terminal)**

```bash
cd dontforget/web
npm run dev
```

Open the printed Vite URL (typically `http://localhost:5173`) in Chrome.

- [ ] **Step 4: Verify the sign-in flow visually**

Confirm: masthead wordmark + double rule + today's dateline appear above the panel; the sign-in panel shows the paper/ink palette, serif "Sign in" headline, ruled email input, and stamp-style button. Submit the form, copy the `/api/auth/callback?token=...` URL printed in the backend terminal into the browser to sign in, and confirm the link-sent state showed the `※` ornament first.

- [ ] **Step 5: Verify search, loading, and review states**

In the empty-search state, confirm the ruled input and stamp button match Step 4's styling. Submit a real query (e.g. "Auer Dult Munich"). Confirm the loading state shows the torn-edge chip and the three ticks animating in sequence. Once results return, confirm the review grid shows calendar-day tiles with correct month/day/caption, that clicking a tile toggles its selected styling, and that clicking "source" navigates without also toggling the tile.

- [ ] **Step 6: Verify feed-ready state**

Approve one or more candidates and confirm the two ledger rows (Calendar/RSS) render with the hairline divider and monospace URLs.

- [ ] **Step 7: Verify dark mode**

In Chrome DevTools, open the Rendering tab (Cmd/Ctrl+Shift+P → "Show Rendering") and set "Emulate CSS media feature prefers-color-scheme" to `dark`. Reload and repeat Steps 4-6 briefly, confirming the dark palette (`--paper: #1c1a16` etc.) applies consistently with no unreadable contrast anywhere.

- [ ] **Step 8: Record and fix any issues found**

If anything looks wrong, fix it in the relevant task's files, re-run that task's automated tests, and re-verify visually before considering the feature complete.
