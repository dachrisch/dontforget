# Query Credits & Pause/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the billing gate from query-creation time to agent-run time, turn the existing Stripe subscription into a prepay-in-advance quota, and add a non-destructive pause/resume lifecycle whose events drop out of the calendar/RSS feed while paused.

**Architecture:** A `queries.active: boolean` field (independent of `status`) controls slot occupancy, feed inclusion, and scheduler eligibility. `status` gains one value, `'blocked'` (created but never ran — no slot was free). `users.stripe_subscription_quantity` locally mirrors the Stripe subscription's quantity (purchased slots), updated whenever the app changes it (checkout, add-slots) and whenever Stripe reports a change via webhook (covers manual portal edits too). A shared `hasFreeSlot`/`claimSlotForQuery` pair in `billingService.ts`/`queriesRepo.ts` gates every path that can occupy a slot: create, retry (for `blocked` queries), and reactivate.

**Tech Stack:** TypeScript, Fastify, MongoDB driver, Vitest — no new dependencies. Spec: `docs/superpowers/specs/2026-08-20-query-credits-design.md`.

## Global Constraints

- **Searching stays free; only occupying a slot is gated.** `POST /api/queries` never 402s — it always creates the row. `active`/`status` are decided by slot availability at creation time.
- **A slot = one query with `active !== false`.** Absent `active` on legacy docs means active (treat as `{ $ne: false }` everywhere, matching how `status` already defaults missing values to `'ready'`).
- **Reactivating never runs the agent.** It only flips `active` back to `true`, gated by slot availability. Only `blocked` queries (which never held a slot) go through retry, which *can* trigger a real agent run.
- **Deactivating never touches billing**, and is rejected while `status === 'running'`.
- **Delete still releases exactly one purchased slot** (`quantity = max(1, current - 1)`) — not a recompute-from-active-count sync (that would erase prepaid slack bought in advance). This replaces `BillingService.syncQuantity` entirely; nothing calls the old recompute-based method after this plan.
- **Atomicity is single-document only.** `claimSlotForQuery`'s `findOneAndUpdate` prevents the *same* query being claimed twice (e.g. a double-click). Two *different* blocked/paused queries racing for the last free slot can both pass an earlier `hasFreeSlot()` check and both succeed — this app's MongoDB is a standalone instance (no replica set), so multi-document transactions aren't available. The soft-cap overshoot this allows is accepted, not engineered around: it's a billing quota, not a security boundary, and self-corrects the next time `GET /api/billing/status` is checked. Document this reasoning in code, don't silently drop it.
- **Refinement beyond the spec, found while planning:** `stripe_subscription_quantity` must be populated from Stripe itself, not just from the app's own writes, or a first-time checkout for >1 slot would silently leave the local mirror at the free-tier default. `checkout.session.completed`'s event payload doesn't embed the subscription's item quantity, so `BillingGateway` gains one new method, `getSubscriptionQuantity`, used only there. `customer.subscription.updated` already carries `items.data[].quantity` inline in its payload — reading it there needs no new API call, and incidentally keeps the mirror correct after a manual portal quantity edit too (out of scope to build a *feature* around, but free to get right while already touching this code).

---

## Task 1: Data model — `active` field and `blocked` status

**Files:**
- Modify: `src/types.ts:45,55` (backend `QueryStatus`, `QuerySummary`)
- Modify: `web/src/types.ts:24,34` (frontend mirrors)

**Interfaces:**
- Produces: `QueryStatus` now includes `'blocked'`; `QuerySummary` gains `active: boolean`. Every later task that reads/writes a query row relies on this.

- [ ] **Step 1: Update backend types**

In `src/types.ts`, replace:
```ts
export type QueryStatus = 'running' | 'ready' | 'failed';

export interface QuerySummary {
  id: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  lastRunAt: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  approvedCount: number;
  candidateCount: number;
  status: QueryStatus;
}
```
with:
```ts
export type QueryStatus = 'running' | 'ready' | 'failed' | 'blocked';

export interface QuerySummary {
  id: string;
  text: string;
  recurrenceInterval: RecurrenceInterval;
  lastRunAt: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  approvedCount: number;
  candidateCount: number;
  status: QueryStatus;
  active: boolean;
}
```

- [ ] **Step 2: Update frontend types**

In `web/src/types.ts`, make the identical change to `QueryStatus` and `QuerySummary`.

- [ ] **Step 3: Verify the build still compiles (no behavior yet)**

Run: `cd src/.. && npx tsc -p tsconfig.json --noEmit` (from repo root) and `cd web && npx tsc --noEmit`
Expected: both fail only on downstream code that already builds `QuerySummary` objects without `active` — that's expected until Task 3. If either fails on something unrelated to a missing `active` field, stop and investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts web/src/types.ts
git commit -m "feat(types): add active query flag and blocked status"
```

---

## Task 2: Slot primitives in `BillingService`

**Files:**
- Modify: `src/billing/billingService.ts:1-36`
- Test: `src/billing/billingService.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `countActiveQueries(db, userId)` (existing signature, changed filter), `getPurchasedSlots(db, userId): Promise<number>`, `hasFreeSlot(db, userId): Promise<boolean>` — all exported, all consumed by Tasks 3, 4, 6.

- [ ] **Step 1: Write the failing tests**

Add to `src/billing/billingService.test.ts` (inside the existing `describe('BillingService', ...)`, alongside the existing `isOverFreeLimit` test):

```ts
  it('countActiveQueries ignores deactivated queries', async () => {
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a', active: true });
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'b', active: false });
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'c' }); // legacy: no field
    expect(await countActiveQueries(db, userId)).toBe(2);
  });

  it('getPurchasedSlots defaults to the free limit when never subscribed', async () => {
    expect(await getPurchasedSlots(db, userId)).toBe(FREE_QUERY_LIMIT);
  });

  it('getPurchasedSlots reads the mirrored subscription quantity', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_subscription_quantity: 5 } });
    expect(await getPurchasedSlots(db, userId)).toBe(5);
  });

  it('hasFreeSlot compares active count against purchased slots', async () => {
    expect(await hasFreeSlot(db, userId)).toBe(true); // 0 active < 1 free
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a', active: true });
    expect(await hasFreeSlot(db, userId)).toBe(false); // 1 active >= 1 free

    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_subscription_quantity: 3 } });
    expect(await hasFreeSlot(db, userId)).toBe(true); // 1 active < 3 purchased
  });
```

Update the top import line to add the new names:
```ts
import { BillingService, isOverFreeLimit, countActiveQueries, getPurchasedSlots, hasFreeSlot, FREE_QUERY_LIMIT } from './billingService';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- billingService.test.ts`
Expected: FAIL — `countActiveQueries`/`getPurchasedSlots`/`hasFreeSlot` not exported, or `countActiveQueries` returns 3 instead of 2 (old filter).

- [ ] **Step 3: Implement**

In `src/billing/billingService.ts`, update `UserRow` and the two helper functions, and add two new ones:

```ts
interface UserRow {
  _id: ObjectId;
  email: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  stripe_subscription_status?: string;
  stripe_subscription_quantity?: number;
}

export function countActiveQueries(db: Db, userId: string): Promise<number> {
  return db.collection('queries').countDocuments({ user_id: userId, active: { $ne: false } });
}

export async function getPurchasedSlots(db: Db, userId: string): Promise<number> {
  const user = await db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
  return user?.stripe_subscription_quantity ?? FREE_QUERY_LIMIT;
}

export async function hasFreeSlot(db: Db, userId: string): Promise<boolean> {
  const [active, purchased] = await Promise.all([countActiveQueries(db, userId), getPurchasedSlots(db, userId)]);
  return active < purchased;
}
```

