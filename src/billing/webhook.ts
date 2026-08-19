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
