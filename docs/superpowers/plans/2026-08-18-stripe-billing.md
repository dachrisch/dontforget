# Stripe Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on the decided pricing — 1 free query per account, €0.50/query after that, billed on active query count — via Stripe Checkout + Customer Portal, with the backend as the only credentialed component (no card data ever touches our servers).

**Source:** Internal memo "Stripe integration — pick a path" (2026-08-11, monetization pass). Pricing is locked there; this plan is the build. Sequencing gate from that memo is satisfied: the scheduler shipped in v0.11.0, so recurring re-runs already exist behind the paywall.

**Architecture:** One Stripe **graduated-tiered monthly Price** — first unit free, every further unit €0.50 — referenced by env var `STRIPE_PRICE_ID`. The subscription's **quantity is kept equal to the account's active query count**; Stripe computes the bill, dontforget only syncs the quantity. A `BillingService` (`src/billing/billingService.ts`) sits over a thin `BillingGateway` interface (`src/billing/stripeGateway.ts`) so routes and webhooks are testable with a fake — mirroring the existing `EmailSender`/`CapturingEmailSender` DI pattern. Free tier is enforced server-side: creating a 2nd query without an active subscription returns `402` *before* the search runs (so we never burn searxng/opencode on a query that can't be created). Checkout/Portal redirects live in `src/billing/routes.ts`; the signature-verified webhook lives in `src/billing/webhook.ts`; quantity sync hooks into `src/queries/routes.ts` on create/delete.

**Tech Stack:** TypeScript, Fastify, MongoDB driver, Vitest, the official `stripe` npm SDK. One new dependency (`stripe`); everything else already exists.

## Global Constraints

- **Cadence: monthly** (decided 2026-08-18). The code is cadence-agnostic — the Price ID comes from `STRIPE_PRICE_ID`, so switching to annual later is a config change, not a code change.
- **Pricing:** 1 free query per account; €0.50/query after that; billed on active query count; the graduated tiered Price makes unit #1 free automatically.
- **No card data on our servers.** Checkout and Customer Portal handle all PCI. The backend only ever sees Stripe object IDs (`cus_…`, `sub_…`).
- **Free tier is a hard server-side gate.** A user with no active subscription and ≥1 existing query gets `402` on `POST /api/queries`, checked **before** `runQuery` is called.
- **Quantity sync:** after every create and delete, if the user has a subscription, set quantity = `max(1, activeQueryCount)`. Clamp keeps live-mode Stripe happy (qty 0 is test-mode-only); the first tier is free anyway.
- **Webhook is signature-verified and idempotent.** Uses `STRIPE_WEBHOOK_SECRET`; duplicates are deduped by event id in a `stripe_events` collection. No configured secret → `503`.
- **New dependency:** `stripe` (official SDK). The scheduler's "no new dependencies" constraint does not apply here — there is no sane way to talk to Stripe Checkout/PHP-free without it.
- **Users collection gains billing fields** (`stripe_customer_id`, `stripe_subscription_id`, `stripe_subscription_status`), written by service code at use time, not by a data backfill.
- **Scheduler-side enforcement is out of scope for v1.** A lapsed subscription stops *new* queries but does not stop the scheduler from re-running existing ones. Documented as a follow-up, matching the memo's sequencing posture.
- **Stripe config comes from env, never committed.** Dev uses test-mode keys (`sk_test_…`, `whsec_…`).

## One-time prerequisites (Stripe dashboard — not code)

Do these once before Task 4's manual verification (or hand them to whoever owns the Stripe account):

1. Create a **graduated-tiered monthly recurring Price**: tier 1 `up_to = 1`, price €0.00; tier 2 `up_to = inf`, price €0.50. Note the Price ID (`price_…`).
2. Add a webhook endpoint → `https://<host>/api/billing/webhook` subscribing to `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Note the signing secret (`whsec_…`).
3. For local dev, run `stripe listen --forward-to localhost:3000/api/billing/webhook` and export the returned `whsec_…`.

## Test setup (once per session)

Backend tests hit a real MongoDB — nothing is mocked at the DB layer. Before running any backend test in this plan:

```bash
./scripts/spinup_test_db.sh
export TEST_DATABASE_URL="mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27018/dontforget-test"
```

Backend tests: `npm test` (from repo root). Frontend tests: `cd web && npm test` (no DB needed). Single file: `npx vitest run src/path/to.test.ts`.

---

### Task 1: Migration 004 — billing fields and webhook idempotency store

**Files:**
- Create: `src/migrations/004_billing_users.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/migrate.test.ts`
- Modify: `src/testSupport.ts` (add `stripe_events` to the wipe list)

**Interfaces:**
- Produces: a sparse unique index `users { stripe_customer_id: 1 }` (lookup by customer id in webhook handlers), the `stripe_events` collection (event-id idempotency), both applied by the existing `runMigrations(db)` — no new exported function.

- [ ] **Step 1: Update the failing test**

In `src/db/migrate.test.ts`:
- Change the `firstRun` assertion to `['001_init.ts', '002_queries_dashboard.ts', '003_events_dedup_index.ts', '004_billing_users.ts']`.
- Add `'stripe_events'` to the `collections` arrayContaining list.
- After the `eventsIndexes` block, add:

```ts
    const usersIndexes = await db.collection('users').indexes();
    expect(usersIndexes.map(i => i.name)).toEqual(expect.arrayContaining(['email_1', 'stripe_customer_id_1']));
```

In `src/testSupport.ts`, add `'stripe_events'` to the `COLLECTIONS` const.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: FAIL — `firstRun` has three entries, `stripe_events` missing, `stripe_customer_id_1` missing.

- [ ] **Step 3: Write the migration and register it**

Create `src/migrations/004_billing_users.ts`:

```ts
import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // The billing webhook looks users up by Stripe customer id, and event ids
  // dedupe Stripe's retried webhook deliveries. Fields themselves are written
  // by service code at use time (Mongo is schemaless) — only the indexes and
  // the idempotency collection live here.
  await db.collection('users').createIndex({ stripe_customer_id: 1 }, { unique: true, sparse: true });
  await db.createCollection('stripe_events');
}
```

In `src/db/migrate.ts`, add the import and registry entry:

```ts
import { migrate as migrate004 } from '../migrations/004_billing_users.js';
// ...
  { name: '004_billing_users.ts', migrate: migrate004 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/004_billing_users.ts src/db/migrate.ts src/db/migrate.test.ts src/testSupport.ts
git commit -m "feat: add billing user index and webhook idempotency store"
```

---

### Task 2: Stripe dependency and BillingGateway

**Files:**
- Modify: `package.json` (add `stripe` via npm)
- Create: `src/billing/stripeGateway.ts`

**Interfaces:**
- Consumes: none (wraps the SDK).
- Produces: `interface CheckoutParams`, `interface BillingGateway` (createCustomer, createCheckoutSession, createPortalSession, updateSubscriptionQuantity, verifyWebhookSignature), `class StripeBillingGateway`, `class NullBillingGateway` (throws `BillingUnavailableError`), `class FakeBillingGateway` (test double with captured calls), `class BillingUnavailableError` — consumed by Task 3 and the manual verification step.

- [ ] **Step 1: Add the dependency**

Run: `npm install stripe`
Expected: `package.json` gains `"stripe": "^<current>"`; `package-lock.json` updates.

- [ ] **Step 2: Write the gateway**

Create `src/billing/stripeGateway.ts`:

```ts
import Stripe from 'stripe';

export interface CheckoutParams {
  customerId: string;
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalParams {
  customerId: string;
  returnUrl: string;
}

export interface QuantityUpdateParams {
  subscriptionId: string;
  quantity: number;
}

export class BillingUnavailableError extends Error {}

export interface BillingGateway {
  createCustomer(email: string): Promise<{ id: string }>;
  createCheckoutSession(params: CheckoutParams): Promise<{ url: string }>;
  createPortalSession(params: PortalParams): Promise<{ url: string }>;
  updateSubscriptionQuantity(params: QuantityUpdateParams): Promise<void>;
  verifyWebhookSignature(params: { payload: string; signature: string; secret: string }): Promise<Stripe.Event>;
}

export class StripeBillingGateway implements BillingGateway {
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async createCustomer(email: string): Promise<{ id: string }> {
    const customer = await this.stripe.customers.create({ email });
    return { id: customer.id };
  }

  async createCheckoutSession(params: CheckoutParams): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: params.customerId,
      line_items: [{ price: params.priceId, quantity: params.quantity }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });
    if (!session.url) throw new Error('checkout session returned no url');
    return { url: session.url };
  }

  async createPortalSession(params: PortalParams): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return { url: session.url };
  }

  async updateSubscriptionQuantity(params: QuantityUpdateParams): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(params.subscriptionId);
    const item = subscription.items.data[0];
    if (!item) throw new Error('subscription has no items');
    await this.stripe.subscriptionItems.update(item.id, { quantity: params.quantity });
  }

  async verifyWebhookSignature(params: { payload: string; signature: string; secret: string }): Promise<Stripe.Event> {
    return this.stripe.webhooks.constructEvent(params.payload, params.signature, params.secret);
  }
}

