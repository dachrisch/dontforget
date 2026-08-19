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
        return reply.redirect(url, 303);
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
        return reply.redirect(url, 303);
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
