import { ObjectId, type Db } from 'mongodb';
import type Stripe from 'stripe';
import type { BillingGateway } from './stripeGateway.js';
import { BillingUnavailableError } from './stripeGateway.js';

export const FREE_QUERY_LIMIT = 1;
export const PRICE_PER_EXTRA_QUERY_EUR = 0.5;

export interface BillingStatus {
  freeLimit: number;
  activeQueryCount: number;
  purchasedSlots: number;
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
      purchasedSlots: await getPurchasedSlots(this.db, userId),
      pricePerExtraQuery: PRICE_PER_EXTRA_QUERY_EUR,
      subscribed: isSubscribed(user),
      subscriptionStatus: user.stripe_subscription_status ?? null,
      checkoutUrl: '/api/billing/checkout',
      portalUrl: '/api/billing/portal',
    };
  }

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

  async createPortalSession(userId: string, returnUrl: string): Promise<{ url: string }> {
    const user = await this.requireUser(userId);
    const customerId = await this.getOrCreateCustomerId(user);
    return this.gateway.createPortalSession({ customerId, returnUrl });
  }

  async releaseSlotOnDelete(userId: string): Promise<void> {
    const user = await this.db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
    if (!user?.stripe_subscription_id) return;
    const current = user.stripe_subscription_quantity ?? FREE_QUERY_LIMIT;
    const next = Math.max(1, current - 1);
    await this.setSubscriptionQuantity(user, next);
  }

  async addSlots(userId: string, count: number): Promise<number> {
    const user = await this.requireUser(userId);
    if (!user.stripe_subscription_id) {
      throw new BillingUnavailableError();
    }
    const current = user.stripe_subscription_quantity ?? FREE_QUERY_LIMIT;
    const next = current + count;
    await this.setSubscriptionQuantity(user, next);
    return next;
  }

  async verifyWebhook(payload: string, signature: string, secret: string): Promise<Stripe.Event> {
    return this.gateway.verifyWebhookSignature({ payload, signature, secret });
  }

  async processEvent(event: Stripe.Event): Promise<void> {
    const alreadyProcessed = await this.db.collection('stripe_events').findOne({ _id: event.id } as any);
    if (alreadyProcessed) return; // already processed — Stripe retries deliveries, skip the replay

    const object = event.data.object as {
      customer?: string;
      subscription?: string;
      subscription_status?: string;
      status?: string;
      items?: { data?: Array<{ quantity?: number }> };
    };
    const customerId = object.customer;
    if (customerId) {
      const update = this.db.collection<UserRow>('users');
      switch (event.type) {
        case 'checkout.session.completed':
          if (object.subscription) {
            // getSubscriptionQuantity is a real Stripe API call and can fail transiently.
            // The idempotency claim below only runs once this — and the update — succeed,
            // so a failure here leaves the event unclaimed and Stripe's retry can complete it.
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
    }

    // Claim idempotency only after the work above has actually succeeded. All the
    // updateOne calls above are idempotent (they set fields to freshly computed/read
    // values), so safely re-running this whole method on a genuine Stripe retry is fine —
    // what must never happen is marking an event processed before its work completed.
    try {
      await this.db.collection('stripe_events').insertOne({ _id: event.id } as any);
    } catch {
      // a concurrent delivery of the same event already claimed it — ignore.
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

  // Callers must have already confirmed user.stripe_subscription_id is set.
  private async setSubscriptionQuantity(user: UserRow, quantity: number): Promise<void> {
    await this.gateway.updateSubscriptionQuantity({ subscriptionId: user.stripe_subscription_id!, quantity });
    await this.db.collection('users').updateOne({ _id: user._id }, { $set: { stripe_subscription_quantity: quantity } });
  }
}
