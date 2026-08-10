import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';
import {
  createQueryWithCandidates,
  listQueriesForUser,
  updateQuery,
} from './queriesRepo.js';
import { approveEvents } from './approveEvents.js';
import { DEFAULT_RECURRENCE_INTERVAL, isRecurrenceInterval, type ExtractedEvent } from '../types.js';

export interface QueryRouteDeps {
  db: Db;
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
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
      const events = await deps.runQuery(text);
      const { queryId, candidates } = await createQueryWithCandidates(
        deps.db,
        request.userId!,
        text,
        events,
        interval ?? DEFAULT_RECURRENCE_INTERVAL
      );
      return reply.send({ queryId, candidates });
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

  app.post<{ Params: { id: string }; Body: { eventIds: string[] } }>(
    '/api/queries/:id/approve',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const result = await approveEvents(
        deps.db,
        request.userId!,
        request.params.id,
        request.body?.eventIds ?? [],
        deps.publicBaseUrl
      );
      if (!result) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(result);
    }
  );
}