# Review/Edit Dismiss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give skipped candidate events a real `'dismissed'` terminal state, and scope the Review card to only still-pending candidates, so approved/skipped events stop resurfacing.

**Architecture:** Widen `events.status` to a third value across backend and frontend types; extend the existing `POST /api/queries/:id/approve` endpoint to accept an optional `dismissEventIds` list alongside the existing `eventIds`; replace the frontend's boolean tile-selection with a three-way `decision` field that cycles on click (none → approve → dismiss → none); filter which events each card fetches into local state (Review: candidate only; Edit: candidate + approved).

**Tech Stack:** TypeScript, Fastify, MongoDB (native driver), Vitest (`node` env for `src/`, `jsdom` env for `web/src/`), vanilla DOM rendering (no framework) for the frontend.

## Global Constraints

- No schema migration — the new `'dismissed'` value is purely additive; no existing rows have it.
- No changes to the scheduler, email notifications, feed formats (`.ics`/`.rss`), or auth.
- Dismissal has no undo path — do not build one.
- One extended API call for approve+dismiss, not two separate endpoints/requests.
- Tile interaction is a click-cycle (repeated clicks/taps on the same tile), never a literal double-click/double-tap gesture.
- Every new locale string needs both an `EN` and matching `DE` entry in `web/src/i18n.ts` — `DE` is typed `Record<MessageKey, string>`, so the build fails if one is missing.
- Full rationale for every decision here lives in `docs/superpowers/specs/2026-08-19-review-edit-dismissed-design.md` (commit `53179c1`) — consult it if a task's "why" isn't obvious.

---

### Task 1: Widen `events.status` and add dismiss support to the approve endpoint

**Files:**
- Modify: `src/types.ts:24`
- Modify: `src/queries/queriesRepo.ts:19`
- Modify: `src/scheduler/scheduledRun.ts:14`
- Modify: `src/queries/approveEvents.ts`
- Modify: `src/queries/routes.ts:80-101`
- Modify: `web/src/types.ts:7` and `web/src/types.ts:63`
- Test: `src/queries/approveEvents.test.ts`
- Test: `src/queries/dashboardRoutes.test.ts`
- Test: `src/queries/queriesRepo.test.ts`

**Interfaces:**
- Produces: `approveEvents(db, userId, queryId, eventIds, publicBaseUrl, recurrenceInterval?, dismissEventIds = [])` — the `dismissEventIds` parameter is new and appended last so every existing call site (10+ across the test suite) keeps compiling unchanged. Later tasks (frontend `api.ts`) call the HTTP endpoint this wires up, not this function directly.
- Produces: `POST /api/queries/:id/approve` now accepts an optional `dismissEventIds: string[]` field in its JSON body, alongside the existing `eventIds`.

- [ ] **Step 1: Widen the status union type everywhere it's declared**

`src/types.ts:24` — change:
```ts
export interface CandidateEvent extends ExtractedEvent {
  id: string;
  status: 'candidate' | 'approved';
}
```
to:
```ts
export interface CandidateEvent extends ExtractedEvent {
  id: string;
  status: 'candidate' | 'approved' | 'dismissed';
}
```

`src/queries/queriesRepo.ts:19` (the `EventRow` interface) — same change, `'candidate' | 'approved'` → `'candidate' | 'approved' | 'dismissed'`.

`src/scheduler/scheduledRun.ts:14` (the `ExistingEventRow` interface) — same change.

`web/src/types.ts:7` (`CandidateEvent.status`) and `web/src/types.ts:63` (`EventDetail.status`) — same change in both places.

Leave `src/queries/queriesRepo.ts:119` (`status: doc.status as 'candidate' | 'approved'`) untouched — that cast is inside `completeQueryRun`, which only ever writes `'candidate'` or `'approved'` (never `'dismissed'`), and a narrower literal type is still assignable to the now-wider `CandidateEvent.status`, so it type-checks as-is.

- [ ] **Step 2: Run the type check to confirm nothing else breaks**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npx tsc -p tsconfig.json --noEmit && cd web && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (the widened union is a superset, so all existing `===` comparisons against `'approved'`/`'candidate'` remain valid).

- [ ] **Step 3: Write the failing tests for dismiss in `approveEvents`**

Add to `src/queries/approveEvents.test.ts`, inside the existing `describe('approveEvents', ...)` block, after the `'ignores malformed event ids instead of throwing'` test:

```ts
  it('dismisses only the selected events, leaving others untouched', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    const result = await approveEvents(db, userId, queryId, [], 'http://localhost:3000', undefined, [candidates[1].id]);

    expect(result).not.toBeNull();
    const statuses = await db
      .collection('events')
      .find({ query_id: new ObjectId(queryId) })
      .toArray();
    const byLabel = Object.fromEntries(statuses.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('candidate');
    expect(byLabel['Kirchweihdult (stale)']).toBe('dismissed');
  });

  it('approves and dismisses different events in the same call', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    await approveEvents(
      db,
      userId,
      queryId,
      [candidates[0].id],
      'http://localhost:3000',
      undefined,
      [candidates[1].id]
    );

    const statuses = await db
      .collection('events')
      .find({ query_id: new ObjectId(queryId) })
      .toArray();
    const byLabel = Object.fromEntries(statuses.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('approved');
    expect(byLabel['Kirchweihdult (stale)']).toBe('dismissed');
  });
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npx vitest run src/queries/approveEvents.test.ts`
Expected: FAIL — `approveEvents` doesn't accept a 7th argument yet, and no row ever becomes `'dismissed'`.

- [ ] **Step 5: Implement dismiss support in `approveEvents`**

Replace the full contents of `src/queries/approveEvents.ts` with:

```ts
import { ObjectId, type Db } from 'mongodb';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import type { RecurrenceInterval } from '../types.js';

export async function approveEvents(
  db: Db,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string,
  recurrenceInterval?: RecurrenceInterval,
  dismissEventIds: string[] = []
): Promise<{ icsUrl: string; rssUrl: string } | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return null;
  }

  const ownership = await db.collection('queries').findOne({
    _id: queryObjectId,
    user_id: userId,
  });
  if (!ownership) {
    return null;
  }

  if (recurrenceInterval) {
    await db
      .collection('queries')
      .updateOne({ _id: queryObjectId }, { $set: { recurrence_interval: recurrenceInterval } });
  }

  const eventObjectIds = eventIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (eventObjectIds.length > 0) {
    await db.collection('events').updateMany(
      {
        query_id: queryObjectId,
        _id: { $in: eventObjectIds },
      },
      { $set: { status: 'approved' } }
    );
  }

  const dismissObjectIds = dismissEventIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (dismissObjectIds.length > 0) {
    await db.collection('events').updateMany(
      {
        query_id: queryObjectId,
        _id: { $in: dismissObjectIds },
      },
      { $set: { status: 'dismissed' } }
    );
  }

  const token = await getOrCreateFeedToken(db, userId);
  return {
    icsUrl: `${publicBaseUrl}/f/${token}.ics`,
    rssUrl: `${publicBaseUrl}/f/${token}.rss`,
  };
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npx vitest run src/queries/approveEvents.test.ts`
Expected: PASS, all 6 tests (4 existing + 2 new).

- [ ] **Step 7: Wire `dismissEventIds` through the HTTP route**

In `src/queries/routes.ts`, replace lines 80-101 (the `/api/queries/:id/approve` handler) with:

```ts
  app.post<{
    Params: { id: string };
    Body: { eventIds: string[]; dismissEventIds?: string[]; recurrenceInterval?: string };
  }>(
    '/api/queries/:id/approve',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const interval = request.body?.recurrenceInterval;
      if (interval !== undefined && !isRecurrenceInterval(interval)) {
        return reply.code(400).send({ error: 'invalid recurrenceInterval' });
      }
      const result = await approveEvents(
        deps.db,
        request.userId!,
        request.params.id,
        request.body?.eventIds ?? [],
        deps.publicBaseUrl,
        interval,
        request.body?.dismissEventIds ?? []
      );
      if (!result) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(result);
    }
```

(the closing `);` for `app.post` stays as it already is on the line after — only the type parameters and the `approveEvents(...)` call argument list change.)

- [ ] **Step 8: Write the failing HTTP-level test**

Add to `src/queries/dashboardRoutes.test.ts`, directly after the `'GET /api/queries/:id/events returns 403 for a query the user does not own'` test (after line 397):