(`isOverFreeLimit` stays as-is for now — Task 3 replaces its one call site.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- billingService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/billing/billingService.ts src/billing/billingService.test.ts
git commit -m "feat(billing): add slot-availability primitives"
```

---

## Task 3: `POST /api/queries` — remove the creation-time gate, add blocked branching

**Files:**
- Modify: `src/queries/queriesRepo.ts:52-76` (`createQuery`)
- Modify: `src/queries/routes.ts:30-62` (the `POST /api/queries` handler)
- Test: `src/queries/dashboardRoutes.test.ts:490-513`

**Interfaces:**
- Consumes: `hasFreeSlot(db, userId)` from Task 2.
- Produces: `createQuery(db, userId, queryText, recurrenceInterval?, active?)` — `active` param added, defaults to `true` so every other existing caller (tests, `initialRun` retries via `queriesRepo`) is unaffected.

- [ ] **Step 1: Update the two existing 402-era tests to the new contract**

In `src/queries/dashboardRoutes.test.ts`, replace the two tests at lines 501–529:

```ts
  it('POST /api/queries always creates the query, even at capacity', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(202);

    const row = await db.collection('queries').findOne({ user_id: userId, query_text: 'Auer Dult' });
    expect(row?.status).toBe('blocked');
    expect(row?.active).toBe(false);
  });

  it('POST /api/queries allows a second query for a subscribed user with a free slot', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active', stripe_subscription_quantity: 2 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(202);
    const row = await db.collection('queries').findOne({ user_id: userId, query_text: 'Auer Dult' });
    expect(row?.status).toBe('running');
    expect(row?.active).toBe(true);
  });
```

(`POST /api/queries allows the first (free) query` at line 490 is unchanged — leave it.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test -- dashboardRoutes.test.ts -t "POST /api/queries"`
Expected: FAIL — current code still returns 402 for the first test, and the second test's row has no `active` field yet.

- [ ] **Step 3: Update `createQuery`**

In `src/queries/queriesRepo.ts`, replace the function:

```ts
export async function createQuery(
  db: Db,
  userId: string,
  queryText: string,
  recurrenceInterval: RecurrenceInterval = DEFAULT_RECURRENCE_INTERVAL,
  active: boolean = true
): Promise<NewQuery> {
  const now = new Date();
  const queryResult = await db.collection('queries').insertOne({
    user_id: userId,
    query_text: queryText,
    recurrence_interval: recurrenceInterval,
    created_at: now,
    // Stamped at creation so the scheduler's due-check has something to work
    // with even if the background search dies mid-run; completeQueryRun bumps
    // it once the run actually lands.
    last_run_at: now,
    status: (active ? 'running' : 'blocked') as const,
    active,
  });
  return {
    _id: queryResult.insertedId,
    queryId: queryResult.insertedId.toString(),
    user_id: userId,
    query_text: queryText,
  };
}
```

- [ ] **Step 4: Update the route**

In `src/queries/routes.ts`, replace the `POST /api/queries` handler body (lines 34–61):

```ts
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) {
        return reply.code(400).send({ error: 'text is required' });
      }
      const interval = request.body?.recurrenceInterval;
      if (interval !== undefined && !isRecurrenceInterval(interval)) {
        return reply.code(400).send({ error: 'invalid recurrenceInterval' });
      }
      // Searching is free — the query is always saved. Whether it actually
      // runs (and occupies a paid slot) depends on capacity right now.
      const active = await hasFreeSlot(deps.db, request.userId!);
      const query = await createQuery(deps.db, request.userId!, text, interval ?? DEFAULT_RECURRENCE_INTERVAL, active);
      if (active) {
        enqueueSearch(() => runInitialQuery(deps.db, query, { runQuery: deps.runQuery, applyCadence: interval === undefined }));
      }
      return reply.code(202).send({ queryId: query.queryId });
    }
```

Update the import line at the top of the file — remove `isOverFreeLimit, isSubscribed` and add `hasFreeSlot`:
```ts
import { hasFreeSlot, type BillingService } from '../billing/billingService.js';
```
Also remove the now-unused `ObjectId` import usage for the deleted `user` lookup if `ObjectId` is no longer referenced elsewhere in this file — check with `grep -n "ObjectId" src/queries/routes.ts` first; it's still used by the `/run` and `/deactivate`/`/reactivate` handlers added in later tasks, so keep the import.

- [ ] **Step 4b: Delete `isOverFreeLimit` — it's now dead code**

`isOverFreeLimit`'s only production call site was the block just deleted in Step 4; after this change nothing but its own test calls it (confirm with `grep -rn "isOverFreeLimit" src/` — only `billingService.ts`'s definition and `billingService.test.ts` should remain). Remove the function from `src/billing/billingService.ts`:
```ts
export function isOverFreeLimit(db: Db, userId: string): Promise<boolean> {
  return countActiveQueries(db, userId).then(count => count >= FREE_QUERY_LIMIT);
}
```
and remove its test (`'isOverFreeLimit: 0 queries are free, at or above the free limit is over'`) and the `isOverFreeLimit` name from the import line in `src/billing/billingService.test.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- dashboardRoutes.test.ts -t "POST /api/queries"`
Expected: PASS (4 tests: allows the first free query, always creates at capacity, allows a second query with a free slot, plus any pre-existing unrelated ones in that block).

- [ ] **Step 6: Run the full backend suite to catch any other 402 assumption**

Run: `npm test`
Expected: PASS. If `queriesRepo.test.ts` has a `createQuery` test asserting `status: 'running'` unconditionally, it still passes (default `active = true`).

- [ ] **Step 7: Commit**

```bash
git add src/queries/queriesRepo.ts src/queries/routes.ts src/queries/dashboardRoutes.test.ts
git commit -m "feat(queries): move the billing gate from creation to slot availability"
```

---

## Task 4: Atomic slot claim + blocked-query retry

**Files:**
- Modify: `src/queries/queriesRepo.ts` (new `claimSlotForQuery`)
- Modify: `src/queries/routes.ts:136-159` (the `POST /:id/run` handler)
- Test: `src/queries/dashboardRoutes.test.ts`

**Interfaces:**
- Produces: `claimSlotForQuery(db, userId, queryId: ObjectId): Promise<boolean>` — atomically flips `active: false → true` for one specific query; `false` if it was already active. Consumed here and by Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `src/queries/dashboardRoutes.test.ts`, near the other `/run` tests (search the file for `'/api/queries/:id/run'` to find the right section — if none exist yet, add a new `describe` block):

