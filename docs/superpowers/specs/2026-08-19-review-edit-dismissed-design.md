# dontforget — Review/Edit Dismiss Design

> Status: approved 2026-08-19 (design collaboration, this session).
> Scope: giving skipped candidate events a real terminal state, and scoping
> the Review card down to genuinely pending candidates instead of the full
> event history. Does not change the scheduler, the email pipeline, the
> feed formats, or auth.

## Problem

`events.status` is only `'candidate' | 'approved'`. Skipping a candidate in
Review records nothing — the row stays `candidate` forever, so it resurfaces
in every future Review *and* Edit card alongside whatever's newly found.
Both cards also source the full, unfiltered event history for their query
(`getQueryEvents`, no status or recency filter), so Review shows every
historically-approved event plus every never-decided candidate from prior
sessions, not just what's new. Root-caused via `systematic-debugging` this
session: see conversation history for the trace (`getQueryEvents` in
`src/queries/queriesRepo.ts:249-271`, `renderReviewCard`/`renderEditCard` in
`web/src/render.ts:531-608`).

Symptom, in the user's words: "review should also only show new dates but
shows also already approved and dismissed items" — and, separately, "review
and edit look pretty same," which traces to the same root cause (both cards
render the same unfiltered event list through near-identical markup).

## Decisions

- **Add `'dismissed'` as a third `events.status` value.** Purely additive —
  no existing rows have it, so no migration/backfill. The "trusted query"
  check in `completeQueryRun`/`runScheduledQuery`
  (`existing.some(e => e.status === 'approved')`) is unaffected; it only
  ever looked for `'approved'`.
- **Dismissal is permanent, with no undo UI.** The existing dedup key in
  `filterNewEvents` (matched on start/end date against *all* existing rows
  for the query, regardless of status) already means a dismissed date won't
  resurface even if a later search finds it again — this falls out of the
  current dedup design for free, not new code. Explicitly decided against
  building an undo/"view dismissed" affordance for this pass; revisit if
  misclicks turn out to be a real problem in practice.
- **Review shows only `status === 'candidate'` events.** No approved, no
  dismissed — it becomes a lean "decide on what's pending" queue. This is
  the actual fix for "review should only show new dates": it's not a
  recency filter, it's a status filter — once dismiss exists, "still
  candidate" and "not yet decided" become the same thing.
- **Edit shows `candidate` (tri-state, see below) plus `approved`
  (existing read-only tiles, unchanged).** Dismissed stays invisible in
  both cards. This is the deliberate differentiation between the two cards
  going forward: Review is a lean action queue; Edit is the "manage this
  query" view, where seeing what's already landed for context still makes
  sense.
- **Tile interaction becomes a tri-state click-cycle: none → approve →
  dismiss → none.** Same interaction in both Review and Edit — one
  consistent gesture everywhere a candidate tile appears, not two
  behaviors for the same kind of tile. Explicitly not a double-click/
  double-tap gesture (unreliable on touch, often reserved for browser
  zoom) — cycling on repeated taps of the same tile works identically on
  mouse and touch.
- **One extended API call, not two.** `POST /api/queries/:id/approve`
  gains an optional `dismissEventIds` alongside the existing `eventIds`
  (kept as the approve-id list), and performs both `updateMany`s in the
  same handler. Considered and rejected: a separate `dismissEvents`
  endpoint fired as a second request — two round-trips, and a partial-
  failure case (approve succeeds, dismiss fails, or vice versa) with no
  clean reconciliation, for a change that's fundamentally one decision.
- **Submit buttons count only `approve`-decided tiles for their `(n)`.**
  ("Approve selected (n)" / "Save and approve (n)".) Tiles left at `none`
  are left alone server-side — they stay `candidate` and can resurface
  next time, matching today's "unchecked stays pending" behavior.
- **"Not now" / "Cancel" stay pure defers — no tile decisions are sent.**
  Unchanged from today: closing the card via `CANCEL_REVIEW`/`CANCEL_EDIT`
  makes no API call, so any tiles cycled to `dismiss` (or `approve`) before
  bailing out are discarded along with the rest of the local draft. Only
  the two submit buttons persist anything.

## Components

| Component | Responsibility |
|---|---|
| `src/queries/approveEvents.ts` | Extend to accept `dismissEventIds` and `$set` those rows to `'dismissed'` alongside the existing approve `updateMany`. |
| `src/queries/routes.ts` (`/api/queries/:id/approve`) | Accept `dismissEventIds` in the request body, pass through. |
| `src/queries/queriesRepo.ts` (`getQueryEvents`) | No change to the query itself (still fetches all statuses) — filtering to what each card shows moves to the two call sites below, since Review and Edit now need different subsets of the same fetch. |
| `web/src/main.ts` (`startReview`, `onStartEdit`) | Filter the fetched events before dispatching `REVIEW_EVENTS_LOADED` (candidate only) / `EDIT_EVENTS_LOADED` (candidate + approved). |
| `web/src/state.ts` | `SelectableEditEvent.selected: boolean` → `decision: 'none' | 'approve' | 'dismiss'`. `TOGGLE_REVIEW_EVENT`/`TOGGLE_EDIT_EVENT` cycle instead of flip. |
| `web/src/render.ts` (`renderReviewCard`, `renderEditCard`, `renderSelectableTile`) | Tri-state tile rendering (three distinct visual states); submit-button `(n)` counts `decision === 'approve'` tiles; submit handlers split tiles into `approveIds`/`dismissIds`. |
| `web/src/api.ts` (`approveEvents`) | Add `dismissEventIds` parameter, pass through in the request body. |

## Data model

`events.status`: `'candidate' | 'approved' | 'dismissed'`. No index changes
— the existing per-query event lookups are unaffected by the new value.

## Error handling

Unchanged shape from today's approve flow: the combined approve/dismiss
call is a single promise from the client's perspective. On failure,
`showError` fires and the card's local tile decisions are left untouched
(no optimistic state is discarded), so the user's in-progress triage isn't
lost and they can retry.

## Testing

Same conventions as the rest of the codebase: focused unit tests for
`approveEvents` (both id lists processed, empty-list no-ops), the reducer's
tri-state cycle, and the Review/Edit event-filtering split in `main.ts`.
No new integration surface — reuses the existing approve endpoint's auth/
ownership checks.

## Out of scope for this pass

- Undo/"view dismissed" UI (see Decisions above — explicitly deferred).
- Any change to the scheduler, email notifications, or feed formats.
- The still-parked "search again" Edit-card design (separate spec, not yet
  written — unrelated change, different files).