```ts
  it('POST /api/queries/:id/approve dismisses events sent in dismissEventIds', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${queryId}/approve`,
      headers: authHeaders(sessionId),
      payload: { eventIds: [candidates[0].id], dismissEventIds: [candidates[1].id] },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    const byLabel = Object.fromEntries(rows.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('approved');
    expect(byLabel['Jakobidult']).toBe('dismissed');
  });
```

- [ ] **Step 9: Run it to verify it fails, then passes**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npx vitest run src/queries/dashboardRoutes.test.ts`
Expected first (before Step 7): FAIL — route doesn't read `dismissEventIds` from the body yet. After Step 7 is in place: PASS.

- [ ] **Step 10: Write the dedup regression test**

Add to `src/queries/queriesRepo.test.ts`, inside the existing `describe('completeQueryRun', ...)` block (after the `'does not override the cadence when none is suggested'` test), and add `approveEvents` to the existing import if not already present — it already is (`import { approveEvents } from './approveEvents';` at line 5):

```ts
    it('does not reinsert a dismissed event when the same date is found again', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      const [candidate] = await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ], null);
      await approveEvents(db, userId, query.queryId, [], 'http://localhost:3000', undefined, [candidate.id]);

      await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ], null);

      const stored = await db.collection('events').find({ query_id: query._id }).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0].status).toBe('dismissed');
    });
```

- [ ] **Step 11: Run the full backend suite**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npm test`
Expected: PASS, no regressions anywhere else in `src/`.

- [ ] **Step 12: Commit**

```bash
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget add src/types.ts src/queries/queriesRepo.ts src/scheduler/scheduledRun.ts src/queries/approveEvents.ts src/queries/approveEvents.test.ts src/queries/routes.ts src/queries/dashboardRoutes.test.ts src/queries/queriesRepo.test.ts web/src/types.ts
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget commit -m "feat: add dismissed event status and wire it through the approve endpoint"
```

---

### Task 2: Extend the frontend `approveEvents` API client

**Files:**
- Modify: `web/src/api.ts:77-91`
- Test: `web/src/api.test.ts`

**Interfaces:**
- Consumes: `POST /api/queries/:id/approve` now accepts `dismissEventIds` in its body (Task 1).
- Produces: `approveEvents(queryId: string, eventIds: string[], recurrenceInterval?: RecurrenceInterval, dismissEventIds: string[] = [])`. Task 5 (`main.ts`) calls this with a real `dismissEventIds` array.

- [ ] **Step 1: Write the failing test**

Add to `web/src/api.test.ts`, directly after the `'approveEvents omits the cadence when none was chosen'` test (after line 129):

```ts
  it('approveEvents sends dismissEventIds alongside the event ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss' }) });
    vi.stubGlobal('fetch', fetchMock);

    await approveEvents('q1', ['e1'], undefined, ['e2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries/q1/approve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ eventIds: ['e1'], dismissEventIds: ['e2'] }) })
    );
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx vitest run src/api.test.ts`
Expected: FAIL — `approveEvents` only accepts 3 arguments today, and the request body never includes `dismissEventIds`.

- [ ] **Step 3: Implement the signature change**

In `web/src/api.ts`, replace lines 77-91 (the `approveEvents` function) with:

```ts
export async function approveEvents(
  queryId: string,
  eventIds: string[],
  recurrenceInterval?: RecurrenceInterval,
  dismissEventIds: string[] = []
): Promise<{ icsUrl: string; rssUrl: string }> {
  const body: { eventIds: string[]; recurrenceInterval?: RecurrenceInterval; dismissEventIds?: string[] } = { eventIds };
  if (recurrenceInterval) body.recurrenceInterval = recurrenceInterval;
  if (dismissEventIds.length > 0) body.dismissEventIds = dismissEventIds;
  const response = await fetch(`/api/queries/${queryId}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle(response);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx vitest run src/api.test.ts`
Expected: PASS, all tests including the 2 pre-existing `approveEvents` tests (they omit `dismissEventIds`, which defaults to `[]` and is therefore never serialized, so their exact-body assertions still match).

- [ ] **Step 5: Commit**

```bash
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget add web/src/api.ts web/src/api.test.ts
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget commit -m "feat: send dismissEventIds from the frontend approve API client"
```

---

### Task 3: Tri-state `decision` field in the reducer

**Files:**
- Modify: `web/src/state.ts`
- Test: `web/src/state.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure frontend state, independent of the API shape).
- Produces: `SelectableEditEvent.decision: 'none' | 'approve' | 'dismiss'` (replaces `selected: boolean`). `TOGGLE_REVIEW_EVENT`/`TOGGLE_EDIT_EVENT` cycle `none → approve → dismiss → none` instead of flipping a boolean. Task 4 (`render.ts`) reads `.decision` to pick tile CSS classes and count the approve button's `(n)`; Task 5 (`main.ts`) reads `.decision === 'approve'` / `'dismiss'` to split submit payloads.

- [ ] **Step 1: Update the type and the load/cancel reducer cases**

In `web/src/state.ts`, replace the `SelectableEditEvent` interface (currently):
```ts
export interface SelectableEditEvent extends EventDetail {
  selected: boolean;
}
```
with:
```ts
export type EventDecision = 'none' | 'approve' | 'dismiss';

export interface SelectableEditEvent extends EventDetail {
  decision: EventDecision;
}

function cycleDecision(decision: EventDecision): EventDecision {
  if (decision === 'none') return 'approve';
  if (decision === 'approve') return 'dismiss';
  return 'none';
}
```

In the `EDIT_EVENTS_LOADED` case, replace:
```ts
          // Pending candidates start unselected, mirroring the first-search
          // review flow (tap to pick); approved events are not re-selectable.
          events: event.events.map(e => ({ ...e, selected: false })),
```
with:
```ts
          // Pending candidates start undecided; approved events are shown
          // read-only and never gain a decision.
          events: event.events.map(e => ({ ...e, decision: 'none' as const })),
```

In the `REVIEW_EVENTS_LOADED` case, replace:
```ts
          events: event.events.map(e => ({ ...e, selected: false })),
```
with:
```ts
          events: event.events.map(e => ({ ...e, decision: 'none' as const })),
```

- [ ] **Step 2: Update the toggle cases to cycle instead of flip**

Replace the `TOGGLE_EDIT_EVENT` case:
```ts
    case 'TOGGLE_EDIT_EVENT': {
      if (state.kind !== 'dashboard' || !state.editing) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          events: state.editing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, selected: !e.selected } : e
          ),
        },
      };
    }