```ts
describe('POST /api/queries/:id/run — blocked queries', () => {
  it('claims a free slot and runs when one is available', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []); // occupies the one free slot
    const blockedResponse = await app.inject({
      method: 'POST', url: '/api/queries', headers: authHeaders(sessionId), payload: { text: 'Auer Dult' },
    });
    const { queryId } = blockedResponse.json();
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active', stripe_subscription_quantity: 2 },
    });

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/run`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(202);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.active).toBe(true);
    expect(row?.status).toBe('running');
  });

  it('returns 409 when still no free slot', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    const blockedResponse = await app.inject({
      method: 'POST', url: '/api/queries', headers: authHeaders(sessionId), payload: { text: 'Auer Dult' },
    });
    const { queryId } = blockedResponse.json();

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/run`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.active).toBe(false);
    expect(row?.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- dashboardRoutes.test.ts -t "blocked queries"`
Expected: FAIL — today's `/run` handler runs unconditionally regardless of `blocked` status/slot availability.

- [ ] **Step 3: Add `claimSlotForQuery`**

In `src/queries/queriesRepo.ts`, add near `markQueryFailed`:

```ts
// Single-document atomicity: prevents the SAME query being claimed twice by
// a rapid double-click on retry/reactivate. Two DIFFERENT blocked/paused
// queries racing for the last free slot can each pass an earlier
// hasFreeSlot() check and both land here — this Mongo deployment is a
// standalone instance without a replica set, so multi-document transactions
// aren't available to close that window. Accepted: it's a soft billing
// quota, not a security boundary, and self-corrects on the next status
// fetch. See docs/superpowers/specs/2026-08-20-query-credits-design.md.
export async function claimSlotForQuery(db: Db, userId: string, queryId: ObjectId): Promise<boolean> {
  const result = await db.collection('queries').findOneAndUpdate(
    { _id: queryId, user_id: userId, active: { $ne: true } },
    { $set: { active: true } }
  );
  return result !== null;
}
```

- [ ] **Step 4: Update the `/run` handler**

In `src/queries/routes.ts`, replace the `POST /api/queries/:id/run` handler body:

```ts
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const row = await deps.db
        .collection<{ _id: ObjectId; user_id: string; query_text: string; status?: QueryStatus }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (row.status === 'running') {
        return reply.code(409).send({ error: 'already running' });
      }
      if (row.status === 'blocked') {
        const hasSlot = await hasFreeSlot(deps.db, request.userId!);
        const claimed = hasSlot && (await claimSlotForQuery(deps.db, request.userId!, row._id));
        if (!claimed) {
          return reply.code(409).send({ error: 'no free credits', reason: 'no free credits — buy more or pause another query' });
        }
      }
      await deps.db.collection('queries').updateOne({ _id: row._id }, { $set: { status: 'running' as const } });
      enqueueSearch(() =>
        runInitialQuery(deps.db, { _id: row._id, query_text: row.query_text }, { runQuery: deps.runQuery, applyCadence: false })
      );
      return reply.code(202).send({ queryId: row._id.toString() });
    }
```

Add `claimSlotForQuery` to the `queriesRepo.js` import line at the top of the file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- dashboardRoutes.test.ts -t "blocked queries"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/queries/queriesRepo.ts src/queries/routes.ts src/queries/dashboardRoutes.test.ts
git commit -m "feat(queries): claim a free slot on retry for blocked queries"
```

---

## Task 5: `POST /api/queries/:id/deactivate`

**Files:**
- Modify: `src/queries/routes.ts`
- Test: `src/queries/dashboardRoutes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /api/queries/:id/deactivate', () => {
  it('requires auth', async () => {
    const { app } = await authenticatedUser(db);
    const response = await app.inject({ method: 'POST', url: '/api/queries/000000000000000000000000/deactivate' });
    expect(response.statusCode).toBe(401);
  });

  it('pauses a ready query without touching billing', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/deactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.active).toBe(false);
    expect(row?.status).toBe('ready'); // status untouched
  });

  it('rejects pausing a running query', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const response1 = await app.inject({
      method: 'POST', url: '/api/queries', headers: authHeaders(sessionId), payload: { text: 'Oktoberfest' },
    });
    const { queryId } = response1.json();

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/deactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.active).toBe(true);
  });

  it('returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const { userId: otherUserId } = await authenticatedUser(db, 'other2@example.com');
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/deactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- dashboardRoutes.test.ts -t "deactivate"`
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Add the route**

In `src/queries/routes.ts`, add after the `/run` handler:

```ts
  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/deactivate',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const result = await deps.db.collection('queries').findOneAndUpdate(
        { _id: queryObjectId, user_id: request.userId!, active: { $ne: false }, status: { $ne: 'running' } },
        { $set: { active: false } }
      );
      if (!result) {
        const exists = await deps.db.collection('queries').findOne({ _id: queryObjectId, user_id: request.userId! });
        if (!exists) return reply.code(403).send({ error: 'not your query' });
        return reply.code(409).send({ error: 'cannot pause a running search' });
      }
      return reply.code(204).send();
    }
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dashboardRoutes.test.ts -t "deactivate"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queries/routes.ts src/queries/dashboardRoutes.test.ts
git commit -m "feat(queries): add deactivate endpoint"
```

---

## Task 6: `POST /api/queries/:id/reactivate`

**Files:**
- Modify: `src/queries/routes.ts`
- Test: `src/queries/dashboardRoutes.test.ts`

**Interfaces:**
- Consumes: `hasFreeSlot`, `claimSlotForQuery` (Tasks 2, 4).

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /api/queries/:id/reactivate', () => {
  it('resumes a paused query when a slot is free — no agent run', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', [
      { label: 'Fest', startDate: '2026-09-01', endDate: '2026-09-01', sourceUrl: 'u' },
    ]);
    await app.inject({ method: 'POST', url: `/api/queries/${queryId}/deactivate`, headers: authHeaders(sessionId) });

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/reactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.active).toBe(true);
    expect(row?.status).toBe('ready'); // unchanged — it already had results
  });

  it('returns 409 when no slot is free', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await app.inject({ method: 'POST', url: `/api/queries/${queryId}/deactivate`, headers: authHeaders(sessionId) });
    await createQueryWithCandidates(db, userId, 'Something else', []); // takes the now-free slot

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/reactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects reactivating a blocked query — it never held a slot', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    const blockedResponse = await app.inject({
      method: 'POST', url: '/api/queries', headers: authHeaders(sessionId), payload: { text: 'Auer Dult' },
    });
    const { queryId } = blockedResponse.json();

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/reactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects reactivating an already-active query', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const response = await app.inject({
      method: 'POST', url: `/api/queries/${queryId}/reactivate`, headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- dashboardRoutes.test.ts -t "reactivate"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Add the route**

In `src/queries/routes.ts`, add after `/deactivate`:

```ts
  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/reactivate',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const row = await deps.db
        .collection<{ _id: ObjectId; user_id: string; status?: QueryStatus; active?: boolean }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (row.status === 'blocked') {
        return reply.code(409).send({ error: 'blocked queries use retry, not reactivate' });
      }
      if (row.active !== false) {
        return reply.code(409).send({ error: 'query is already active' });
      }
      const hasSlot = await hasFreeSlot(deps.db, request.userId!);
      const claimed = hasSlot && (await claimSlotForQuery(deps.db, request.userId!, row._id));
      if (!claimed) {
        return reply.code(409).send({ error: 'no free credits', reason: 'no free credits — buy more or pause another query' });
      }
      return reply.code(204).send();
    }
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dashboardRoutes.test.ts -t "reactivate"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queries/routes.ts src/queries/dashboardRoutes.test.ts
git commit -m "feat(queries): add reactivate endpoint"
```

---

## Task 7: Feed excludes deactivated queries' events

**Files:**
- Modify: `src/feed/routes.ts:33-37`
- Test: `src/feed/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/feed/routes.test.ts`:

```ts
  it('excludes events from a deactivated query', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'p@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { active: false } });

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });
    const response = await app.inject({ method: 'GET', url: `/f/${token}.ics` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Frühjahrsdult');
  });