// Used when STRIPE config is absent (local dev, some tests): every call fails
// with a signal the routes turn into a 503 "billing unavailable".
export class NullBillingGateway implements BillingGateway {
  private unavailable(): never {
    throw new BillingUnavailableError();
  }
  createCustomer(): Promise<{ id: string }> { return Promise.resolve(this.unavailable()); }
  createCheckoutSession(): Promise<{ url: string }> { return Promise.resolve(this.unavailable()); }
  createPortalSession(): Promise<{ url: string }> { return Promise.resolve(this.unavailable()); }
  updateSubscriptionQuantity(): Promise<void> { return Promise.resolve(this.unavailable()); }
  verifyWebhookSignature(): Promise<Stripe.Event> { return Promise.resolve(this.unavailable()); }
}

// Test double — captured calls replace the network, mirroring
// CapturingEmailSender. Lives beside the real impl, same file.
export class FakeBillingGateway implements BillingGateway {
  public checkoutCalls: CheckoutParams[] = [];
  public portalCalls: PortalParams[] = [];
  public quantityUpdates: QuantityUpdateParams[] = [];
  public createdCustomers: string[] = [];
  public customerId = 'cus_test';
  public checkoutUrl = 'https://checkout.stripe.test/session';
  public portalUrl = 'https://billing.stripe.test/portal';
  public signatureValid = true;
  public queuedEvent: Stripe.Event | null = null;