```
with:
```ts
    case 'TOGGLE_EDIT_EVENT': {
      if (state.kind !== 'dashboard' || !state.editing) return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          events: state.editing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, decision: cycleDecision(e.decision) } : e
          ),
        },
      };
    }
```

Replace the `TOGGLE_REVIEW_EVENT` case:
```ts
    case 'TOGGLE_REVIEW_EVENT': {
      if (state.kind !== 'dashboard' || !state.reviewing) return state;
      return {
        ...state,
        reviewing: {
          ...state.reviewing,
          events: state.reviewing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, selected: !e.selected } : e
          ),
        },
      };
    }
```
with:
```ts
    case 'TOGGLE_REVIEW_EVENT': {
      if (state.kind !== 'dashboard' || !state.reviewing) return state;
      return {
        ...state,
        reviewing: {
          ...state.reviewing,
          events: state.reviewing.events.map(e =>
            e.status === 'candidate' && e.id === event.id ? { ...e, decision: cycleDecision(e.decision) } : e
          ),
        },
      };
    }
```

- [ ] **Step 3: Update the two "loads events" tests to the new field**

Replace `'loads events into the open review card, leaving pending candidates unselected'`:
```ts
  it('loads events into the open review card, leaving pending candidates unselected', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
    ];
    const next = reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      reviewing: {
        events: [
          { id: 'e1', status: 'approved', decision: 'none' },
          { id: 'e2', status: 'candidate', decision: 'none' },
        ],
      },
    });
  });
```
(body is otherwise unchanged from today — only the two `selected: false` entries in the final `toMatchObject` become `decision: 'none'`).

Replace `'loads events into the open edit card, leaving pending candidates unselected'` the same way:
```ts
  it('loads events into the open edit card, leaving pending candidates unselected', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
    };
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
    ];
    const next = reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      editing: {
        events: [
          { id: 'e1', status: 'approved', decision: 'none' },
          { id: 'e2', status: 'candidate', decision: 'none' },
        ],
      },
    });
  });