```

Add `ObjectId` to the top-level import if not already present: `import { ObjectId } from 'mongodb';` alongside the existing `type Db, type MongoClient` import.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- feed/routes.test.ts`
Expected: FAIL — the event still appears (feed doesn't check `active` yet).

- [ ] **Step 3: Implement**

In `src/feed/routes.ts`, change the query lookup:

```ts
    const queries = await deps.db
      .collection('queries')
      .find({ user_id: tokenRow.user_id, active: { $ne: false } })
      .toArray();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- feed/routes.test.ts`
Expected: PASS (both the new test and the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/feed/routes.ts src/feed/routes.test.ts
git commit -m "fix(feed): exclude events from deactivated queries"
```

---

## Task 8: Scheduler skips deactivated and blocked queries

**Files:**
- Modify: `src/scheduler/dueQueries.ts:20-21`
- Test: `src/scheduler/dueQueries.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/scheduler/dueQueries.test.ts`:

```ts
  it('does not return a deactivated query even if its interval is due', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Paused', [], 'weekly');
    await backdateLastRunAt(queryId, 8);
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { active: false } });

    const due = await findDueQueries(db, new Date());

    expect(due).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- dueQueries.test.ts`
Expected: FAIL — the paused query is still returned.

- [ ] **Step 3: Implement**

In `src/scheduler/dueQueries.ts`, change:
```ts
  const rows = await db.collection<QueryRow>('queries').find().toArray();
```
to:
```ts
  const rows = await db.collection<QueryRow>('queries').find({ active: { $ne: false } }).toArray();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dueQueries.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/dueQueries.ts src/scheduler/dueQueries.test.ts
git commit -m "fix(scheduler): skip deactivated queries when finding due re-runs"
```

---

## Task 9: Delete releases exactly one purchased slot

**Files:**
- Modify: `src/billing/billingService.ts` (remove `syncQuantity`, add `releaseSlotOnDelete`)
- Modify: `src/queries/routes.ts:173-184` (`DELETE /api/queries/:id`)
- Test: `src/billing/billingService.test.ts` (replace the two `syncQuantity` tests)

**Interfaces:**
- Produces: `releaseSlotOnDelete(userId): Promise<void>` on `BillingService`, replacing `syncQuantity`.

- [ ] **Step 1: Replace the `syncQuantity` tests with `releaseSlotOnDelete` tests**

In `src/billing/billingService.test.ts`, delete the two tests `'syncQuantity is a no-op without a subscription'` and `'syncQuantity pushes the active count and clamps to 1'`, replacing them with:

```ts
  it('releaseSlotOnDelete is a no-op without a subscription', async () => {
    await service.releaseSlotOnDelete(userId);
    expect(gateway.quantityUpdates).toHaveLength(0);
  });

  it('releaseSlotOnDelete decrements quantity by exactly one, clamped to 1', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_quantity: 5 },
    });
    await service.releaseSlotOnDelete(userId);
    expect(gateway.quantityUpdates).toEqual([{ subscriptionId: 'sub_1', quantity: 4 }]);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_quantity).toBe(4);
  });

  it('releaseSlotOnDelete never drops below 1', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_quantity: 1 },
    });
    await service.releaseSlotOnDelete(userId);
    expect(gateway.quantityUpdates).toEqual([{ subscriptionId: 'sub_1', quantity: 1 }]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- billingService.test.ts -t "releaseSlotOnDelete"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement**

In `src/billing/billingService.ts`, remove the `syncQuantity` method entirely and add:

```ts
  async releaseSlotOnDelete(userId: string): Promise<void> {
    const user = await this.db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
    if (!user?.stripe_subscription_id) return;
    const current = user.stripe_subscription_quantity ?? FREE_QUERY_LIMIT;
    const next = Math.max(1, current - 1);
    await this.gateway.updateSubscriptionQuantity({ subscriptionId: user.stripe_subscription_id, quantity: next });
    await this.db.collection('users').updateOne({ _id: user._id }, { $set: { stripe_subscription_quantity: next } });
  }
```

- [ ] **Step 4: Update the delete route**

In `src/queries/routes.ts`, change the `DELETE /api/queries/:id` handler's billing call:
```ts
      await deps.billingService.releaseSlotOnDelete(request.userId!);
```
(replacing `await deps.billingService.syncQuantity(request.userId!);`)

- [ ] **Step 5: Run the full backend suite**

Run: `npm test`
Expected: PASS — no remaining references to `syncQuantity` anywhere. Confirm with `grep -rn "syncQuantity" src/` returning nothing.

- [ ] **Step 6: Commit**

```bash
git add src/billing/billingService.ts src/billing/billingService.test.ts src/queries/routes.ts
git commit -m "feat(billing): delete releases one purchased slot instead of recomputing quantity"
```

---

## Task 10: Checkout takes a caller-chosen quantity, and the webhook mirrors it correctly

**Files:**
- Modify: `src/billing/stripeGateway.ts` (new `getSubscriptionQuantity` on `BillingGateway`)
- Modify: `src/billing/billingService.ts` (`createCheckoutSession`, `getStatus`, `processEvent`)
- Modify: `src/billing/routes.ts` (`POST /api/billing/checkout` reads `?quantity=`)
- Test: `src/billing/billingService.test.ts`, `src/billing/routes.test.ts`

**Interfaces:**
- Produces: `BillingGateway.getSubscriptionQuantity(subscriptionId): Promise<number>`.
- Produces: `BillingStatus` gains `purchasedSlots: number`.

- [ ] **Step 1: Write the failing tests**

In `src/billing/billingService.test.ts`, replace the test `'checkout starts quantity at the active query count'` with:

```ts
  it('checkout defaults quantity to 1', async () => {
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(gateway.checkoutCalls[0].quantity).toBe(1);
  });

  it('checkout passes through a caller-chosen quantity, clamped to at least 1', async () => {
    await service.createCheckoutSession(userId, 'http://localhost:3000', 5);
    expect(gateway.checkoutCalls[0].quantity).toBe(5);

    await service.createCheckoutSession(userId, 'http://localhost:3000', 0);
    expect(gateway.checkoutCalls[1].quantity).toBe(1);
  });
```

Update the `'getStatus reports free-limit usage and subscription state'` test's first `toEqual` to include `purchasedSlots: 1,` (right after `activeQueryCount: 0,`).

Add a new test for the webhook quantity mirroring:

```ts
  it('processEvent on checkout.session.completed also mirrors the subscription quantity', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_customer_id: 'cus_test' } });
    gateway.subscriptionQuantities['sub_9'] = 3;
    await service.processEvent({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_test', subscription: 'sub_9', subscription_status: 'active' } },
    } as any);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_quantity).toBe(3);
  });

  it('processEvent on customer.subscription.updated mirrors quantity from the payload directly', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_9' },
    });
    await service.processEvent({
      id: 'evt_4',
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_test', status: 'active', items: { data: [{ quantity: 4 }] } } },
    } as any);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_quantity).toBe(4);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- billingService.test.ts -t "checkout\|processEvent\|getStatus"`
Expected: FAIL — `quantity` param doesn't exist, `gateway.subscriptionQuantities` doesn't exist, `purchasedSlots` missing from `getStatus`.

- [ ] **Step 3: Add `getSubscriptionQuantity` to the gateway**

In `src/billing/stripeGateway.ts`, add to the `BillingGateway` interface:
```ts
  getSubscriptionQuantity(subscriptionId: string): Promise<number>;
```

Add to `StripeBillingGateway`:
```ts
  async getSubscriptionQuantity(subscriptionId: string): Promise<number> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data[0];
    if (!item) throw new Error('subscription has no items');
    return item.quantity ?? 1;
  }
```

Add to `NullBillingGateway`:
```ts
  getSubscriptionQuantity(): Promise<number> { return Promise.resolve(this.unavailable()); }
```

Add to `FakeBillingGateway`:
```ts
  public subscriptionQuantities: Record<string, number> = {};

  async getSubscriptionQuantity(subscriptionId: string): Promise<number> {
    return this.subscriptionQuantities[subscriptionId] ?? 1;
  }
```

- [ ] **Step 4: Update `createCheckoutSession` and `getStatus`**

In `src/billing/billingService.ts`:

```ts
  async createCheckoutSession(userId: string, returnBaseUrl: string, quantity = 1): Promise<{ url: string }> {
    const user = await this.requireUser(userId);
    const customerId = await this.getOrCreateCustomerId(user);
    return this.gateway.createCheckoutSession({
      customerId,
      priceId: this.priceId,
      quantity: Math.max(1, quantity),
      successUrl: `${returnBaseUrl}/?checkout=success`,
      cancelUrl: returnBaseUrl,
    });
  }
```

```ts
  async getStatus(userId: string): Promise<BillingStatus> {
    const user = await this.requireUser(userId);
    return {
      freeLimit: FREE_QUERY_LIMIT,
      activeQueryCount: await countActiveQueries(this.db, userId),
      purchasedSlots: await getPurchasedSlots(this.db, userId),
      pricePerExtraQuery: PRICE_PER_EXTRA_QUERY_EUR,
      subscribed: isSubscribed(user),
      subscriptionStatus: user.stripe_subscription_status ?? null,
      checkoutUrl: '/api/billing/checkout',
      portalUrl: '/api/billing/portal',
    };
  }
```

Add `purchasedSlots: number;` to the `BillingStatus` interface, after `activeQueryCount`.

- [ ] **Step 5: Update `processEvent`**

In `src/billing/billingService.ts`, widen the loosely-typed `object` cast and update both cases:

```ts
    const object = event.data.object as {
      customer?: string;
      subscription?: string;
      subscription_status?: string;
      status?: string;
      items?: { data?: Array<{ quantity?: number }> };
    };
    const customerId = object.customer;
    if (!customerId) return;

    const update = this.db.collection<UserRow>('users');
    switch (event.type) {
      case 'checkout.session.completed':
        if (object.subscription) {
          const quantity = await this.gateway.getSubscriptionQuantity(object.subscription);
          await update.updateOne(
            { stripe_customer_id: customerId },
            {
              $set: {
                stripe_subscription_id: object.subscription,
                stripe_subscription_status: object.subscription_status ?? 'active',
                stripe_subscription_quantity: quantity,
              },
            }
          );
        }
        break;
      case 'customer.subscription.updated': {
        const quantity = object.items?.data?.[0]?.quantity;
        await update.updateOne(
          { stripe_customer_id: customerId },
          {
            $set: {
              stripe_subscription_status: object.status ?? 'active',
              ...(quantity !== undefined ? { stripe_subscription_quantity: quantity } : {}),
            },
          }
        );
        break;
      }
      case 'customer.subscription.deleted':
        await update.updateOne(
          { stripe_customer_id: customerId },
          { $unset: { stripe_subscription_id: '', stripe_subscription_status: '', stripe_subscription_quantity: '' } }
        );
        break;
    }
```

- [ ] **Step 6: Update the checkout route to read `?quantity=`**

In `src/billing/routes.ts`, change the `POST /api/billing/checkout` handler:

```ts
  app.post<{ Querystring: { quantity?: string } }>(
    '/api/billing/checkout',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const parsed = Number.parseInt(request.query.quantity ?? '1', 10);
      const quantity = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      try {
        const { url } = await deps.billingService.createCheckoutSession(request.userId!, deps.publicBaseUrl, quantity);
        return reply.redirect(url, 303);
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          return reply.code(503).send({ error: 'billing unavailable' });
        }
        throw err;
      }
    }
  );
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- billingService.test.ts routes.test.ts`
Expected: PASS. Check `src/billing/routes.test.ts` for any existing test asserting on the old no-querystring checkout behavior — if one exists, verify it still passes unmodified (default quantity 1 preserves prior behavior when no `?quantity=` is given).

- [ ] **Step 8: Commit**

```bash
git add src/billing/stripeGateway.ts src/billing/billingService.ts src/billing/routes.ts src/billing/billingService.test.ts
git commit -m "feat(billing): checkout accepts a chosen quantity, webhook mirrors it locally"
```

---

## Task 11: `POST /api/billing/add-slots`

**Files:**
- Modify: `src/billing/billingService.ts` (new `addSlots`)
- Modify: `src/billing/routes.ts`
- Test: `src/billing/billingService.test.ts`, `src/billing/routes.test.ts`

- [ ] **Step 1: Write the failing service test**

In `src/billing/billingService.test.ts`:

```ts
  it('addSlots increases quantity and mirrors it locally', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_quantity: 2 },
    });
    const next = await service.addSlots(userId, 3);
    expect(next).toBe(5);
    expect(gateway.quantityUpdates).toEqual([{ subscriptionId: 'sub_1', quantity: 5 }]);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_quantity).toBe(5);
  });

  it('addSlots throws BillingUnavailableError without an active subscription', async () => {
    await expect(service.addSlots(userId, 1)).rejects.toBeInstanceOf(BillingUnavailableError);
  });
```

Add `BillingUnavailableError` to the top import from `./stripeGateway`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- billingService.test.ts -t "addSlots"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement**

In `src/billing/billingService.ts`, add the import `BillingUnavailableError` from `./stripeGateway.js` if not already present, and add:

```ts
  async addSlots(userId: string, count: number): Promise<number> {
    const user = await this.requireUser(userId);
    if (!user.stripe_subscription_id) {
      throw new BillingUnavailableError();
    }
    const current = user.stripe_subscription_quantity ?? FREE_QUERY_LIMIT;
    const next = current + count;
    await this.gateway.updateSubscriptionQuantity({ subscriptionId: user.stripe_subscription_id, quantity: next });
    await this.db.collection('users').updateOne({ _id: user._id }, { $set: { stripe_subscription_quantity: next } });
    return next;
  }
```

- [ ] **Step 4: Write the failing route test**

In `src/billing/routes.test.ts` (check the existing file's setup pattern first — mirror it; it likely follows the same `authenticatedUser`-style helper as `dashboardRoutes.test.ts`), add:

```ts
  it('POST /api/billing/add-slots increases the subscription quantity', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_quantity: 1 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/add-slots',
      headers: authHeaders(sessionId),
      payload: { count: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ purchasedSlots: 3 });
  });

  it('POST /api/billing/add-slots returns 503 without a subscription', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/add-slots',
      headers: authHeaders(sessionId),
      payload: { count: 2 },
    });
    expect(response.statusCode).toBe(503);
  });
```

(If `src/billing/routes.test.ts` doesn't already have an `authenticatedUser`/`authHeaders` pair, copy the pattern from `src/queries/dashboardRoutes.test.ts:13-28` verbatim into this file rather than importing across test files.)

- [ ] **Step 5: Run to verify it fails**

Run: `npm test -- routes.test.ts -t "add-slots"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 6: Implement the route**

In `src/billing/routes.ts`, add:

```ts
  app.post<{ Body: { count?: number } }>(
    '/api/billing/add-slots',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const count = request.body?.count;
      if (!Number.isInteger(count) || count! < 1) {
        return reply.code(400).send({ error: 'count must be a positive integer' });
      }
      try {
        const purchasedSlots = await deps.billingService.addSlots(request.userId!, count!);
        return reply.send({ purchasedSlots });
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          return reply.code(503).send({ error: 'billing unavailable' });
        }
        throw err;
      }
    }
  );
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- billingService.test.ts routes.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/billing/billingService.ts src/billing/routes.ts src/billing/billingService.test.ts src/billing/routes.test.ts
git commit -m "feat(billing): add endpoint to buy additional slots on an existing subscription"
```

---

## Task 12: Backend suite sanity pass

**Files:** none (verification only)

- [ ] **Step 1: Run the entire backend suite**

Run: `npm test`
Expected: PASS, zero failures. This is the checkpoint before starting frontend work — every backend piece (Tasks 1–11) must be green together, not just individually.

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: If anything fails, stop and fix before proceeding to Task 13** — do not carry a red backend into frontend work.

---

## Task 13: Frontend API client — new calls, updated types

**Files:**
- Modify: `web/src/types.ts` (`BillingStatus`)
- Modify: `web/src/api.ts`
- Test: `web/src/api.test.ts`

**Interfaces:**
- Produces: `deactivateQuery(queryId): Promise<void>`, `reactivateQuery(queryId): Promise<void>`, `addSlots(count): Promise<{ purchasedSlots: number }>`, `startCheckout(quantity?: number): void` (signature change — was zero-arg).

- [ ] **Step 1: Update `BillingStatus`**

In `web/src/types.ts`, add `purchasedSlots: number;` to `BillingStatus`, after `activeQueryCount`.

- [ ] **Step 2: Write the failing tests**

Add to `web/src/api.test.ts`, near the existing `startCheckout` test:

```ts
  it('startCheckout defaults to quantity 1 in the form action', () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    startCheckout();
    const form = document.querySelector('form');
    expect(form?.getAttribute('action')).toBe('/api/billing/checkout?quantity=1');
    submitSpy.mockRestore();
    form?.remove();
  });

  it('startCheckout passes a chosen quantity through the form action', () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    startCheckout(4);
    const form = document.querySelector('form');
    expect(form?.getAttribute('action')).toBe('/api/billing/checkout?quantity=4');
    submitSpy.mockRestore();
    form?.remove();
  });

  it('deactivateQuery posts to the deactivate endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await deactivateQuery('q1');
    expect(fetchMock).toHaveBeenCalledWith('/api/queries/q1/deactivate', { method: 'POST', credentials: 'include' });
  });

  it('reactivateQuery posts to the reactivate endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await reactivateQuery('q1');
    expect(fetchMock).toHaveBeenCalledWith('/api/queries/q1/reactivate', { method: 'POST', credentials: 'include' });
  });

  it('addSlots posts the count and parses the new total', async () => {
    const body = { purchasedSlots: 4 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    await expect(addSlots(2)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/add-slots', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 2 }),
    });
  });