  async createCustomer(email: string): Promise<{ id: string }> {
    this.createdCustomers.push(email);
    return { id: this.customerId };
  }

  async createCheckoutSession(params: CheckoutParams): Promise<{ url: string }> {
    this.checkoutCalls.push(params);
    return { url: this.checkoutUrl };
  }

  async createPortalSession(params: PortalParams): Promise<{ url: string }> {
    this.portalCalls.push(params);
    return { url: this.portalUrl };
  }

  async updateSubscriptionQuantity(params: QuantityUpdateParams): Promise<void> {
    this.quantityUpdates.push(params);
  }

  async verifyWebhookSignature(): Promise<Stripe.Event> {
    if (!this.signatureValid) throw new Error('invalid signature');
    if (!this.queuedEvent) throw new Error('no queued event');
    return this.queuedEvent;
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors (the `stripe` types resolve now that the package is installed).

- [ ] **Step 4: Commit**

```bash
git add src/billing/stripeGateway.ts package.json package-lock.json
git commit -m "feat: add Stripe gateway abstraction and SDK dependency"
```

---

### Task 3: BillingService — entitlement, checkout, sync, webhook events

**Files:**
- Create: `src/billing/billingService.ts`
- Test: `src/billing/billingService.test.ts`

**Interfaces:**
- Consumes: `BillingGateway`, `FakeBillingGateway` from `./stripeGateway.js` (Task 2).
- Produces: `FREE_QUERY_LIMIT`, `PRICE_PER_EXTRA_QUERY_EUR`, `interface BillingStatus`, `countActiveQueries(db, userId)`, `isOverFreeLimit(db, userId)`, `isSubscribed(user)` (`stripe_subscription_status === 'active'`), `class BillingService` with `getStatus`, `createCheckoutSession`, `createPortalSession`, `syncQuantity`, `processEvent` — consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `src/billing/billingService.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { FakeBillingGateway } from './stripeGateway';
import { BillingService, isOverFreeLimit } from './billingService';

describe('BillingService', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;
  let service: BillingService;
  let userId: string;

  async function insertUser(overrides: Record<string, unknown> = {}): Promise<string> {
    const { insertedId } = await db.collection('users').insertOne({ email: 'b@example.com', ...overrides });
    return insertedId.toString();
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    gateway = new FakeBillingGateway();
    service = new BillingService(db, gateway, 'price_graduated');
    userId = await insertUser();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('isOverFreeLimit: 0 and 1 queries are free, 2 are over', async () => {
    expect(await isOverFreeLimit(db, userId)).toBe(false);
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    expect(await isOverFreeLimit(db, userId)).toBe(false);
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'b' });
    expect(await isOverFreeLimit(db, userId)).toBe(true);
  });

  it('checkout creates and reuses one customer, starts at quantity 1, and persists the customer id', async () => {
    const { url } = await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(url).toBe(gateway.checkoutUrl);
    expect(gateway.createdCustomers).toEqual(['b@example.com']);
    expect(gateway.checkoutCalls).toHaveLength(1);
    expect(gateway.checkoutCalls[0].quantity).toBe(1);
    expect(gateway.checkoutCalls[0].priceId).toBe('price_graduated');

    await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(gateway.createdCustomers).toEqual(['b@example.com']); // no second customer
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_customer_id).toBe('cus_test');
  });

  it('checkout starts quantity at the active query count', async () => {
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'b' });
    await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(gateway.checkoutCalls[0].quantity).toBe(2);
  });

  it('syncQuantity is a no-op without a subscription', async () => {
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toHaveLength(0);
  });

  it('syncQuantity pushes the active count and clamps to 1', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_subscription_id: 'sub_1' } });
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toEqual([{ subscriptionId: 'sub_1', quantity: 1 }]);

    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toEqual([
      { subscriptionId: 'sub_1', quantity: 1 },
      { subscriptionId: 'sub_1', quantity: 1 },
    ]);
  });

  it('processEvent on checkout.session.completed stores the subscription as active', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_customer_id: 'cus_test' } });
    await service.processEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_test', subscription: 'sub_9', subscription_status: 'active' } },
    });
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_id).toBe('sub_9');
    expect(row?.stripe_subscription_status).toBe('active');
  });

  it('processEvent on customer.subscription.deleted clears the subscription', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_9', stripe_subscription_status: 'active' },
    });
    await service.processEvent({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_test' } },
    });
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_id).toBeUndefined();
    expect(row?.stripe_subscription_status).toBeUndefined();
  });

  it('processEvent ignores a duplicate event id', async () => {
    const event = { id: 'evt_dup', type: 'checkout.session.completed', data: { object: { customer: 'cus_test', subscription: 'sub_1', subscription_status: 'active' } } };
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_customer_id: 'cus_test' } });
    await service.processEvent(event);
    await service.processEvent(event);
    const events = await db.collection('stripe_events').countDocuments({ _id: 'evt_dup' });
    expect(events).toBe(1);
  });

  it('getStatus reports free-limit usage and subscription state', async () => {
    const free = await service.getStatus(userId);
    expect(free).toEqual({
      freeLimit: 1,
      activeQueryCount: 0,
      pricePerExtraQuery: 0.5,
      subscribed: false,
      subscriptionStatus: null,
      checkoutUrl: '/api/billing/checkout',
      portalUrl: '/api/billing/portal',
    });

    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active' },
    });
    const paid = await service.getStatus(userId);
    expect(paid.subscribed).toBe(true);
    expect(paid.subscriptionStatus).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/billing/billingService.test.ts`
Expected: FAIL — `Cannot find module './billingService'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/billing/billingService.ts`:

```ts
import { ObjectId, type Db } from 'mongodb';
import type Stripe from 'stripe';
import type { BillingGateway } from './stripeGateway.js';

export const FREE_QUERY_LIMIT = 1;
export const PRICE_PER_EXTRA_QUERY_EUR = 0.5;

export interface BillingStatus {
  freeLimit: number;
  activeQueryCount: number;
  pricePerExtraQuery: number;
  subscribed: boolean;
  subscriptionStatus: string | null;
  checkoutUrl: string;
  portalUrl: string;
}

interface UserRow {
  _id: ObjectId;
  email: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  stripe_subscription_status?: string;
}

export function countActiveQueries(db: Db, userId: string): Promise<number> {
  return db.collection('queries').countDocuments({ user_id: userId });
}

export function isOverFreeLimit(db: Db, userId: string): Promise<boolean> {
  return countActiveQueries(db, userId).then(count => count >= FREE_QUERY_LIMIT);
}

export function isSubscribed(user: Pick<UserRow, 'stripe_subscription_status'>): boolean {
  return user.stripe_subscription_status === 'active';
}

export class BillingService {
  constructor(
    private db: Db,
    private gateway: BillingGateway,
    private priceId: string
  ) {}

  async getStatus(userId: string): Promise<BillingStatus> {
    const user = await this.requireUser(userId);
    return {
      freeLimit: FREE_QUERY_LIMIT,
      activeQueryCount: await countActiveQueries(this.db, userId),
      pricePerExtraQuery: PRICE_PER_EXTRA_QUERY_EUR,
      subscribed: isSubscribed(user),
      subscriptionStatus: user.stripe_subscription_status ?? null,
      checkoutUrl: '/api/billing/checkout',
      portalUrl: '/api/billing/portal',
    };
  }

  async createCheckoutSession(userId: string, returnBaseUrl: string): Promise<{ url: string }> {
    const user = await this.requireUser(userId);
    const customerId = await this.getOrCreateCustomerId(user);
    const quantity = Math.max(1, await countActiveQueries(this.db, userId));
    return this.gateway.createCheckoutSession({
      customerId,
      priceId: this.priceId,
      quantity,
      successUrl: `${returnBaseUrl}/?checkout=success`,
      cancelUrl: returnBaseUrl,
    });
  }

  async createPortalSession(userId: string, returnUrl: string): Promise<{ url: string }> {
    const user = await this.requireUser(userId);
    if (!user.stripe_customer_id) throw new Error('no stripe customer');
    return this.gateway.createPortalSession({ customerId: user.stripe_customer_id, returnUrl });
  }

  async syncQuantity(userId: string): Promise<void> {
    const user = await this.db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
    if (!user?.stripe_subscription_id) return;
    const quantity = Math.max(1, await countActiveQueries(this.db, userId));
    await this.gateway.updateSubscriptionQuantity({ subscriptionId: user.stripe_subscription_id, quantity });
  }

  async processEvent(event: Stripe.Event): Promise<void> {
    try {
      await this.db.collection('stripe_events').insertOne({ _id: event.id });
    } catch {
      return; // already processed — Stripe retries deliveries, skip the replay
    }

    const object = event.data.object as { customer?: string; subscription?: string; subscription_status?: string; status?: string };
    const customerId = object.customer;
    if (!customerId) return;

    const update = this.db.collection<UserRow>('users');
    switch (event.type) {
      case 'checkout.session.completed':
        if (object.subscription) {
          await update.updateOne(
            { stripe_customer_id: customerId },
            { $set: { stripe_subscription_id: object.subscription, stripe_subscription_status: object.subscription_status ?? 'active' } }
          );
        }
        break;
      case 'customer.subscription.updated':
        await update.updateOne(
          { stripe_customer_id: customerId },
          { $set: { stripe_subscription_status: object.status ?? 'active' } }
        );
        break;
      case 'customer.subscription.deleted':
        await update.updateOne(
          { stripe_customer_id: customerId },
          { $unset: { stripe_subscription_id: '', stripe_subscription_status: '' } }
        );
        break;
    }
  }

  private async getOrCreateCustomerId(user: UserRow): Promise<string> {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const { id } = await this.gateway.createCustomer(user.email);
    await this.db.collection('users').updateOne({ _id: user._id }, { $set: { stripe_customer_id: id } });
    return id;
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
    if (!user) throw new Error('user not found');
    return user;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/billing/billingService.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/billing/billingService.ts src/billing/billingService.test.ts
git commit -m "feat: add billing service for checkout, portal, quantity sync, and webhook events"
```

---

### Task 4: Billing routes — checkout, portal, status

**Files:**
- Create: `src/billing/routes.ts`
- Test: `src/billing/routes.test.ts`
- Modify: `src/auth/session.test.ts` — no; no change. (Auth hook reused as-is.)

**Interfaces:**
- Consumes: `BillingService` (Task 3), `requireAuth` + `request.userId` from `src/auth/session.js` (existing).
- Produces: `registerBillingRoutes(app, deps: { billingService: BillingService; requireAuth: preHandlerHookHandler; publicBaseUrl: string })` — registers `POST /api/billing/checkout`, `GET /api/billing/portal`, `GET /api/billing/status` — consumed by Task 7 (`app.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/billing/routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { FakeBillingGateway, NullBillingGateway, BillingUnavailableError } from './stripeGateway';
import { BillingService } from './billingService';

describe('billing routes', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;

  async function appWith(gatewayOverride?: FakeBillingGateway | NullBillingGateway) {
    gateway = gatewayOverride ?? new FakeBillingGateway();
    return buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
      webhookSecret: 'whsec_test',
    });
  }

  async function signedInUser(): Promise<{ app: any; sessionId: string }> {
    const { insertedId } = await db.collection('users').insertOne({ email: 'c@example.com' });
    const sessionId = await new SessionService(db).createSession(insertedId.toString());
    const app = await appWith();
    return { app, sessionId };
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('POST /api/billing/checkout requires auth', async () => {
    const { app } = await signedInUser();
    const response = await app.inject({ method: 'POST', url: '/api/billing/checkout' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/billing/checkout redirects to Stripe', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(gateway.checkoutUrl);
  });

  it('GET /api/billing/portal redirects to the customer portal', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/portal',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(gateway.portalUrl);
  });

  it('GET /api/billing/status returns the quota payload', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/status',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freeLimit: 1, subscribed: false, activeQueryCount: 0 });
  });

  it('checkout returns 503 when billing is unavailable (no Stripe config)', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'd@example.com' });
    const sessionId = await new SessionService(db).createSession(insertedId.toString());
    const app = await appWith(new NullBillingGateway());
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(503);
    expect(BillingUnavailableError).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/billing/routes.test.ts`
Expected: FAIL — `Cannot find module './routes'` and `buildApp` rejects the new `billingService`/`webhookSecret` props (Task 7 wires them; see note below).

> Note: `buildApp` doesn't accept `billingService`/`webhookSecret` yet — Task 7 adds them. To keep tasks green end-to-end, either implement Task 7's `app.ts` wiring now, or defer this test file's Step 2 run until after Task 7. Recommended: write this test file in Task 4 but **run it only after Task 7**; the plan's Task 7 Step 2 runs the whole backend suite.

- [ ] **Step 3: Write the route implementation**

Create `src/billing/routes.ts`:

```ts
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { BillingService } from './billingService.js';
import { BillingUnavailableError } from './stripeGateway.js';

export interface BillingRouteDeps {
  billingService: BillingService;
  requireAuth: preHandlerHookHandler;
  publicBaseUrl: string;
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  app.post(
    '/api/billing/checkout',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      try {
        const { url } = await deps.billingService.createCheckoutSession(request.userId!, deps.publicBaseUrl);
        return reply.redirect(303, url);
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          return reply.code(503).send({ error: 'billing unavailable' });
        }
        throw err;
      }
    }
  );

  app.get(
    '/api/billing/portal',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      try {
        const { url } = await deps.billingService.createPortalSession(request.userId!, deps.publicBaseUrl);
        return reply.redirect(303, url);
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          return reply.code(503).send({ error: 'billing unavailable' });
        }
        throw err;
      }
    }
  );

  app.get(
    '/api/billing/status',
    { preHandler: deps.requireAuth },
    async request => deps.billingService.getStatus(request.userId!)
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/billing/routes.ts src/billing/routes.test.ts
git commit -m "feat: add billing checkout, portal, and status routes"
```

---

### Task 5: Webhook route — signature verification + event handling

**Files:**
- Create: `src/billing/webhook.ts`
- Test: `src/billing/webhook.test.ts`

**Interfaces:**
- Consumes: `BillingService.processEvent`, `verifyWebhookSignature` (Task 3), `BillingUnavailableError` (Task 2).
- Produces: `registerBillingWebhook(app, deps: { billingService: BillingService; webhookSecret?: string })` — a scoped plugin registering `POST /api/billing/webhook` with a raw-body JSON parser (Fastify's default parser discards the raw string Stripe's signature covers) — consumed by Task 7 (`app.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/billing/webhook.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { FakeBillingGateway } from './stripeGateway';
import { BillingService } from './billingService';

describe('POST /api/billing/webhook', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;
  let app: any;

  function event(id: string, type: string, object: Record<string, unknown>) {
    return { id, type, data: { object } };
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    gateway = new FakeBillingGateway();
    app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
      webhookSecret: 'whsec_test',
    });
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('updates the user on checkout.session.completed', async () => {
    await db.collection('users').insertOne({ email: 'w@example.com', stripe_customer_id: 'cus_w' });
    gateway.queuedEvent = event('evt_checkout', 'checkout.session.completed', {
      customer: 'cus_w',
      subscription: 'sub_w',
      subscription_status: 'active',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 't=1,v1=sig' },
      payload: JSON.stringify(gateway.queuedEvent),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const row = await db.collection('users').findOne({ email: 'w@example.com' });
    expect(row?.stripe_subscription_id).toBe('sub_w');
    expect(row?.stripe_subscription_status).toBe('active');
  });

  it('rejects a bad signature with 400', async () => {
    gateway.signatureValid = false;
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 't=1,v1=bogus' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 503 when no webhook secret is configured', async () => {
    const noSecretApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
    });
    const response = await noSecretApp.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 't=1,v1=sig' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(503);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run after Task 7 (same caveat as Task 4): `npx vitest run src/billing/webhook.test.ts`
Expected: FAIL — route not registered yet.

- [ ] **Step 3: Write the webhook implementation**

Create `src/billing/webhook.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { BillingService } from './billingService.js';
import { BillingUnavailableError } from './stripeGateway.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface BillingWebhookDeps {
  billingService: BillingService;
  webhookSecret?: string;
}

export function registerBillingWebhook(app: FastifyInstance, deps: BillingWebhookDeps): void {
  // Scoped plugin so the raw-body JSON parser only applies to the webhook
  // route — Stripe's signature covers the exact request body, so the default
  // parsed-and-re-serialized object would break verification.
  app.register(async instance => {
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      const raw = body as string;
      request.rawBody = raw;
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error);
      }
    });

    instance.post('/api/billing/webhook', async (request, reply) => {
      const secret = deps.webhookSecret;
      if (!secret) {
        return reply.code(503).send({ error: 'webhook not configured' });
      }
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string' || !signature) {
        return reply.code(400).send({ error: 'missing signature' });
      }
      let event;
      try {
        event = await deps.billingService.verifyWebhook(request.rawBody!, signature, secret);
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          return reply.code(503).send({ error: 'billing unavailable' });
        }
        return reply.code(400).send({ error: 'invalid signature' });
      }
      await deps.billingService.processEvent(event);
      return reply.send({ received: true });
    });
  });
}
```

> Note: `verifyWebhookSignature` currently takes `{ payload, signature, secret }`. The test's fake ignores args, but keep the service signature aligned: change Task 3's `BillingService.verifyWebhook` — either add the method to the service (delegating to `gateway.verifyWebhookSignature`) or call the gateway directly. If you add a service method, Task 3's `processEvent` stays unchanged; add:

```ts
  async verifyWebhook(payload: string, signature: string, secret: string): Promise<Stripe.Event> {
    return this.gateway.verifyWebhookSignature({ payload, signature, secret });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/billing/webhook.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/billing/webhook.ts src/billing/webhook.test.ts
git commit -m "feat: verify and handle Stripe webhook events"
```

---

### Task 6: Free-tier gate + quantity sync in query routes

**Files:**
- Modify: `src/queries/routes.ts`
- Modify: `src/queries/dashboardRoutes.test.ts`
- Modify: `src/queries/routes.test.ts`

**Interfaces:**
- Consumes: `isOverFreeLimit`, `isSubscribed`, `BillingService` from `../billing/billingService.js` (Task 3).
- Produces: `QueryRouteDeps.billingService: BillingService` (new required dep), 402 gate on `POST /api/queries`, `syncQuantity` on create and delete.

- [ ] **Step 1: Update `QueryRouteDeps` and add the gate**

In `src/queries/routes.ts`, add to imports:

```ts
import { isOverFreeLimit, isSubscribed, type BillingService } from '../billing/billingService.js';
import { ObjectId, type Db } from 'mongodb';
```

Add to `QueryRouteDeps`:

```ts
  billingService: BillingService;
```

In the `POST /api/queries` handler, immediately after the `recurrenceInterval` validation and **before** `await deps.runQuery(text)`:

```ts
      const user = await deps.db
        .collection<{ _id: ObjectId; stripe_subscription_status?: string }>('users')
        .findOne({ _id: new ObjectId(request.userId!) });
      if (user && (await isOverFreeLimit(deps.db, request.userId!)) && !isSubscribed(user)) {
        return reply.code(402).send({ error: 'free query limit reached', checkoutUrl: '/api/billing/checkout' });
      }
```

After the `createQueryWithCandidates` call, add:

```ts
      await deps.billingService.syncQuantity(request.userId!);
```

In the `DELETE /api/queries/:id` handler, after the `deleteQuery` call and before the `204`:

```ts
      await deps.billingService.syncQuantity(request.userId!);
```

- [ ] **Step 2: Update the failing tests**

In `src/queries/dashboardRoutes.test.ts`, extend `authenticatedUser` (and the three inline `buildApp` calls) with:

```ts
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
```

with matching imports (`FakeBillingGateway` from `../billing/stripeGateway`, `BillingService` from `../billing/billingService`).

Add new cases:

```ts
  it('POST /api/queries allows the first (free) query', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Oktoberfest' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('POST /api/queries returns 402 for a second query without a subscription', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().checkoutUrl).toBe('/api/billing/checkout');
  });

  it('POST /api/queries allows a second query for a subscribed user and syncs quantity', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('DELETE syncs the subscription quantity down', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);
  });