```

- [ ] **Step 4: Rewrite the two toggle tests to verify the full cycle**

Replace `'toggles a pending candidate in the review card and leaves approved events alone'`:
```ts
  it('toggles a pending candidate in the review card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: {
        queryId: 'q1',
        recurrenceInterval: 'weekly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'none' },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
    };
    const afterFirstClick = reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterFirstClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'approve' }, { id: 'e2', decision: 'none' }] },
    });

    const afterSecondClick = reducer(afterFirstClick, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterSecondClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'dismiss' }, { id: 'e2', decision: 'none' }] },
    });

    const afterThirdClick = reducer(afterSecondClick, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(afterThirdClick).toMatchObject({
      reviewing: { events: [{ id: 'e1', decision: 'none' }, { id: 'e2', decision: 'none' }] },
    });
  });

  it('ignores TOGGLE_REVIEW_EVENT on an already-approved event', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: {
        queryId: 'q1',
        recurrenceInterval: 'weekly',
        events: [
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
    };
    const next = reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e2' });
    expect(next).toMatchObject({ reviewing: { events: [{ id: 'e2', decision: 'none' }] } });
  });
```

Replace `'toggles a pending candidate inside the edit card and leaves approved events alone'`:
```ts
  it('toggles a pending candidate inside the edit card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: {
        queryId: 'q1',
        text: 'A',
        recurrenceInterval: 'monthly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'none' },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', decision: 'none' },
        ],
      },
      reviewing: null,
    };
    const afterFirstClick = reducer(state, { type: 'TOGGLE_EDIT_EVENT', id: 'e1' });
    expect(afterFirstClick).toMatchObject({
      editing: { events: [{ id: 'e1', decision: 'approve' }, { id: 'e2', decision: 'none' }] },
    });

    const afterSecondClick = reducer(afterFirstClick, { type: 'TOGGLE_EDIT_EVENT', id: 'e1' });
    expect(afterSecondClick).toMatchObject({
      editing: { events: [{ id: 'e1', decision: 'dismiss' }, { id: 'e2', decision: 'none' }] },
    });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget add web/src/state.ts web/src/state.test.ts
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget commit -m "feat: cycle candidate tiles through none/approve/dismiss instead of a boolean toggle"
```

---

### Task 4: Tri-state tile rendering in Review and Edit cards

**Files:**
- Modify: `web/src/render.ts`
- Modify: `web/src/i18n.ts`
- Modify: `web/src/style.css`
- Test: `web/src/render.test.ts`
- Test: `web/src/i18n.test.ts` (only if it enumerates keys explicitly — see Step 5)

**Interfaces:**
- Consumes: `SelectableEditEvent.decision: 'none' | 'approve' | 'dismiss'` (Task 3).
- Produces: `renderSelectableTile` shows one of three visual states via `day-tile-decision-approve` / `day-tile-decision-dismiss` CSS classes (no class for `none`). The `(n)` on `review.approve` / `edit.saveAndApprove` counts only `decision === 'approve'` tiles. Task 5 (`main.ts`) doesn't touch rendering — it only reads `.decision` off the same `SelectableEditEvent[]` arrays this task renders.

- [ ] **Step 1: Add the two new locale keys**

In `web/src/i18n.ts`, add to the `EN` object (near the other `edit.*` keys, e.g. after `'edit.noEvents'`):
```ts
  'edit.decisionApprove': 'Approving',
  'edit.decisionDismiss': 'Dismissing',
```
and the matching `DE` entries (near the other German `edit.*` keys):
```ts
  'edit.decisionApprove': 'Wird bestätigt',
  'edit.decisionDismiss': 'Wird verworfen',
```

- [ ] **Step 2: Write the failing render tests**

In `web/src/render.test.ts`, update these four existing tests to the new `decision` field (each replacement below is the full test body — only the `selected`/`day-tile-selected` occurrences actually change):

Replace `'renders the reviewing card with candidate tiles and wires approve/cancel'`:
```ts
  it('renders the reviewing card with candidate tiles and wires approve/cancel', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query({ candidateCount: 1 })],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'yearly',
          events: [
            {
              id: 'e1',
              label: 'Frühjahrsdult',
              startDate: '2026-04-11',
              endDate: '2026-04-11',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'approve',
            },
          ],
        },
      },
      handlers
    );

    expect(container.querySelector('.query-card-reviewing')).not.toBeNull();
    expect(container.textContent).toContain('Frühjahrsdult');
    expect(container.textContent).toContain('APR');
    expect(container.textContent).toContain('11');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-decision-approve')).toBe(true);

    const checkbox = container.querySelector<HTMLInputElement>('.query-card-reviewing .day-tile input[type=checkbox]')!;
    checkbox.click();
    expect(handlers.onToggleReviewEvent).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve-review]')!.click();
    expect(handlers.onApproveReview).toHaveBeenCalledWith('q1');

    container.querySelector<HTMLButtonElement>('button[data-action=cancel-review]')!.click();
    expect(handlers.onCancelReview).toHaveBeenCalled();
  });