```

Update the existing `startCheckout` test (from the earlier PR #111 fix) to keep asserting `method`/`enctype`, dropping only the now-superseded `action` assertion if it hardcoded `/api/billing/checkout` without a query string — replace it with the two new tests above, which subsume it (they already assert `method`/`enctype` indirectly aren't checked here, so re-add those two assertions to one of the two new tests to avoid losing coverage):

```ts
  it('startCheckout submits a real POST form, not a GET navigation', () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    startCheckout();
    const form = document.querySelector('form');
    expect(form?.getAttribute('method')).toBe('POST');
    expect(form?.getAttribute('enctype')).toBe('text/plain');
    expect(form?.getAttribute('action')).toBe('/api/billing/checkout?quantity=1');
    expect(submitSpy).toHaveBeenCalledOnce();
    submitSpy.mockRestore();
    form?.remove();
  });
```
(replace the old `'startCheckout submits a real POST form, not a GET navigation'` test with this version, and drop the separate "defaults to quantity 1" test above since this now covers it — keep only the "passes a chosen quantity" test as the second one.)

Add the new names to the import list at the top of the file: `deactivateQuery, reactivateQuery, addSlots,`.

- [ ] **Step 3: Run to verify they fail**

Run: `cd web && npx vitest run -t "startCheckout\|deactivateQuery\|reactivateQuery\|addSlots"`
Expected: FAIL — functions don't exist / action has no query string yet.

- [ ] **Step 4: Implement**

In `web/src/api.ts`:

```ts
export function startCheckout(quantity = 1): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/billing/checkout?quantity=${quantity}`;
  form.enctype = 'text/plain';
  document.body.appendChild(form);
  form.submit();
}
```

