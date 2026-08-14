# Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake saved queries back up on their own recurrence interval, auto-add new dates to already-trusted feeds, surface new candidates for never-approved queries, and email the user either way.

**Architecture:** A daily `setInterval` loop inside the existing backend process (`src/scheduler/scheduler.ts`) finds due queries (`src/scheduler/dueQueries.ts`), and for each one runs the existing search orchestrator, dedupes against everything already stored for that query, writes new events as `approved` (trusted queries) or `candidate` (never-approved queries), and emails the user (`src/scheduler/scheduledRun.ts`). Wired into `src/server.ts`'s `main()` only — `buildApp()` and its tests never see it.

**Tech Stack:** TypeScript, Fastify, MongoDB driver, Vitest. No new dependencies.

## Global Constraints

- No new npm dependency — the scheduler is a plain `setInterval`, not `node-cron` or an external trigger.
- Every saved query is re-run on schedule regardless of approval history (never-approved queries still get checked; results land as `candidate`).
- A query is "trusted" if it has ≥1 `approved` event at the moment its re-run is processed; trusted queries get new distinct events inserted directly as `approved`.
- Dedup new results against everything already stored for that `query_id` (any status), not just within one run's batch.
- Email fires in both the trusted (auto-added) and untrusted (needs review) case, once per query per run, via the existing `EmailSender`. No email when a run finds nothing new.
- `last_run_at` updates on any completed attempt (including zero-new-events) but **not** on a per-query error — that query retries on the next daily tick.
- One query's failure (orchestrator error) must not stop the rest of the day's batch; processing is sequential, no concurrency cap.
- Default recurrence interval changes from `monthly` to `weekly`, both in `src/types.ts` and in `web/src/render.ts`'s two hardcoded call sites.
- Spec: `docs/superpowers/specs/2026-08-14-scheduler-design.md`.

## Test setup (once per session)

Backend tests hit a real MongoDB — nothing is mocked at the DB layer. Before running any backend test in this plan:

```bash
./scripts/spinup_test_db.sh
export TEST_DATABASE_URL="mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27018/dontforget-test"
```

Backend tests: `npm test` (from repo root). Frontend tests: `cd web && npm test` (no DB needed). Single file: `npx vitest run src/path/to.test.ts`.

---

### Task 1: Default recurrence interval changes from monthly to weekly

**Files:**
- Modify: `src/types.ts:28`
- Modify: `web/src/render.ts:108`, `web/src/render.ts:270`
- Test: `src/queries/queriesRepo.test.ts:41-47`, `web/src/render.test.ts:54`

**Interfaces:**
- Produces: `DEFAULT_RECURRENCE_INTERVAL: RecurrenceInterval = 'weekly'` (was `'monthly'`) — consumed by `createQueryWithCandidates` (existing) and by Task 4's `findDueQueries`.

- [ ] **Step 1: Update the two existing tests to expect `weekly`**

In `src/queries/queriesRepo.test.ts`, change the test at line 41:

```ts
    it('defaults to weekly and stamps the first run as the last run', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

      const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
      expect(row?.recurrence_interval).toBe('weekly');
      expect(row?.last_run_at).toBeInstanceOf(Date);
    });
```

In `web/src/render.test.ts`, change line 54:

```ts
    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich', 'weekly');
```

- [ ] **Step 2: Run both to verify they fail**

Run: `npm test -- queriesRepo` (from repo root) — expect the renamed test to FAIL with `expected 'monthly' to be 'weekly'`.
Run: `cd web && npm test -- render` — expect FAIL with `expected "monthly" to be "weekly"`. `cd ..` back to repo root after.

- [ ] **Step 3: Change the default**

In `src/types.ts:28`:

```ts
export const DEFAULT_RECURRENCE_INTERVAL: RecurrenceInterval = 'weekly';
```

In `web/src/render.ts:108` (inside `renderEmpty`):

```ts
    handlers.onSubmitQuery(text, 'weekly');
```

In `web/src/render.ts:270` (inside `renderDashboard`):

```ts
        ${renderIntervalSelect('recurrenceInterval', 'weekly')}
```

- [ ] **Step 4: Run both to verify they pass**

