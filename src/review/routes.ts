import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { handleReviewCallback, reviewConfirmationHtml } from './reviewCallback.js';

export interface ReviewRouteDeps {
  db: Db;
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  // Token-gated (no session): the unguessable per-event token in the URL is
  // the auth, same as magic-link callbacks. Calendar clients open this in a
  // browser, so it renders a confirmation page rather than JSON.
  app.get<{ Querystring: { token?: string; action?: string } }>(
    '/api/review/callback',
    async (request, reply) => {
      const { token, action } = request.query ?? {};
      if (typeof token !== 'string' || !token || typeof action !== 'string' || !action) {
        return reply
          .code(400)
          .header('Content-Type', 'text/html; charset=utf-8')
          .send(reviewConfirmationHtml({ ok: false, reason: 'invalid-or-used' }));
      }
      const result = await handleReviewCallback(deps.db, token, action);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      if (!result.ok) {
        return reply.code(400).send(reviewConfirmationHtml(result));
      }
      return reply.send(reviewConfirmationHtml(result));
    }
  );
}