```ts
export async function deactivateQuery(queryId: string): Promise<void> {
  const response = await fetch(`/api/queries/${queryId}/deactivate`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, 'failed to pause query');
}

export async function reactivateQuery(queryId: string): Promise<void> {
  const response = await fetch(`/api/queries/${queryId}/reactivate`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, 'failed to resume query');
}

export async function addSlots(count: number): Promise<{ purchasedSlots: number }> {
  const response = await fetch('/api/billing/add-slots', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  return handle(response);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run`
Expected: PASS, full suite.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/api.test.ts
git commit -m "feat(web): add pause/resume/add-slots API calls, quantity-aware checkout"
```

---

## Task 14: i18n keys for the new states

**Files:**
- Modify: `web/src/i18n.ts`

- [ ] **Step 1: Add English keys**

In the `EN` block of `web/src/i18n.ts`, add near the existing `queryCard.*` keys:

```ts
  'queryCard.blocked': 'Needs credits to search.',
  'queryCard.buyCredits': 'Buy credits',
  'queryCard.pause': 'Pause',
  'queryCard.resume': 'Resume',
  'queryCard.paused': 'Paused',
```

Replace the `billing.*` block with:
```ts
  'billing.title': 'Billing',
  'billing.upgrade': 'Upgrade',
  'billing.manage': 'Manage subscription',
  'billing.usage': '{used} of {purchased} credits used',
  'billing.perQuery': '{price} € per additional credit',
  'billing.buyMore': 'Buy more',
```
(remove `billing.subscribed` and `billing.freeLimit` — no longer used once Task 15 rewrites `renderBillingRow`.)

Add one new error key:
```ts
  'error.updatingSlots': 'Something went wrong while buying more credits. Please try again.',
  'error.pausing': 'Something went wrong while pausing the query. Please try again.',
  'error.resuming': 'Something went wrong while resuming the query. Please try again.',
```

- [ ] **Step 2: Add the matching German keys**

In the `DE` block, at the mirrored locations:

```ts
  'queryCard.blocked': 'Benötigt Guthaben für die Suche.',
  'queryCard.buyCredits': 'Guthaben kaufen',
  'queryCard.pause': 'Pausieren',
  'queryCard.resume': 'Fortsetzen',
  'queryCard.paused': 'Pausiert',
