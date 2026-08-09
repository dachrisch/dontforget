# dontforget — Workspace Visual Design

> Status: approved 2026-08-09 (design collaboration, this session).
> Scope: visual styling of the existing single-page "workspace" chat UI
> (`web/`), plus minor layout changes within states. Does not change the
> state machine (`web/src/state.ts`) or the backend. See
> `docs/design.md` §3 for the original "one input box plus a results
> list" framing this design stays inside.

## Problem

`web/` has no CSS at all today — every one of the 6 workspace states
(`signedOut`, `linkSent`, `empty`, `loading`, `review`, `feedReady`)
renders as unstyled HTML. The app needs a distinct, considered visual
identity rather than default browser styling, without turning into a
generic SaaS look.

## Direction: paper & ink, almanac-inspired

`dontforget`'s domain is dates and recurrence — events that happen again
but never on a fixed schedule. The visual identity leans directly into
that: a printed almanac/ledger page, not app chrome. This shows up as:
a newspaper-style masthead with a live dateline, ruled-paper inputs
instead of boxed ones, ink-stamp-style buttons, ledger rows for lists,
and — the signature element — search results (found event dates)
rendered as calendar-day tiles rather than a plain list.

## Implementation approach

Single new file `web/src/style.css`, imported once from `web/src/main.ts`.
All colors/spacing/type expressed as CSS custom properties (design
tokens) on `:root`, with a `prefers-color-scheme: dark` block overriding
the token values — no separate dark-mode component logic. No new
dependencies: `web/package.json` currently has zero runtime deps and
stays that way. One self-hosted display font (below) instead of a CDN
font, so rendering never depends on an external network call.

Markup changes are confined to `web/src/render.ts` (class names,
restructured `review` state markup for the tile grid) and
`web/src/render.test.ts` (assertions updated to match — see Testing
Impact below). `web/src/state.ts`, `web/src/api.ts`, and the backend are
untouched.

## Design tokens

### Palette — paper & ink

Light (default):

| Token | Value | Role |
|---|---|---|
| `--paper` | `#f7f3e9` | page background |
| `--paper-alt` | `#efe8d8` | tiles, cards, alternating rows |
| `--ink` | `#1f1b16` | primary text |
| `--ink-muted` | `#6b6255` | secondary text, captions, dateline |
| `--rule` | `#d8cfb8` | hairline dividers, borders |
| `--accent` | `#a4302a` | selection, focus, buttons, dateline accents — used sparingly |

Dark (`@media (prefers-color-scheme: dark)` — "ledger at night," same
roles, not a different theme):

| Token | Value |
|---|---|
| `--paper` | `#1c1a16` |
| `--paper-alt` | `#262319` |
| `--ink` | `#ede6d3` |
| `--ink-muted` | `#a89e88` |
| `--rule` | `#3a352a` |
| `--accent` | `#d9714f` |

No user-facing theme toggle — follows OS/browser `prefers-color-scheme`
only.

### Typography

- Display: **Playfair Display**, weight 700, self-hosted (single woff2,
  Latin subset) under `web/public/fonts/`. Used only for the masthead
  wordmark and per-state headlines (e.g. "Sign in").
- Body: system sans-serif stack (`-apple-system, "Segoe UI", Roboto,
  sans-serif`) for all body text, inputs, buttons, tile captions, links.

### Shape & elevation

- Border radius: 2px maximum everywhere (flat, paper-like — not rounded
  app chrome).
- No drop shadows except the single `1px solid var(--rule)` border
  around the main content panel.
- Distinctiveness comes from rules, stamp-style buttons, and the
  calendar tiles — not from soft shadows or gradients.

## Global chrome: masthead

Present identically across all 6 states, above the content panel:

- "dontforget" wordmark, Playfair Display 700, large.
- A thin double horizontal rule beneath it (newspaper-nameplate device;
  two 1px `--rule` lines with a small gap).