```

In `src/queries/routes.test.ts`, add `billingService` to the `buildApp` call (with `db: {} as any`, `new BillingService({} as any, new FakeBillingGateway(), 'price_graduated')`).

- [ ] **Step 3: Run the failing tests, then the full queries suite**

Run: `npx vitest run src/queries/dashboardRoutes.test.ts src/queries/routes.test.ts`
Expected after implementation: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/queries/routes.ts src/queries/dashboardRoutes.test.ts src/queries/routes.test.ts
git commit -m "feat: enforce the free query limit and sync subscription quantity"
```

---

### Task 7: Wire billing into the app and the server

**Files:**
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`
- Modify: `src/app.test.ts`
- Modify: `src/auth/routes.test.ts`

**Interfaces:**
- Consumes: `registerBillingRoutes`, `registerBillingWebhook` (Tasks 4–5).
- Produces: `AppDeps.billingService: BillingService`, `AppDeps.webhookSecret?: string`; `buildApp` registers billing routes and webhook. `server.ts` picks a real or null gateway from env.

- [ ] **Step 1: Extend `AppDeps` and register the routes**

In `src/app.ts`:

```ts
import { registerBillingRoutes } from './billing/routes.js';
import { registerBillingWebhook } from './billing/webhook.js';
import type { BillingService } from './billing/billingService.js';