```

```ts
  'billing.title': 'Abrechnung',
  'billing.upgrade': 'Upgrade',
  'billing.manage': 'Abonnement verwalten',
  'billing.usage': '{used} von {purchased} Guthaben genutzt',
  'billing.perQuery': '{price} € pro zusätzlichem Guthaben',
  'billing.buyMore': 'Mehr kaufen',
```

```ts
  'error.updatingSlots': 'Beim Kauf von zusätzlichem Guthaben ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.pausing': 'Beim Pausieren der Suchanfrage ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.resuming': 'Beim Fortsetzen der Suchanfrage ist etwas schiefgegangen. Bitte versuch es erneut.',
```

- [ ] **Step 2: Type-check — `MessageKey = keyof typeof EN` means DE must have every key EN has**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (a mismatch between EN/DE key sets doesn't fail `tsc` directly since DE isn't typed against `MessageKey`, but Task 16's German-rendering test suite catches drift — this step just confirms no other type errors were introduced).

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n.ts
git commit -m "feat(i18n): add copy for blocked/paused query states and slot-based billing"
```

---

## Task 15: `render.ts` — blocked card, pause/resume, rewritten billing row

**Files:**
- Modify: `web/src/render.ts`
- Test: `web/src/render.test.ts`, `web/src/i18n.test.ts`

**Interfaces:**
- Consumes: `queryCard.blocked/buyCredits/pause/resume/paused`, `billing.usage/perQuery/buyMore` from Task 14.
- Produces: `WorkspaceHandlers` gains `onDeactivateQuery: (queryId: string) => void`, `onReactivateQuery: (queryId: string) => void`, `onBuyMoreSlots: (count: number) => void`. `onUpgrade` becomes `onUpgrade: (quantity: number) => void` (was zero-arg).

- [ ] **Step 1: Write the failing render tests**

Add to `web/src/render.test.ts` (check its existing structure first for the exact `renderWorkspace`/`noopHandlers`-style setup it uses, then match it):

```ts
  it('renders a blocked query card with buy-credits and try-again actions', () => {
    const container = document.createElement('div');
    renderWorkspace(container, {
      kind: 'dashboard',
      queries: [{
        id: 'q1', text: 'Auer Dult', recurrenceInterval: 'weekly',
        lastRunAt: null, createdAt: '2026-08-20T00:00:00Z',
        approvedCount: 0, candidateCount: 0, status: 'blocked', active: false,
      }],
      feed: null, editing: null, reviewing: null, billing: null,
    }, noopHandlers());

    const card = container.querySelector('.query-card-blocked');
    expect(card).not.toBeNull();
    expect(card!.querySelector('[data-action=retry]')).not.toBeNull();
    expect(card!.querySelector('[data-action=buy-credits]')).not.toBeNull();
    expect(card!.querySelector('[data-action=pause]')).toBeNull(); // never pausable
  });

  it('renders pause on a ready card and resume on a paused one', () => {
    const container = document.createElement('div');
    const readyQuery = {
      id: 'q1', text: 'Oktoberfest', recurrenceInterval: 'weekly' as const,
      lastRunAt: '2026-08-20T00:00:00Z', createdAt: '2026-08-20T00:00:00Z',
      approvedCount: 1, candidateCount: 0, status: 'ready' as const, active: true,
    };
    renderWorkspace(container, {
      kind: 'dashboard', queries: [readyQuery], feed: null, editing: null, reviewing: null, billing: null,
    }, noopHandlers());
    expect(container.querySelector('[data-action=pause]')).not.toBeNull();
    expect(container.querySelector('[data-action=resume]')).toBeNull();

    renderWorkspace(container, {
      kind: 'dashboard', queries: [{ ...readyQuery, active: false }], feed: null, editing: null, reviewing: null, billing: null,
    }, noopHandlers());
    expect(container.querySelector('[data-action=resume]')).not.toBeNull();
    expect(container.querySelector('[data-action=pause]')).toBeNull();
  });

  it('billing row shows used-of-purchased and a buy-more stepper', () => {
    const container = document.createElement('div');
    renderWorkspace(container, {
      kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null,
      billing: {
        freeLimit: 1, activeQueryCount: 2, purchasedSlots: 3, pricePerExtraQuery: 0.5,
        subscribed: true, subscriptionStatus: 'active', checkoutUrl: '/api/billing/checkout', portalUrl: '/api/billing/portal',
      },
    }, noopHandlers());
    expect(container.querySelector('.billing-summary')!.textContent).toContain('2');
    expect(container.querySelector('.billing-summary')!.textContent).toContain('3');
    expect(container.querySelector('[data-action=buy-more]')).not.toBeNull();
  });
```

Add the three new handlers to whatever `noopHandlers()` helper the test file already defines (mirror the existing `onRetrySearch: vi.fn()` line):
```ts
    onDeactivateQuery: vi.fn(),
    onReactivateQuery: vi.fn(),
    onBuyMoreSlots: vi.fn(),
```
and change `onUpgrade: vi.fn()` — signature widening doesn't need a test change since `vi.fn()` accepts any args.

In `web/src/i18n.test.ts`, every state object literal that includes `billing: null` and a `queries: [...]` array with `QuerySummary` objects needs `active: true` added to each query object (the type now requires it) — search for `status:` inside query literals in that file and add `active: true` alongside each one it finds.

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run render.test.ts i18n.test.ts`
Expected: FAIL — new selectors don't exist yet; `active` missing causes TS errors surfaced as test-file compile failures.

- [ ] **Step 3: Implement — update `WorkspaceHandlers`**

In `web/src/render.ts`, update the interface:
```ts
export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string) => void;
  onStartEdit: (queryId: string) => void;
  onToggleEditEvent: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (queryId: string, patch: { text: string; recurrenceInterval: RecurrenceInterval }) => void;
  onDeleteQuery: (queryId: string) => void;
  onDeactivateQuery: (queryId: string) => void;
  onReactivateQuery: (queryId: string) => void;
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
  onUpgrade: (quantity: number) => void;
  onManageBilling: () => void;
  onBuyMoreSlots: (count: number) => void;
  onSetAdminModel: (id: string, patch: { enabled?: boolean; role?: 'default' | 'backup' | null }) => void;
  onAddAdminModel: (id: string, providerID: string) => void;
}
```

- [ ] **Step 4: Add the blocked card and pause/resume to `renderQueryCard`**

In `web/src/render.ts`, add a new branch right after the existing `running` branch (before the `failed` branch) inside `renderQueryCard`:

```ts
  if (query.status === 'blocked') {
    return `
      <article class="query-card query-card-blocked" data-id="${query.id}">
        <div class="query-card-head">
          <span class="query-card-text">${escapeHtml(query.text)}</span>
          <div class="query-card-actions">
            <button type="button" class="link-button" data-action="edit">${t('queryCard.edit')}</button>
            <button type="button" class="link-button link-button-danger" data-action="delete">${t('queryCard.delete')}</button>
          </div>
        </div>
        <p class="subtext">${t('queryCard.blocked')}</p>
        <div class="edit-actions">
          <button class="stamp-button stamp-button-quiet" type="button" data-action="retry">${t('queryCard.retry')}</button>
          <button class="stamp-button" type="button" data-action="buy-credits">${t('queryCard.buyCredits')}</button>
        </div>
      </article>
    `;
  }
