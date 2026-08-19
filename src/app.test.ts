import { describe, it, expect } from 'vitest';
import { buildApp } from './app';
import { CapturingEmailSender } from './email/EmailSender';
import { FakeBillingGateway } from './billing/stripeGateway';
import { BillingService } from './billing/billingService';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = await buildApp({
      db: {} as any,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});