export interface AppDeps {
  db: Db;
  emailSender: EmailSender;
  publicBaseUrl: string;
  frontendUrl: string;
  runQuery: (query: string) => Promise<ExtractionResult>;
  billingService: BillingService;
  webhookSecret?: string;
}
```

After `registerFeedRoutes(...)`:

```ts
  registerBillingRoutes(app, {
    billingService: deps.billingService,
    requireAuth,
    publicBaseUrl: deps.publicBaseUrl,
  });
  registerBillingWebhook(app, { billingService: deps.billingService, webhookSecret: deps.webhookSecret });
```

- [ ] **Step 2: Update every existing `buildApp` call site**

Add the two new props to `src/app.test.ts`, `src/auth/routes.test.ts`, `src/queries/routes.test.ts`, `src/queries/dashboardRoutes.test.ts` (the last one is done in Task 6):

```ts
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
```

- [ ] **Step 3: Wire `server.ts`**

```ts
import { StripeBillingGateway, NullBillingGateway } from './billing/stripeGateway.js';
import { BillingService } from './billing/billingService.js';
```

In `main()`, after the `publicBaseUrl` const:

```ts
  const billingEnabled = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
  const billingGateway = billingEnabled
    ? new StripeBillingGateway(process.env.STRIPE_SECRET_KEY!)
    : new NullBillingGateway();
  const billingService = new BillingService(
    db,
    billingGateway,
    billingEnabled ? process.env.STRIPE_PRICE_ID! : ''
  );