```

Replace `'shows a date range and an unselected style when start and end differ'`:
```ts
  it('shows a date range and a neutral style when start and end differ', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            {
              id: 'e2',
              label: 'Oktoberfest',
              startDate: '2026-09-19',
              endDate: '2026-10-04',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'none',
            },
          ],
        },
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('SEP 19, 2026–OCT 4, 2026');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-decision-approve')).toBe(false);
  });
```

Replace `'falls back to the raw string for a malformed date instead of "undefined"'`:
```ts
  it('falls back to the raw string for a malformed date instead of "undefined"', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            {
              id: 'e3',
              label: 'Mystery Fest',
              startDate: 'not-a-date',
              endDate: 'not-a-date',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'none',
            },
          ],
        },
      },
      noopHandlers()
    );

    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).toContain('not-a-date');
  });
```

Replace `'shows the events inside the edit card and toggles pending candidates'`:
```ts
  it('shows the events inside the edit card and toggles pending candidates', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query({ approvedCount: 1, candidateCount: 1 })],
        feed: null,
        editing: {
          queryId: 'q1',
          text: 'Auer Dult Munich',
          recurrenceInterval: 'quarterly',
          events: [
            { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1', status: 'approved', decision: 'none' },
            { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2', status: 'candidate', decision: 'approve' },
          ],
        },
        reviewing: null,
      },
      handlers
    );

    expect(container.textContent).toContain('approved');
    const checkbox = container.querySelector<HTMLInputElement>('.edit-form .day-tile input[type=checkbox]')!;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    expect(handlers.onToggleEditEvent).toHaveBeenCalledWith('e2');
  });
```

Then add two new tests, after `'shows the events inside the edit card and toggles pending candidates'`:

```ts
  it('shows a distinct dismiss style and label when a candidate is decided for dismissal', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            { id: 'e1', label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-09-19', sourceUrl: 'u', status: 'candidate', decision: 'dismiss' },
          ],
        },
      },
      noopHandlers()
    );

    const tile = container.querySelector('.day-tile')!;
    expect(tile.classList.contains('day-tile-decision-dismiss')).toBe(true);
    expect(tile.classList.contains('day-tile-decision-approve')).toBe(false);
    expect(container.textContent).toContain('Dismissing');
  });

  it('counts only approve-decided tiles in the review approve button, not dismissed ones', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'approve' },
            { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', decision: 'dismiss' },
          ],
        },
      },
      noopHandlers()
    );

    const approveButton = container.querySelector<HTMLButtonElement>('button[data-action=approve-review]')!;
    expect(approveButton.textContent).toContain('1');
    expect(approveButton.textContent).not.toContain('2');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx vitest run src/render.test.ts`
Expected: FAIL — `render.ts` still reads `.selected` and only renders two states.

- [ ] **Step 4: Update the tile rendering and count logic**

In `web/src/render.ts`, replace `renderSelectableTile` (currently):
```ts
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
```
with:
```ts
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
```

In `renderReviewCard`, replace:
```ts
  const selectedCount = pending.filter(e => e.selected).length;
```
with:
```ts
  const selectedCount = pending.filter(e => e.decision === 'approve').length;
```

In `renderEditCard`, replace the same line (`const selectedCount = pending.filter(e => e.selected).length;`) the same way.

- [ ] **Step 5: Add the two new CSS rules**

In `web/src/style.css`, replace the existing `.day-tile-selected` rule:
```css
.day-tile-selected {
  border: 2px solid var(--accent);
  background: var(--paper);
  color: var(--ink);
}
```
with:
```css
.day-tile-decision-approve {
  border: 2px solid var(--accent);
  background: var(--paper);
  color: var(--ink);
}

.day-tile-decision-dismiss {
  border: 1px dashed var(--ink-muted);
  background: var(--paper-alt);
  color: var(--ink-muted);
  text-decoration: line-through;
}

