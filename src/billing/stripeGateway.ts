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