```

Pass into `buildApp`:

```ts
    billingService,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
```

- [ ] **Step 4: Update `.env.example`**

```bash
# Stripe billing (see docs/superpowers/plans/2026-08-18-stripe-billing.md).
# Test-mode keys in dev. STRIPE_PRICE_ID is the graduated tiered monthly
# price: 1 unit free, €0.50 per unit after that.
STRIPE_SECRET_KEY=
STRIPE_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
```

- [ ] **Step 5: Type-check and run the full backend suite**

Run: `npx tsc -p tsconfig.json --noEmit`
Run: `npm test`
Expected: all backend tests pass (now includes the Task 4 and Task 5 tests, which depend on this wiring).

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/server.ts .env.example src/app.test.ts src/auth/routes.test.ts
git commit -m "feat: wire Stripe billing routes and webhook into the app"
```

---

### Task 8: Frontend — billing row, upgrade/manage actions, 402 handling

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/state.ts`
- Modify: `web/src/main.ts`
- Modify: `web/src/render.ts`
- Modify: `web/src/i18n.ts`
- Modify: `web/src/render.test.ts`
- Modify: `web/src/state.test.ts`

**Interfaces:**
- Consumes: `GET /api/billing/status` (Task 4), `POST /api/billing/checkout` redirect (Task 4).
- Produces: `BillingStatus` type, `getBillingStatus()`, `startCheckout()`/`startPortal()` navigation helpers, dashboard billing row with Upgrade/Manage actions, and a redirect to checkout when a query create returns `402`.

- [ ] **Step 1: Types + API**

In `web/src/types.ts`:

```ts
export interface BillingStatus {
  freeLimit: number;
  activeQueryCount: number;
  pricePerExtraQuery: number;
  subscribed: boolean;
  subscriptionStatus: string | null;
  checkoutUrl: string;
  portalUrl: string;
}
```

In `web/src/api.ts`:

```ts
export async function getBillingStatus(): Promise<BillingStatus> {
  const response = await fetch('/api/billing/status', { credentials: 'include' });
  return handle(response);
}

