import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';
import {
  createQueryWithCandidates,
  deleteQuery,
  getQueryEvents,
  listQueriesForUser,
  updateQuery,
} from './queriesRepo.js';
import { approveEvents } from './approveEvents.js';
import { rotateFeedToken } from '../feed/feedToken.js';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  isRecurrenceInterval,
  type ExtractionResult,
} from '../types.js';

export interface QueryRouteDeps {
  db: Db;
  runQuery: (query: string) => Promise<ExtractionResult>;
  requireAuth: preHandlerHookHandler;
  publicBaseUrl: string;
}

export function registerQueryRoutes(app: FastifyInstance, deps: QueryRouteDeps): void {
  app.post<{ Body: { text: string; recurrenceInterval?: string } }>(
    '/api/queries',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) {
        return reply.code(400).send({ error: 'text is required' });
      }
      const interval = request.body?.recurrenceInterval;
      if (interval !== undefined && !isRecurrenceInterval(interval)) {
        return reply.code(400).send({ error: 'invalid recurrenceInterval' });
      }
      const { events, cadence } = await deps.runQuery(text);
      // The user picks the cadence on the review screen after the query
      // returns — until then, prefer the AI's suggestion, then the client's
      // explicit choice, then the default.
      const storedInterval = interval ?? cadence ?? DEFAULT_RECURRENCE_INTERVAL;
      const { queryId, candidates } = await createQueryWithCandidates(
        deps.db,
        request.userId!,
        text,
        events,
        storedInterval
      );
      return reply.send({ queryId, candidates, suggestedInterval: cadence });
    }
  );

  app.get(
    '/api/queries',
    { preHandler: deps.requireAuth },
    async request => listQueriesForUser(deps.db, request.userId!, deps.publicBaseUrl)
  );

  app.patch<{ Params: { id: string }; Body: { text?: string; recurrenceInterval?: string } }>(
    '/api/queries/:id',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.recurrenceInterval !== undefined && !isRecurrenceInterval(body.recurrenceInterval)) {
        return reply.code(400).send({ error: 'invalid recurrenceInterval' });
      }
      if (body.text !== undefined && !body.text.trim()) {
        return reply.code(400).send({ error: 'text must not be empty' });
      }

      const updated = await updateQuery(deps.db, request.userId!, request.params.id, {
        text: body.text,
        recurrenceInterval: body.recurrenceInterval,
      });
      if (!updated) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(updated);
    }
  );

  app.post<{ Params: { id: string }; Body: { eventIds: string[]; recurrenceInterval?: string } }>(
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
        interval
      );
      if (!result) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(result);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/queries/:id/events',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const events = await getQueryEvents(deps.db, request.userId!, request.params.id);
      if (!events) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(events);
    }
  );

  app.post(
    '/api/feed/rotate',
    { preHandler: deps.requireAuth },
    async request => {
      const token = await rotateFeedToken(deps.db, request.userId!);
      return {
        icsUrl: `${deps.publicBaseUrl}/f/${token}.ics`,
        rssUrl: `${deps.publicBaseUrl}/f/${token}.rss`,
      };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/queries/:id',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const deleted = await deleteQuery(deps.db, request.userId!, request.params.id);
      if (!deleted) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.code(204).send();
    }
  );
}