- A small `--ink-muted` dateline beneath the rule: today's date,
  computed client-side and formatted long-form (e.g. "Sunday, 9 August
  2026").

## Per-state design

All states render inside one centered content panel: max-width ~640px,
`--paper` background, `1px solid var(--rule)` border, generous padding.

- **signedOut** — Headline "Sign in" (Playfair Display). Subtext "No
  password — we'll email you a link." Email input styled as a ruled
  line (bottom-border only, no box; border-bottom switches to
  `--accent` on focus). Submit button styled as an ink stamp:
  rectangular, `--accent` border, uppercase text with letter-spacing,
  transparent background, `--accent` text; `:active` scales down
  slightly (~0.97).
- **linkSent** — Same panel. Message "Check your inbox — the link signs
  you in," preceded by a small typographic ornament (`※`) rather than
  an icon — keeps the print-like feel instead of introducing
  iconography.
- **empty** (search) — The core input. Label "What do you want to
  track?" (Playfair Display, smaller than headline) above a ruled-line
  input identical in style to the email input. Stamp-style submit
  button labeled "Search."
- **loading** — The submitted query text shown as a small label chip
  with a dashed `--rule` border (torn-ticket look) instead of the
  current plain `.chip`. Below it: "Searching → extracting dates…" plus
  three small tick marks that light up in sequence via a CSS
  `@keyframes` loop with staggered `animation-delay` (clock-tick motif,
  pure CSS, infinite, subtle — no spinner icon).
- **review** (candidates) — Structural change from the current row
  list: candidates render as a responsive CSS grid of **calendar-day
  tiles**. Each tile:
  - Top strip: month abbreviation (e.g. "AUG"), `--accent` text on
    `--paper-alt`.
  - Large day number (the candidate's start date's day) in `--ink`,
    Playfair Display.
  - Caption line below: full date range + label, `--ink-muted`, small;
    source URL as a subtle inline link.
  - The entire tile is the click target for toggling selection (no
    separate visible checkbox element, though the underlying `<input
    type=checkbox>` stays for accessibility/semantics, visually
    hidden).
  - Selected: `--accent` border (2px) + faint `--accent`-tinted
    background + a small corner tick mark.
  - Unselected: `--rule` border, `--paper-alt` background, `--ink-muted`
    text (desaturated look).
  - Border/background transition ~100ms on toggle.
  - "Approve selected (N)" stamp-button below the grid, same style as
    other primary buttons.
- **feedReady** — ICS and RSS rendered as two ledger-style rows (not new
  UI): label + monospace URL text, separated by a single hairline
  `--rule` divider. No new copy-button or other functionality — styling
  only, per scope.

## Motion (subtle tier)

- State transitions: when `renderWorkspace` swaps in a new state's
  markup, the new wrapper's root element gets a CSS animation class
  that fades and slides up slightly (~150ms ease-out) on insert. Pure
  CSS `@keyframes`, no JS animation library.
- Loading indicator: the 3 tick marks described above.
- Tile selection: ~100ms border/background transition.
- Buttons: `:active` scale/opacity feedback (~100ms).
- Nothing else animates — no page-flip effects, no scroll-triggered
  motion.

## Testing impact

`web/src/render.test.ts` currently asserts against the existing
row-based candidate markup (e.g. `.cand-row` class, plain text
content). The tile-grid restructuring of the `review` state requires
updating those assertions to the new structure. `data-id` and
`data-action` attributes on interactive elements are preserved
unchanged, so handler-wiring tests (click/toggle/submit behavior)
continue to pass without modification — only structural queries tied to
the old row markup need updating. No new test infrastructure or
framework is introduced; this is routine test maintenance accompanying
the markup change, using the project's existing Vitest + jsdom setup.

## Out of scope

- Any change to `web/src/state.ts` (the state machine) or the backend.
- A user-facing theme toggle (dark mode follows OS preference only).
- New functionality (e.g. copy-to-clipboard on feed URLs) not already
  present in the current UI.
- Icon usage — the design deliberately stays typographic/print-like
  rather than introducing an icon set.
