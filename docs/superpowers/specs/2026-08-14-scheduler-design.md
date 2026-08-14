# dontforget — Scheduler Design

> Status: approved 2026-08-14 (design collaboration, this session).
> Scope: waking saved queries back up on their own recurrence interval,
> auto-adding new dates to already-trusted feeds, surfacing new candidates
> for never-approved queries, and emailing the user either way. Does not
> change the first-run happy path, the feed formats, or auth. See
> `docs/design.md` §1, §6, §8 for the decisions this design closes out.

## Problem

A saved query's `recurrence_interval` has been stored since the first
implementation pass, but nothing ever reads it. Once a user gets their
first set of dates, the query is inert forever — the actual "don't forget"
value proposition (checking back automatically) doesn't exist yet.
`docs/design.md` §8 explicitly deferred two decisions this design makes:
how the user is notified of a re-run result, and the scheduler's detailed
behavior.

## Decisions

- **Mechanism: in-process `setInterval`, ticking once daily.** No new
  dependency, no new infra service — matches `docs/design.md` §1
  ("a cron-triggered job inside the backend container — no separate
  service needed at this scale"). State lives in Mongo (`last_run_at`),
  not in the interval itself, so a container restart only shifts *when*
  the next check happens, never what it decides. Considered and rejected:
  a `node-cron` dependency for cron-string syntax (not worth it — the
  coarsest recurrence is weekly, so minute-level timing precision buys
  nothing) and an externally-triggered HTTP endpoint driven by a systemd
  timer (reopens the "separate service" question §1 already closed, for
  no benefit at this scale).
- **Every saved query gets re-run on schedule, regardless of approval
  history.** A query with zero approved events still gets checked; its
  results land as `candidate`, same shape as a first run, awaiting
  review. This was the one point where `docs/design.md` §1's "approved
  queries auto-add new dates" language could be read narrowly (skip
  unapproved queries entirely) or broadly (still check them, just don't
  auto-approve their results) — this design takes the broad reading.
- **Trust is per-query, decided at write time.** A query is "trusted" if
  it has ever had at least one `approved` event. Trusted queries get new
  distinct events inserted directly as `approved` (no re-approval, per
  §1). Untrusted queries get new events inserted as `candidate`.
- **Dedup is against existing DB rows for the query, not just within one
  run's batch.** `searchOrchestrator` already dedupes within a single
  run's results (same `label`+`startDate`+`endDate`). The scheduler adds
  a second dedup pass against everything already stored for that
  `query_id` (any status), so a re-run that finds the same festival dates
  again doesn't insert them a second time.
- **Email notification, in both the trusted and untrusted case**, sent
  per query per run (not batched across a day's worth of due queries) via
  the existing `EmailSender` (`SmtpEmailSender` in production, wired
  since this week — see status report 2026-08-14). Two message shapes:
  "N new dates added to your feed for '<query text>'" (trusted, FYI —
  nothing to do) vs. "N new dates found for '<query text>' — go review"
  (untrusted, action needed). No email when a re-run finds nothing new.
- **`last_run_at` updates on any completed attempt** — success, including
  zero-new-events — **but not on error.** A per-query failure (searxng or
  opencode error) is logged and skipped; that query stays due and gets
  retried on the next daily tick rather than waiting a full recurrence
  interval. One query's failure never blocks the rest of the day's batch
  (sequential processing, each query's errors caught individually).
- **No concurrency cap for this pass.** Due queries process one at a
  time. Query volume is small enough (single-digit users) that this
  isn't worth the complexity yet; §8's "rate limits / cost guardrails"
  item stays open, revisit if volume grows.
- **Default recurrence interval changes from `monthly` to `weekly`** —
  both `DEFAULT_RECURRENCE_INTERVAL` in `src/types.ts` and the hardcoded
  `'monthly'` in the add-query form (`web/src/render.ts:270`). Existing
  saved queries keep whatever interval they already have; this only
  changes what a *new* query defaults to.

## Due-query selection

`recurrence_interval` is one of `weekly | monthly | quarterly | yearly`.
A query is due when `now - last_run_at >= intervalToMs(recurrence_interval)`,
computed via calendar-aware `Date` arithmetic (`setDate`/`setMonth`/
`setFullYear` offsets from `last_run_at`, not fixed millisecond
multiples) so month-length variation doesn't drift the schedule. Every
query has a `last_run_at` already (set to the creation timestamp on the
synchronous first run — see `queriesRepo.ts`), so there's no "never run"
case to special-case.

## Components

| Component | Responsibility |
|---|---|
| `src/scheduler/dueQueries.ts` | Query `queries` for rows due for a re-run, given the current time. |
| `src/scheduler/scheduledRun.ts` | Given one due query: run the orchestrator, dedupe against existing events, branch on trust, write events, send the appropriate email, update `last_run_at` (or not, on error). |
| `src/scheduler/scheduler.ts` | The daily `setInterval` loop: on each tick, fetch due queries and process them sequentially through `scheduledRun`. Started from `server.ts`'s `main()`, not from `buildApp()` — tests and `buildApp()` consumers never see it. |

`scheduledRun` reuses the same `runQuery` orchestrator function already
built in `server.ts` and passed into `buildApp()` — no new search/extract
code path.

## Data model

No schema changes — `recurrence_interval` and `last_run_at` already exist
on `queries` (added for the dashboard pass). One new index: `events` on
`{ query_id: 1, label: 1, start_date: 1, end_date: 1 }`, to make the
per-query dedup lookup an index hit instead of a collection scan as event
volume grows.

## Error handling

- Per-query orchestrator failure (searxng or opencode error): caught,
  logged, `last_run_at` left untouched, loop continues to the next due
  query.
- Email send failure: caught and logged; does not roll back the event
  writes or `last_run_at` update — the data change is what matters most,
  and a failed notification isn't worth losing a completed run over.
  (This is stricter than the existing magic-link send, which doesn't
  catch at all and lets a failure propagate — acceptable there because
  it fails one synchronous HTTP request; not acceptable here, where an
  uncaught email error would otherwise take down the rest of the day's
  scheduled batch.)

## Testing

Same conventions already used across the codebase (e.g. `masthead.test.ts`
added this week): fake timers for the interval loop itself; focused unit
tests with an in-memory/mocked `Db` for due-query date math, the dedup
filter, and the trust/candidate branch — none of it needs a real Mongo,
searxng, or opencode.

## Out of scope for this pass

- Rate limits / cost guardrails on opencode + searxng calls (§8, still
  open — revisit if query volume grows).
- Any change to the first-run synchronous path, feed formats, or auth.
- A "re-run history" or activity log UI — the email notification is the
  only surfacing mechanism this pass builds.