export function startCheckout(): void {
  window.location.href = '/api/billing/checkout';
}

export function startPortal(): void {
  window.location.href = '/api/billing/portal';
}
```

- [ ] **Step 2: State**

In `web/src/state.ts`, add `billing: BillingStatus | null` to `DashboardState`; extend `DASHBOARD_LOADED` with `billing?: BillingStatus | null`; in the reducer set `billing: event.billing ?? null`. (Keep it optional so existing tests compile.)

- [ ] **Step 3: Handlers + main wiring**

In `web/src/render.ts`, add to `WorkspaceHandlers`:

```ts
  onUpgrade: () => void;
  onManageBilling: () => void;
```

Render a billing row inside the dashboard, below the feed section:

```ts
    <section class="billing-summary" aria-label="${t('billing.title')}">
      ${renderBillingRow(state.billing, handlers)}
    </section>
```

with:

```ts
function renderBillingRow(billing: BillingStatus | null, handlers: WorkspaceHandlers): string {
  if (!billing) return '';
  if (billing.subscribed) {
    return `<p class="subtext">${t('billing.subscribed', { count: billing.activeQueryCount })}</p>
      <button type="button" class="stamp-button stamp-button-quiet" data-action="manage-billing">${t('billing.manage')}</button>`;
  }
  return `<p class="subtext">${t('billing.freeLimit', {
    count: billing.freeLimit - billing.activeQueryCount,
  })} · ${t('billing.perQuery', { price: billing.pricePerExtraQuery })}</p>
    <button type="button" class="stamp-button stamp-button-quiet" data-action="upgrade">${t('billing.upgrade')}</button>`;
}
```

Wire the buttons in `renderDashboard` (mirroring the existing `data-action` pattern):

```ts
  wrapper.querySelector('button[data-action=upgrade]')?.addEventListener('click', () => handlers.onUpgrade());
  wrapper.querySelector('button[data-action=manage-billing]')?.addEventListener('click', () => handlers.onManageBilling());