```

Then in the final (`ready`) branch, add a pause/resume button next to `delete` in `query-card-actions`, and a "Paused" indicator when `!query.active`:

```ts
  const pauseResumeAction = query.active
    ? `<button type="button" class="link-button" data-action="pause">${t('queryCard.pause')}</button>`
    : `<button type="button" class="link-button" data-action="resume">${t('queryCard.resume')}</button>`;
  return `
    <article class="query-card ${query.active ? '' : 'query-card-paused'}" data-id="${query.id}">
      <div class="query-card-head">
        <span class="query-card-text">${escapeHtml(query.text)}</span>
        <div class="query-card-actions">
          ${reviewAction}
          ${pauseResumeAction}
          <button type="button" class="link-button" data-action="edit">${t('queryCard.edit')}</button>
          <button type="button" class="link-button link-button-danger" data-action="delete">${t('queryCard.delete')}</button>
        </div>
      </div>
      ${!query.active ? `<p class="subtext">${t('queryCard.paused')}</p>` : ''}
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
```

(This replaces the existing final `return` block's opening `<article>` tag and `query-card-actions` div — the ledger rows below are unchanged, only the head changed.)

- [ ] **Step 5: Wire the new buttons in `renderDashboard`**

In `web/src/render.ts`, in `renderDashboard`, add alongside the existing `data-action=retry` wiring:

```ts
  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=pause]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onDeactivateQuery(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=resume]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onReactivateQuery(button.closest<HTMLElement>('.query-card')!.dataset.id!);
    });
  });

  wrapper.querySelectorAll<HTMLButtonElement>('.query-card button[data-action=buy-credits]').forEach(button => {
    button.addEventListener('click', () => {
      handlers.onUpgrade(1);
    });
  });
```

- [ ] **Step 6: Rewrite `renderBillingRow`**

Replace the function:

```ts
function renderBillingRow(billing: BillingStatus | null, handlers: WorkspaceHandlers): string {
  if (!billing) return '';
  const usage = t('billing.usage', { used: billing.activeQueryCount, purchased: billing.purchasedSlots });
  const perQuery = t('billing.perQuery', { price: billing.pricePerExtraQuery });
  if (billing.subscribed) {
    return `
      <p class="subtext">${usage} · ${perQuery}</p>
      <div class="billing-actions">
        <button type="button" class="stamp-button stamp-button-quiet" data-action="manage-billing">${t('billing.manage')}</button>
        <button type="button" class="stamp-button" data-action="buy-more">${t('billing.buyMore')}</button>
      </div>`;
  }
  return `
    <p class="subtext">${usage} · ${perQuery}</p>
    <button type="button" class="stamp-button stamp-button-quiet" data-action="upgrade">${t('billing.upgrade')}</button>`;
}
```

- [ ] **Step 7: Update the `upgrade`/add `buy-more` wiring in `renderDashboard`**

Replace the existing upgrade wiring:
```ts
  wrapper.querySelector<HTMLButtonElement>('button[data-action=upgrade]')?.addEventListener('click', () => {
    handlers.onUpgrade(1);
  });

  wrapper.querySelector<HTMLButtonElement>('button[data-action=buy-more]')?.addEventListener('click', () => {
    handlers.onBuyMoreSlots(1);
  });
```

(A quantity stepper input is deliberately out of scope for this pass — both buttons default to buying 1 slot at a time, matching the "keep it simple" posture of every other dashboard action. Note this explicitly if the user wants a real stepper later.)

- [ ] **Step 8: Fix `i18n.test.ts`'s query fixtures**

Add `active: true` to every `QuerySummary`-shaped object literal in `web/src/i18n.test.ts` found in Step 1.

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd web && npx vitest run`
Expected: PASS, full suite (all pre-existing tests plus the new ones from this task and Task 13).

- [ ] **Step 10: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts web/src/i18n.test.ts
git commit -m "feat(web): blocked/paused query cards, pause/resume actions, slot-usage billing row"
```

---

## Task 16: `main.ts` — wire the new handlers end to end

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Import the new API functions**

Add `deactivateQuery, reactivateQuery, addSlots,` to the import from `./api` at the top of `web/src/main.ts`.

- [ ] **Step 2: Replace `onUpgrade` and add the three new handlers**

In `web/src/main.ts`'s `paint()`, replace:
```ts
    onUpgrade: () => {
      clearError();
      startCheckout();
    },
```
with:
```ts
    onUpgrade: quantity => {
      clearError();
      startCheckout(quantity);
    },
```

Add near `onDeleteQuery`:
```ts
    onDeactivateQuery: queryId => {
      clearError();
      deactivateQuery(queryId)
        .then(() => refreshDashboard())
        .catch(err => showError('error.pausing', err));
    },
    onReactivateQuery: queryId => {
      clearError();
      reactivateQuery(queryId)
        .then(() => refreshDashboard())
        .catch(err => showError('error.resuming', err));
    },
```

Add near `onManageBilling`:
```ts
    onBuyMoreSlots: count => {
      clearError();
      addSlots(count)
        .then(() => refreshDashboard())
        .catch(err => showError('error.updatingSlots', err));
    },
```

- [ ] **Step 3: Also send blocked/reactivate 409s to checkout, matching the existing 402 pattern**

The `onSubmitQuery` handler already special-cases `ApiError` with `status === 402` by starting checkout — that path no longer fires (creation never 402s now), so it's dead code. Remove it:

```ts
    onSubmitQuery: text => {
      clearError();
      submitQuery(text)
        .then(() => refreshDashboard())
        .catch(err => showError('error.searching', err));
    },
```

Also drop the now-unused `ApiError` import if nothing else in the file references it — check with `grep -n "ApiError" web/src/main.ts` first; `onDeactivateQuery`/`onReactivateQuery` above catch generically via `err`, not `ApiError`, so it's likely safe to remove from the import list. If any other handler still uses `ApiError` (e.g. distinguishing status codes), keep the import and only remove the dead 402 branch.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev` (from `web/`) alongside the backend dev server, sign in, create two queries as a free-tier user, confirm the second renders as blocked with working "Try again"/"Buy credits" buttons, confirm pause/resume on a ready query removes/restores it from a freshly-fetched `/f/*.ics` response. This is a UI feature — do not report it complete without having actually clicked through it once.

- [ ] **Step 5: Run the full frontend suite one more time**

Run: `cd web && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.ts
git commit -m "feat(web): wire pause/resume/buy-more handlers, drop dead 402-to-checkout path"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** every bullet in the design doc's "Decided model" and every row of its "API surface" table maps to a task above. The "Out of scope" section (prepaid packs, auto-resume, split search/extraction, portal-only downgrade UI) has no corresponding task, by design.
- **Two refinements beyond the literal spec text**, both necessary for correctness and called out in Global Constraints: delete decrements by exactly one rather than recomputing from active count (Task 9), and the webhook now mirrors `stripe_subscription_quantity` from Stripe rather than only from the app's own writes (Task 10).
- **Type consistency check:** `hasFreeSlot`/`claimSlotForQuery` names and signatures are identical everywhere they're declared (Tasks 2, 4) and consumed (Tasks 3, 4, 6). `BillingStatus.purchasedSlots` is declared once (Task 10, backend; Task 13, frontend) and consumed once (Task 15's `renderBillingRow`). `WorkspaceHandlers.onUpgrade` signature change (Task 15) and its only call site (Task 16) agree on `(quantity: number) => void`.