.day-tile-decision-label {
  display: block;
  font-size: 0.7rem;
  font-style: italic;
  margin-top: 0.15rem;
  text-decoration: none;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx vitest run src/render.test.ts src/i18n.test.ts`
Expected: PASS. (`i18n.test.ts` doesn't enumerate individual keys — it tests `detectLocale`/`t`/rendered-string behavior — so it needs no edits, just a green re-run to confirm the new keys didn't break anything.)

- [ ] **Step 7: Commit**

```bash
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget add web/src/render.ts web/src/render.test.ts web/src/i18n.ts web/src/style.css
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget commit -m "feat: render a three-state approve/dismiss/neutral tile in Review and Edit"
```

---

### Task 5: Filter events per card and split approve/dismiss on submit

**Files:**
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `approveEvents(queryId, eventIds, recurrenceInterval?, dismissEventIds?)` (Task 2); `SelectableEditEvent.decision` (Task 3); `getQueryEvents(queryId): Promise<EventDetail[]>` (unchanged, already returns all statuses per query — filtering happens here, not in the API layer, per the design's decision that `getQueryEvents` itself is unchanged).
- Produces: nothing consumed by a later task — this is the last task, wiring everything built so far into the running app.

- [ ] **Step 1: Filter Review to candidate-only events**

In `web/src/main.ts`, replace `startReview` (currently):
```ts
function startReview(queryId: string): void {
  setState(reducer(state, { type: 'START_REVIEW', queryId }));
  // The card opens immediately; the events for it load async.
  getQueryEvents(queryId)
    .then(events => setState(reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId, events })))
    .catch(err => showError('error.loadingEvents', err));
}
```
with:
```ts
function startReview(queryId: string): void {
  setState(reducer(state, { type: 'START_REVIEW', queryId }));
  // The card opens immediately; the events for it load async. Review is a
  // lean "decide on what's pending" queue — approved and dismissed events
  // are never shown here (see docs/superpowers/specs/2026-08-19-review-edit-dismissed-design.md).
  getQueryEvents(queryId)
    .then(events => {
      const pending = events.filter(e => e.status === 'candidate');
      setState(reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId, events: pending }));
    })
    .catch(err => showError('error.loadingEvents', err));
}
```

- [ ] **Step 2: Filter Edit to hide dismissed events only**

Replace the `onStartEdit` handler (currently):
```ts
    onStartEdit: queryId => {
      clearError();
      setState(reducer(state, { type: 'START_EDIT', queryId }));
      // The dashboard card opens immediately; the events for it load async.
      getQueryEvents(queryId)
        .then(events => setState(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId, events })))
        .catch(err => showError('error.loadingEvents', err));
    },
```
with:
```ts
    onStartEdit: queryId => {
      clearError();
      setState(reducer(state, { type: 'START_EDIT', queryId }));
      // The dashboard card opens immediately; the events for it load async.
      // Edit keeps approved events visible for context (it's the "manage
      // this query" view); only dismissed ones stay hidden.
      getQueryEvents(queryId)
        .then(events => {
          const visible = events.filter(e => e.status !== 'dismissed');
          setState(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId, events: visible }));
        })
        .catch(err => showError('error.loadingEvents', err));
    },
```

- [ ] **Step 3: Split approve/dismiss ids on Review submit**

Replace the `onApproveReview` handler (currently):
```ts
    onApproveReview: queryId => {
      if (state.kind !== 'dashboard' || state.reviewing?.queryId !== queryId) return;
      // Snapshot the current selection now — the user can keep toggling
      // checkboxes while this request is in flight.
      const eventIds = state.reviewing.events
        .filter(e => e.status === 'candidate' && e.selected)
        .map(e => e.id);
      clearError();
      approveEvents(queryId, eventIds, state.reviewing.recurrenceInterval)
        .then(() => {
          setState(reducer(state, { type: 'REVIEW_APPROVED', queryId }));
          refreshDashboard();
        })
        .catch(err => showError('error.approving', err));
    },