Run: `npm test -- queriesRepo` — expect PASS.
Run: `cd web && npm test -- render` — expect PASS. `cd ..` back to repo root.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts web/src/render.ts src/queries/queriesRepo.test.ts web/src/render.test.ts
git commit -m "feat: default new queries to weekly re-runs instead of monthly"
```

---

### Task 2: Recurrence due-date math

**Files:**
- Create: `src/scheduler/recurrence.ts`
- Test: `src/scheduler/recurrence.test.ts`

**Interfaces:**
- Consumes: `RecurrenceInterval` from `../types.js` (existing).
- Produces: `nextRunAt(lastRunAt: Date, interval: RecurrenceInterval): Date`, `isDue(lastRunAt: Date, interval: RecurrenceInterval, now: Date): boolean` — both consumed by Task 4 (`dueQueries.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/recurrence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextRunAt, isDue } from './recurrence';

describe('nextRunAt', () => {
  it('adds 7 days for weekly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'weekly')).toEqual(new Date('2026-08-08T00:00:00Z'));
  });

  it('adds 1 calendar month for monthly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'monthly')).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('adds 3 calendar months for quarterly', () => {
    expect(nextRunAt(new Date('2026-01-15T00:00:00Z'), 'quarterly')).toEqual(new Date('2026-04-15T00:00:00Z'));
  });

  it('adds 1 calendar year for yearly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'yearly')).toEqual(new Date('2027-08-01T00:00:00Z'));
  });

  it('rolls over into the following month when the day does not exist there (native Date behavior)', () => {
    // Jan 31 + 1 month: February 2026 only has 28 days, so this lands on
    // March 3rd, not February 28th or 31st. Documented, not "fixed" —
    // last_run_at inherits the rolled-over date, so the next cycle repeats
    // from March 3rd rather than drifting further.
    expect(nextRunAt(new Date('2026-01-31T00:00:00Z'), 'monthly')).toEqual(new Date('2026-03-03T00:00:00Z'));
  });
});