```

In `web/src/main.ts`:
- import `getBillingStatus`, `startCheckout`, `startPortal`.
- in `refreshDashboard()` and the boot path, fetch billing alongside queries and pass it into `DASHBOARD_LOADED`.
- add handlers:

```ts
    onUpgrade: () => {
      clearError();
      startCheckout();
    },
    onManageBilling: () => {
      clearError();
      startPortal();
    },
```

- handle a 402 from `submitQuery` in the `.catch`:

```ts
        .catch(err => {
          if (err instanceof ApiError && err.status === 402) {
            startCheckout();
            return;
          }
          showError('error.searching', err);
          ...
        });
```

- [ ] **Step 4: i18n**

Add to both `EN` and `DE` in `web/src/i18n.ts`:

```ts
  'billing.title': 'Billing',
  'billing.upgrade': 'Upgrade',
  'billing.manage': 'Manage subscription',
  'billing.subscribed': 'Subscribed — {count} active query/queries',
  'billing.freeLimit': '{count} free query/queries remaining',
  'billing.perQuery': '{price} € per additional query',
```

(DE translations to taste, e.g. `'billing.title': 'Abrechnung'`, `'billing.upgrade': 'Upgrade'`, `'billing.manage': 'Abonnement verwalten'`, `'billing.subscribed': 'Abo aktiv — {count} aktive Suchanfragen'`, `'billing.freeLimit': '{count} kostenlose Suchanfrage/n übrig'`, `'billing.perQuery': '{price} € pro zusätzlicher Suchanfrage'`.)

- [ ] **Step 5: Update frontend tests**

- `web/src/state.test.ts`: `DASHBOARD_LOADED` now carries `billing`; the dashboard state shape assertion gains `billing: null`.
- `web/src/render.test.ts`: pass `billing` in dashboard fixtures; assert the upgrade button renders for a free-tier user and the manage button for a subscriber.
- `web/src/api.test.ts`: add `getBillingStatus` (mock `fetch` returning a status payload) if that file follows the fetch-mocking pattern.

- [ ] **Step 6: Run the frontend suite**

Run: `cd web && npm test`
Expected: PASS. `cd ..` back to repo root.

- [ ] **Step 7: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/state.ts web/src/main.ts web/src/render.ts web/src/i18n.ts web/src/render.test.ts web/src/state.test.ts web/src/api.test.ts
git commit -m "feat: surface billing status and upgrade/manage actions in the dashboard"
```

---

### Task 9: Docs and end-to-end verification

**Files:**
- Modify: `docs/design.md`
- Modify: `README.md` (optional)

**Interfaces:**
- None new — records the billing decision and the memo's two follow-up knobs.

- [ ] **Step 1: Record the billing decision in `docs/design.md`**

Add a short `## 9. Pricing & billing` section capturing: the decided model (1 free query, €0.50/query, graduated tiered Price, quantity = active queries, monthly cadence), the hard server-side gate, and the memo's follow-up knobs (annual cadence is a config swap; scheduler-side enforcement for lapsed subscriptions is out of scope; re-measure opencode per-call cost before free-model access looks shaky). Reference the plan file.

- [ ] **Step 2: Manual end-to-end smoke (test mode)**

With `stripe listen --forward-to localhost:3000/api/billing/webhook` running and test keys exported:

```bash
npm run dev
```

Walk through: sign in → create 1st query (200) → create 2nd query (frontend redirects to Stripe test Checkout) → complete the test checkout → Stripe redirects back with `?checkout=success` → create a 3rd query (200) → delete queries and confirm the quantity in `stripe dashboard` / logs tracks the count → open portal → cancel the subscription → confirm a subsequent create returns 402 again.

- [ ] **Step 3: Full verification**

Run: `npm test` (backend)
Run: `cd web && npm test` (frontend)
Run: `npx tsc -p tsconfig.json --noEmit`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/design.md README.md
git commit -m "docs: record the Stripe billing model and follow-ups"
```

---

## Open follow-ups (explicitly not in this plan)

- **Annual billing** — one env change (`STRIPE_PRICE_ID` → annual graduated Price) plus optionally setting annual as the portal default. Deliberately not built now (monthly chosen 2026-08-18).
- **Scheduler enforcement for lapsed subscriptions** — today a canceled subscription stops *new* queries but existing feeds keep re-running. Decide later whether the scheduler should pause non-subscribed users' re-runs.
- **Rate/cost guardrails** — the memo's "two things that could sink this" §04: re-measure opencode's real per-call cost when free-model access looks shaky; the €0.50 rate is the knob, not the model.
- **Tax/VAT** — Stripe handles tax on their dashboard settings; no code here.