```
with:
```ts
    onApproveReview: queryId => {
      if (state.kind !== 'dashboard' || state.reviewing?.queryId !== queryId) return;
      // Snapshot the current decisions now — the user can keep cycling
      // tiles while this request is in flight.
      const approveIds = state.reviewing.events
        .filter(e => e.status === 'candidate' && e.decision === 'approve')
        .map(e => e.id);
      const dismissIds = state.reviewing.events
        .filter(e => e.status === 'candidate' && e.decision === 'dismiss')
        .map(e => e.id);
      clearError();
      approveEvents(queryId, approveIds, state.reviewing.recurrenceInterval, dismissIds)
        .then(() => {
          setState(reducer(state, { type: 'REVIEW_APPROVED', queryId }));
          refreshDashboard();
        })
        .catch(err => showError('error.approving', err));
    },
```

- [ ] **Step 4: Split approve/dismiss ids on Edit save**

Replace the `onSaveEdit` handler (currently):
```ts
    onSaveEdit: (queryId, patch) => {
      clearError();
      // Snapshot the selected candidates at save time; the edit card stays
      // interactive while the PATCH + approve round-trips, and we reload the
      // dashboard once both have settled so counts and feed links refresh.
      const selectedIds =
        state.kind === 'dashboard' && state.editing?.queryId === queryId
          ? state.editing.events.filter(e => e.status === 'candidate' && e.selected).map(e => e.id)
          : [];
      updateQuery(queryId, patch)
        .then(() => {
          if (selectedIds.length > 0) return approveEvents(queryId, selectedIds);
          return undefined;
        })
        .then(() => refreshDashboard())
        .catch(err => showError('error.saving', err));
    },
```
with:
```ts
    onSaveEdit: (queryId, patch) => {
      clearError();
      // Snapshot the decided candidates at save time; the edit card stays
      // interactive while the PATCH + approve round-trips, and we reload the
      // dashboard once both have settled so counts and feed links refresh.
      const editingEvents =
        state.kind === 'dashboard' && state.editing?.queryId === queryId ? state.editing.events : [];
      const approveIds = editingEvents.filter(e => e.status === 'candidate' && e.decision === 'approve').map(e => e.id);
      const dismissIds = editingEvents.filter(e => e.status === 'candidate' && e.decision === 'dismiss').map(e => e.id);
      updateQuery(queryId, patch)
        .then(() => {
          if (approveIds.length > 0 || dismissIds.length > 0) {
            return approveEvents(queryId, approveIds, undefined, dismissIds);
          }
          return undefined;
        })
        .then(() => refreshDashboard())
        .catch(err => showError('error.saving', err));
    },
```

- [ ] **Step 5: Type-check and run the full frontend suite**

Run: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, no type errors, no regressions (`main.ts` has no dedicated test file — `render.test.ts`, `state.test.ts`, and `api.test.ts` already cover the pieces it wires together).

- [ ] **Step 6: Commit**

```bash
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget add web/src/main.ts
git -C /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget commit -m "feat: scope Review to pending candidates and split approve/dismiss on submit"
```

---

### Task 6: Manual verification in the browser

**Files:** none (verification only).

- [ ] **Step 1: Start the backend and frontend dev servers**

Run in the repo root: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget && npm run dev`
Run in a second terminal: `cd /home/cda/.agent-deck/multi-repo-worktrees/507aac51/dontforget/web && npm run dev`

Without `SMTP_HOST` set, magic-link sign-in emails print to the backend's stdout instead of sending — copy the link from there.

- [ ] **Step 2: Walk the golden path**

1. Sign in, submit a new query with a search term likely to return multiple dates.
2. Once it lands and Review auto-opens, click one candidate tile three times: confirm it cycles through the "will approve" accent-bordered style → the dashed "Dismissing" style → back to plain, matching the click-cycle described in the spec.
3. Leave one tile on "approve", one on "dismiss", and one untouched (`none`); click **Approve selected**.
4. Reopen Review on the same query (or wait for it to resurface pending items): confirm the approved tile is gone, the dismissed tile is gone, and the untouched tile is still there as a plain candidate.
5. Open **Edit** on the same query: confirm the approved event still shows (read-only, as today), the dismissed one does not appear anywhere, and any remaining candidate tile supports the same three-click cycle.
6. Confirm the feed (`.ics`/`.rss` links on the dashboard) is unaffected — still reflects only approved events.

- [ ] **Step 3: Report results**

If any step doesn't match, stop and report the mismatch — do not attempt a fix without diagnosing root cause first (see `superpowers:systematic-debugging`).
