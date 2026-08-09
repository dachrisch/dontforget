import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { createQueryWithCandidates } from './queriesRepo';
import { approveEvents } from './approveEvents';
import type { ExtractedEvent } from '../types';
import type { preHandlerHookHandler } from 'fastify';

export interface QueryRouteDeps {
  db: Db;
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
  requireAuth: preHandlerHookHandler;
  publicBaseUrl: string;
}

export function registerQueryRoutes(app: FastifyInstance, deps: QueryRouteDeps): void {
  app.post<{ Body: { text: string } }>(
    '/api/queries',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) {
        return reply.code(400).send({ error: 'text is required' });
      }
      const events = await deps.runQuery(text);
      const { queryId, candidates } = await createQueryWithCandidates(
        deps.db,
        request.userId!,
        text,
        events
      );
      return reply.send({ queryId, candidates });
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
        request.body.eventIds ?? [],
        deps.publicBaseUrl
      );
      if (!result) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(result);
    }
  );
}