describe('isDue', () => {
  it('is not due one day before the interval elapses', () => {
    const lastRunAt = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-07T00:00:00Z');
    expect(isDue(lastRunAt, 'weekly', now)).toBe(false);
  });

  it('is due exactly when the interval elapses', () => {
    const lastRunAt = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-08T00:00:00Z');
    expect(isDue(lastRunAt, 'weekly', now)).toBe(true);
  });

  it('is due well after the interval elapses', () => {
    const lastRunAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-08-01T00:00:00Z');
    expect(isDue(lastRunAt, 'monthly', now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler/recurrence.test.ts`
Expected: FAIL — `Cannot find module './recurrence'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/recurrence.ts`:

```ts
import type { RecurrenceInterval } from '../types.js';

type IntervalUnit = 'date' | 'month' | 'year';

const INTERVAL_STEP: Record<RecurrenceInterval, { amount: number; unit: IntervalUnit }> = {
  weekly: { amount: 7, unit: 'date' },
  monthly: { amount: 1, unit: 'month' },
  quarterly: { amount: 3, unit: 'month' },
  yearly: { amount: 1, unit: 'year' },
};

export function nextRunAt(lastRunAt: Date, interval: RecurrenceInterval): Date {
  const next = new Date(lastRunAt);
  const { amount, unit } = INTERVAL_STEP[interval];
  if (unit === 'date') next.setDate(next.getDate() + amount);
  else if (unit === 'month') next.setMonth(next.getMonth() + amount);
  else next.setFullYear(next.getFullYear() + amount);
  return next;
}

export function isDue(lastRunAt: Date, interval: RecurrenceInterval, now: Date): boolean {
  return nextRunAt(lastRunAt, interval).getTime() <= now.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scheduler/recurrence.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/recurrence.ts src/scheduler/recurrence.test.ts
git commit -m "feat: add recurrence due-date math for the scheduler"
```

---

### Task 3: Dedup filter against existing events

**Files:**
- Create: `src/scheduler/dedupeEvents.ts`
- Test: `src/scheduler/dedupeEvents.test.ts`

**Interfaces:**
- Consumes: `ExtractedEvent` from `../types.js` (existing).
- Produces: `interface ExistingEventKey { label: string; start_date: string; end_date: string }`, `filterNewEvents(candidates: ExtractedEvent[], existing: ExistingEventKey[]): ExtractedEvent[]` — consumed by Task 6 (`scheduledRun.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/dedupeEvents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterNewEvents } from './dedupeEvents';

describe('filterNewEvents', () => {
  it('drops a candidate matching an existing event on label, start, and end date', () => {
    const candidates = [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ label: 'Frühjahrsdult', start_date: '2026-04-11', end_date: '2026-05-11' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });

  it('keeps a candidate that differs in any of label, start date, or end date', () => {
    const candidates = [
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ label: 'Jakobidult', start_date: '2026-07-24', end_date: '2026-08-03' }];

    expect(filterNewEvents(candidates, existing)).toEqual(candidates);
  });

  it('returns every candidate unchanged when nothing exists yet', () => {
    const candidates = [
      { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
    ];
    expect(filterNewEvents(candidates, [])).toEqual(candidates);
  });

  it('ignores source URL when matching, so the same event from a different page still dedups', () => {
    const candidates = [
      { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://different-page.example' },
    ];
    const existing = [{ label: 'Oktoberfest', start_date: '2026-09-19', end_date: '2026-10-04' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler/dedupeEvents.test.ts`
Expected: FAIL — `Cannot find module './dedupeEvents'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/dedupeEvents.ts`:

```ts
import type { ExtractedEvent } from '../types.js';

export interface ExistingEventKey {
  label: string;
  start_date: string;
  end_date: string;
}

export function filterNewEvents(
  candidates: ExtractedEvent[],
  existing: ExistingEventKey[]
): ExtractedEvent[] {
  const seen = new Set(existing.map(e => `${e.label}|${e.start_date}|${e.end_date}`));
  return candidates.filter(event => !seen.has(`${event.label}|${event.startDate}|${event.endDate}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scheduler/dedupeEvents.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/dedupeEvents.ts src/scheduler/dedupeEvents.test.ts
git commit -m "feat: add dedup filter for scheduled re-run results"
```

---

### Task 4: Due-query finder

**Files:**
- Create: `src/scheduler/dueQueries.ts`
- Test: `src/scheduler/dueQueries.test.ts`

**Interfaces:**
- Consumes: `isDue` from `./recurrence.js` (Task 2), `RecurrenceInterval`, `DEFAULT_RECURRENCE_INTERVAL` from `../types.js` (existing).
- Produces: `interface DueQuery { _id: ObjectId; user_id: string; query_text: string; recurrence_interval: RecurrenceInterval }`, `findDueQueries(db: Db, now: Date): Promise<DueQuery[]>` — consumed by Task 6 and Task 7.

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/dueQueries.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { findDueQueries } from './dueQueries';

describe('findDueQueries', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'h@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  async function backdateLastRunAt(queryId: string, daysAgo: number): Promise<void> {
    const lastRunAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { last_run_at: lastRunAt } });
  }

  it('returns a weekly query whose last run was more than a week ago', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [], 'weekly');
    await backdateLastRunAt(queryId, 8);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString())).toEqual([queryId]);
    expect(due[0]).toEqual({
      _id: new ObjectId(queryId),
      user_id: userId,
      query_text: 'Auer Dult Munich',
      recurrence_interval: 'weekly',
    });
  });

  it('does not return a weekly query whose last run was recent', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [], 'weekly');
    await backdateLastRunAt(queryId, 2);

    const due = await findDueQueries(db, new Date());

    expect(due).toEqual([]);
  });

  it('respects a monthly query’s longer interval', async () => {
    const { queryId: dueOne } = await createQueryWithCandidates(db, userId, 'Due monthly', [], 'monthly');
    await backdateLastRunAt(dueOne, 40);
    const { queryId: notDueOne } = await createQueryWithCandidates(db, userId, 'Not due monthly', [], 'monthly');
    await backdateLastRunAt(notDueOne, 10);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString())).toEqual([dueOne]);
  });

  it('returns due queries regardless of which user owns them', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'i@example.com' });
    const otherUserId = insertedId.toString();
    const { queryId: mine } = await createQueryWithCandidates(db, userId, 'Mine', [], 'weekly');
    const { queryId: theirs } = await createQueryWithCandidates(db, otherUserId, 'Theirs', [], 'weekly');
    await backdateLastRunAt(mine, 8);
    await backdateLastRunAt(theirs, 8);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString()).sort()).toEqual([mine, theirs].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler/dueQueries.test.ts`
Expected: FAIL — `Cannot find module './dueQueries'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/dueQueries.ts`:

```ts
import { ObjectId, type Db } from 'mongodb';
import { DEFAULT_RECURRENCE_INTERVAL, type RecurrenceInterval } from '../types.js';
import { isDue } from './recurrence.js';

export interface DueQuery {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval: RecurrenceInterval;
}

interface QueryRow {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval?: RecurrenceInterval;
  last_run_at?: Date | null;
}

export async function findDueQueries(db: Db, now: Date): Promise<DueQuery[]> {
  const rows = await db.collection<QueryRow>('queries').find().toArray();

  return rows
    .filter(row => row.last_run_at != null)
    .filter(row => isDue(row.last_run_at as Date, row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL, now))
    .map(row => ({
      _id: row._id,
      user_id: row.user_id,
      query_text: row.query_text,
      recurrence_interval: row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scheduler/dueQueries.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/dueQueries.ts src/scheduler/dueQueries.test.ts
git commit -m "feat: find queries due for a scheduled re-run"
```

---

### Task 5: Dedup index migration

**Files:**
- Create: `src/migrations/003_events_dedup_index.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/migrate.test.ts`

**Interfaces:**
- Produces: a compound index `events { query_id: 1, label: 1, start_date: 1, end_date: 1 }`, applied automatically by the existing `runMigrations(db)` — no new exported function.

- [ ] **Step 1: Update the failing test**

In `src/db/migrate.test.ts`, change the `firstRun` and `secondRun` assertions:

```ts
    const firstRun = await runMigrations(db);
    expect(firstRun).toEqual(['001_init.ts', '002_queries_dashboard.ts', '003_events_dedup_index.ts']);
```

And add an index assertion after the existing `queriesIndexes` block:

```ts
    const eventsIndexes = await db.collection('events').indexes();
    expect(eventsIndexes.map(i => i.name)).toEqual(
      expect.arrayContaining(['query_id_1', 'query_id_1_status_1', 'query_id_1_label_1_start_date_1_end_date_1'])
    );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: FAIL — `firstRun` only contains two entries, and `query_id_1_label_1_start_date_1_end_date_1` is missing.

- [ ] **Step 3: Write the migration and register it**

Create `src/migrations/003_events_dedup_index.ts`:

```ts
import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // The scheduler dedups a query's re-run results against everything
  // already stored for it (any status) by (label, start_date, end_date) —
  // this index makes that lookup an index scan instead of a full scan of
  // the query's events as event volume grows.
  await db.collection('events').createIndex({ query_id: 1, label: 1, start_date: 1, end_date: 1 });
}
```

In `src/db/migrate.ts`, add the import and registry entry:

```ts
import type { Db } from 'mongodb';
import { migrate as migrate001 } from '../migrations/001_init.js';
import { migrate as migrate002 } from '../migrations/002_queries_dashboard.js';
import { migrate as migrate003 } from '../migrations/003_events_dedup_index.js';

interface Migration {
  name: string;
  migrate: (db: Db) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  { name: '001_init.ts', migrate: migrate001 },
  { name: '002_queries_dashboard.ts', migrate: migrate002 },
  { name: '003_events_dedup_index.ts', migrate: migrate003 },
];
```

(Leave the rest of `migrate.ts` — the `runMigrations` function body — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/003_events_dedup_index.ts src/db/migrate.ts src/db/migrate.test.ts
git commit -m "feat: add compound index for scheduler event dedup lookups"
```

---

### Task 6: Scheduled run — per-query orchestration

**Files:**
- Create: `src/scheduler/scheduledRun.ts`
- Test: `src/scheduler/scheduledRun.test.ts`

**Interfaces:**
- Consumes: `DueQuery` from `./dueQueries.js` (Task 4), `filterNewEvents`, `ExistingEventKey` from `./dedupeEvents.js` (Task 3), `EmailSender` from `../email/EmailSender.js` (existing), `ExtractedEvent` from `../types.js` (existing).
- Produces: `interface ScheduledRunDeps { runQuery: (query: string) => Promise<ExtractedEvent[]>; emailSender: EmailSender; publicBaseUrl: string }`, `runScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void>` — consumed by Task 7 and Task 8.

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/scheduledRun.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { approveEvents } from '../queries/approveEvents';
import { CapturingEmailSender } from '../email/EmailSender';
import { runScheduledQuery, type ScheduledRunDeps } from './scheduledRun';
import type { DueQuery } from './dueQueries';

describe('runScheduledQuery', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;
  let userEmail: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    userEmail = 'j@example.com';
    const { insertedId } = await db.collection('users').insertOne({ email: userEmail });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  function dueQueryFrom(queryId: string, queryText: string): DueQuery {
    return { _id: new ObjectId(queryId), user_id: userId, query_text: queryText, recurrence_interval: 'weekly' };
  }

  it('auto-approves new events for a trusted query and emails an FYI', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);
    await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000');

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue([
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
        { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
      ]),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(2); // the original approved one + the one genuinely new one
    const jakobidult = events.find(e => e.label === 'Jakobidult');
    expect(jakobidult?.status).toBe('approved');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe(userEmail);
    expect(emailSender.sent[0].subject).toMatch(/added to your feed/);

    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).toBeInstanceOf(Date);
  });

  it('lands new events as candidates for a never-approved query and emails a review prompt', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue([
        { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
      ]),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Oktoberfest'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('candidate');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].subject).toMatch(/go review/);
  });

  it('does not re-insert an event that already exists, and sends no email when nothing is new', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);
    // Backdate so a real update is distinguishable from the value
    // createQueryWithCandidates already stamped at creation.
    const staleLastRunAt = new Date('2020-01-01T00:00:00Z');
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { last_run_at: staleLastRunAt } });

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue([
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a-different-page.example' },
      ]),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    expect(emailSender.sent).toHaveLength(0);

    // last_run_at still advances on a "found nothing new" run — only an
    // orchestrator error (tested below) leaves it untouched.
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).not.toEqual(staleLastRunAt);
  });

  it('does not update last_run_at when the orchestrator throws', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);
    const before = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });

    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockRejectedValue(new Error('searxng is down')),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
    };

    await expect(runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps)).rejects.toThrow(
      'searxng is down'
    );

    const after = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(after?.last_run_at).toEqual(before?.last_run_at);
  });

  it('still writes events and updates last_run_at when the email fails to send', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue([
        { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
      ]),
      emailSender: { send: vi.fn().mockRejectedValue(new Error('smtp down')) },
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Oktoberfest'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler/scheduledRun.test.ts`
Expected: FAIL — `Cannot find module './scheduledRun'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/scheduledRun.ts`:

```ts
import { ObjectId, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender.js';
import type { ExtractedEvent } from '../types.js';
import type { DueQuery } from './dueQueries.js';
import { filterNewEvents, type ExistingEventKey } from './dedupeEvents.js';

export interface ScheduledRunDeps {
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

interface ExistingEventRow extends ExistingEventKey {
  status: 'candidate' | 'approved';
}

export async function runScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void> {
  const existingEvents = await db
    .collection<ExistingEventRow>('events')
    .find({ query_id: query._id })
    .toArray();

  const extracted = await deps.runQuery(query.query_text);
  const newEvents = filterNewEvents(extracted, existingEvents);

  if (newEvents.length > 0) {
    const isTrusted = existingEvents.some(e => e.status === 'approved');
    const status = isTrusted ? 'approved' : 'candidate';
    const insertedAt = new Date();

    await db.collection('events').insertMany(
      newEvents.map(event => ({
        _id: new ObjectId(),
        query_id: query._id,
        label: event.label,
        start_date: event.startDate,
        end_date: event.endDate,
        source_url: event.sourceUrl,
        status,
        created_at: insertedAt,
      }))
    );

    await sendReRunEmail(db, query, newEvents.length, isTrusted, deps);
  }

  await db.collection('queries').updateOne({ _id: query._id }, { $set: { last_run_at: new Date() } });
}

async function sendReRunEmail(
  db: Db,
  query: DueQuery,
  count: number,
  isTrusted: boolean,
  deps: ScheduledRunDeps
): Promise<void> {
  try {
    const user = await db
      .collection<{ _id: ObjectId; email: string }>('users')
      .findOne({ _id: new ObjectId(query.user_id) });
    if (!user) return;

    const plural = count === 1 ? '' : 's';
    const subject = isTrusted
      ? `${count} new date${plural} added to your feed`
      : `${count} new date${plural} found — go review`;
    const body = isTrusted
      ? `"${query.query_text}" found ${count} new date${plural}, already added to your feed.\n\n${deps.publicBaseUrl}`
      : `"${query.query_text}" found ${count} new date${plural} awaiting your review.\n\n${deps.publicBaseUrl}`;

    await deps.emailSender.send(user.email, subject, body);
  } catch (err) {
    console.error(`Failed to send re-run email for query ${query._id.toString()}:`, err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scheduler/scheduledRun.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduledRun.ts src/scheduler/scheduledRun.test.ts
git commit -m "feat: process one due query's re-run (dedup, trust, email)"
```

---

### Task 7: Scheduler loop

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Test: `src/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `DueQuery`, `findDueQueries` from `./dueQueries.js` (Task 4), `ScheduledRunDeps`, `runScheduledQuery` from `./scheduledRun.js` (Task 6).
- Produces: `interface SchedulerCollaborators { findDueQueries: (db: Db, now: Date) => Promise<DueQuery[]>; runScheduledQuery: (db: Db, query: DueQuery, deps: ScheduledRunDeps) => Promise<void> }`, `startScheduler(db: Db, deps: ScheduledRunDeps, intervalMs?: number, collaborators?: SchedulerCollaborators): { stop: () => void }` — consumed by Task 8 (`server.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/scheduler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { startScheduler, type SchedulerCollaborators } from './scheduler';
import type { DueQuery } from './dueQueries';
import type { ScheduledRunDeps } from './scheduledRun';

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const db = {} as Db;
  const deps: ScheduledRunDeps = {
    runQuery: vi.fn(),
    emailSender: { send: vi.fn() },
    publicBaseUrl: 'http://localhost:3000',
  };

  it('checks for due queries immediately on start, then again every interval', async () => {
    const findDueQueries = vi.fn().mockResolvedValue([]);
    const runScheduledQuery = vi.fn();
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);
    expect(findDueQueries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(findDueQueries).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(findDueQueries).toHaveBeenCalledTimes(2);
  });

  it('runs every due query returned by the finder', async () => {
    const due: DueQuery[] = [
      { _id: new ObjectId(), user_id: 'u1', query_text: 'A', recurrence_interval: 'weekly' },
      { _id: new ObjectId(), user_id: 'u2', query_text: 'B', recurrence_interval: 'weekly' },
    ];
    const findDueQueries = vi.fn().mockResolvedValue(due);
    const runScheduledQuery = vi.fn().mockResolvedValue(undefined);
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);

    expect(runScheduledQuery).toHaveBeenCalledTimes(2);
    expect(runScheduledQuery).toHaveBeenNthCalledWith(1, db, due[0], deps);
    expect(runScheduledQuery).toHaveBeenNthCalledWith(2, db, due[1], deps);
    stop();
  });

  it('logs and continues past one query failing, instead of stopping the batch', async () => {
    const due: DueQuery[] = [
      { _id: new ObjectId(), user_id: 'u1', query_text: 'A', recurrence_interval: 'weekly' },
      { _id: new ObjectId(), user_id: 'u2', query_text: 'B', recurrence_interval: 'weekly' },
    ];
    const findDueQueries = vi.fn().mockResolvedValue(due);
    const runScheduledQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);

    expect(runScheduledQuery).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler/scheduler.test.ts`
Expected: FAIL — `Cannot find module './scheduler'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/scheduler.ts`:

```ts
import type { Db } from 'mongodb';
import { findDueQueries as defaultFindDueQueries, type DueQuery } from './dueQueries.js';
import { runScheduledQuery as defaultRunScheduledQuery, type ScheduledRunDeps } from './scheduledRun.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerCollaborators {
  findDueQueries: (db: Db, now: Date) => Promise<DueQuery[]>;
  runScheduledQuery: (db: Db, query: DueQuery, deps: ScheduledRunDeps) => Promise<void>;
}

const defaultCollaborators: SchedulerCollaborators = {
  findDueQueries: defaultFindDueQueries,
  runScheduledQuery: defaultRunScheduledQuery,
};

export function startScheduler(
  db: Db,
  deps: ScheduledRunDeps,
  intervalMs: number = ONE_DAY_MS,
  collaborators: SchedulerCollaborators = defaultCollaborators
): { stop: () => void } {
  async function tick(): Promise<void> {
    const due = await collaborators.findDueQueries(db, new Date());
    for (const query of due) {
      try {
        await collaborators.runScheduledQuery(db, query, deps);
      } catch (err) {
        console.error(`Scheduled run failed for query ${query._id.toString()}:`, err);
      }
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scheduler/scheduler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts
git commit -m "feat: add the daily scheduler loop"
```

---

### Task 8: Wire the scheduler into the running server

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `startScheduler` from `./scheduler/scheduler.js` (Task 7).
- No automated test — `server.ts`'s `main()` is DI composition only and has no existing test file (matches `app.test.ts`, which tests `buildApp()` directly instead). Verified manually in Step 3.

- [ ] **Step 1: Extract `publicBaseUrl` to a shared variable and start the scheduler**

In `src/server.ts`, replace the inline `publicBaseUrl` in the `buildApp()` call with a shared `const`, and start the scheduler right after `buildApp()`:

```ts
import { buildApp } from './app.js';
import { createClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { SmtpEmailSender, ConsoleEmailSender, type EmailSender } from './email/EmailSender.js';
import { searxngSearch } from './search/searxngClient.js';
import { extractDates } from './search/opencodeClient.js';
import { createSearchOrchestrator } from './search/searchOrchestrator.js';
import { startScheduler } from './scheduler/scheduler.js';
import nodemailer from 'nodemailer';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const client = await createClient(process.env.DATABASE_URL!);
  const db = client.db();
  await runMigrations(db);

  const emailSender: EmailSender = process.env.SMTP_HOST
    ? new SmtpEmailSender(
        nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        }),
        process.env.SMTP_FROM ?? 'dontforget@lehel.xyz'
      )
    : new ConsoleEmailSender(); // dev fallback — prints the magic link to stdout

  const runQuery = createSearchOrchestrator({
    searxngSearch: query =>
      searxngSearch(process.env.SEARXNG_BASE_URL!, query, process.env.SEARXNG_TOKEN!),
    extractDates: (query, results) =>
      extractDates(process.env.OPENCODE_BASE_URL!, process.env.OPENCODE_API_KEY!, query, results),
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

  const app = buildApp({
    db,
    emailSender,
    publicBaseUrl,
    // In production the backend serves the built frontend itself (below),
    // so the magic-link callback redirect stays same-origin ('/'). In dev
    // the frontend is a separate Vite server — redirect there instead, or
    // the callback 404s trying to GET '/' on a backend that has no such
    // route outside production.
    frontendUrl: process.env.FRONTEND_URL ?? (isProduction ? '/' : 'http://localhost:5173'),
    runQuery,
  });

  startScheduler(db, { runQuery, emailSender, publicBaseUrl });

  if (isProduction) {
    app.register(fastifyStatic, {
      root: join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'),
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the whole backend**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify manually with the dev server**

```bash
npm run dev
```

Expected in the log output: no scheduler-related errors on startup (the immediate `tick()` runs `findDueQueries` against your dev DB — with no saved queries yet, it finds none and does nothing further). To see it actually process a query, first submit one via the running frontend, then in `mongosh` backdate its `last_run_at`:

```js
db.queries.updateOne({}, { $set: { last_run_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
```

Restart `npm run dev` (the scheduler's immediate on-start tick picks it up right away rather than waiting a day) and confirm in the log / your console-logged email output that a re-run happened.

- [ ] **Step 4: Run the full backend test suite**

Run: `npm test`
Expected: all tests pass (this task adds no new test file, but confirms nothing upstream broke).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: start the scheduler when the server boots"
```
