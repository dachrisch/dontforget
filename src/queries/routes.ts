import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import {
  claimSlotForQuery,
  createQuery,
  deleteQuery,
  getQueryEvents,
  listQueriesForUser,
  updateQuery,
} from './queriesRepo.js';
import { approveEvents } from './approveEvents.js';
import { rotateFeedToken } from '../feed/feedToken.js';
import { buildFeedUrls } from '../feed/feedUrl.js';
import { enqueueSearch } from './searchQueue.js';
import { runInitialQuery } from './initialRun.js';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  isRecurrenceInterval,
  type ExtractionResult,
  type QueryStatus,
} from '../types.js';
import { hasFreeSlot, type BillingService } from '../billing/billingService.js';

export interface QueryRouteDeps {
  db: Db;
  runQuery: (query: string) => Promise<ExtractionResult>;
  requireAuth: preHandlerHookHandler;
  publicBaseUrl: string;
  billingService: BillingService;
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
      // Searching is free — the query is always saved. Whether it actually
      // runs (and occupies a paid slot) depends on capacity right now.
      const active = await hasFreeSlot(deps.db, request.userId!);
      const query = await createQuery(deps.db, request.userId!, text, interval ?? DEFAULT_RECURRENCE_INTERVAL, active);
      if (active) {
        enqueueSearch(() => runInitialQuery(deps.db, query, { runQuery: deps.runQuery, applyCadence: interval === undefined }));
      }
      return reply.code(202).send({ queryId: query.queryId });
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

  app.post<{
    Params: { id: string };
    Body: { eventIds: string[]; dismissEventIds?: string[]; recurrenceInterval?: string };
  }>(
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
        interval,
        request.body?.dismissEventIds ?? []
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

  // Re-runs a query's search in the background — used by the dashboard's
  // "Try again" action on a failed card. Accepts any non-running query (a
  // ready query can be searched on demand too); running ones are rejected so
  // we never stack a second search on top of one in flight.
  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/run',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const row = await deps.db
        .collection<{ _id: ObjectId; user_id: string; query_text: string; status?: QueryStatus; active?: boolean }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (row.status === 'running') {
        return reply.code(409).send({ error: 'already running' });
      }
      // Retry (this route) and reactivate are separate, non-overlapping
      // operations — retry must never double as resume. A paused ready/
      // failed query (active === false, status !== 'blocked') has to go
      // through reactivate first; only a blocked query (which never held a
      // slot) claims one here.
      if (row.active === false && row.status !== 'blocked') {
        return reply.code(409).send({ error: 'query is paused', reason: 'resume this query first' });
      }
      if (row.status === 'blocked') {
        const hasSlot = await hasFreeSlot(deps.db, request.userId!);
        const claimed = hasSlot && (await claimSlotForQuery(deps.db, request.userId!, row._id));
        if (!claimed) {
          return reply.code(409).send({ error: 'no free credits', reason: 'no free credits — buy more or pause another query' });
        }
      }
      await deps.db.collection('queries').updateOne({ _id: row._id }, { $set: { status: 'running' as const } });
      enqueueSearch(() =>
        runInitialQuery(deps.db, { _id: row._id, query_text: row.query_text }, { runQuery: deps.runQuery, applyCadence: false })
      );
      return reply.code(202).send({ queryId: row._id.toString() });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/deactivate',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const result = await deps.db.collection('queries').findOneAndUpdate(
        { _id: queryObjectId, user_id: request.userId!, active: { $ne: false }, status: { $ne: 'running' } },
        { $set: { active: false } }
      );
      if (!result) {
        const exists = await deps.db.collection('queries').findOne({ _id: queryObjectId, user_id: request.userId! });
        if (!exists) return reply.code(403).send({ error: 'not your query' });
        return reply.code(409).send({ error: 'cannot pause a running search' });
      }
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/reactivate',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const row = await deps.db
        .collection<{ _id: ObjectId; user_id: string; status?: QueryStatus; active?: boolean }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (row.status === 'blocked') {
        return reply.code(409).send({ error: 'blocked queries use retry, not reactivate' });
      }
      if (row.active !== false) {
        return reply.code(409).send({ error: 'query is already active' });
      }
      const hasSlot = await hasFreeSlot(deps.db, request.userId!);
      const claimed = hasSlot && (await claimSlotForQuery(deps.db, request.userId!, row._id));
      if (!claimed) {
        return reply.code(409).send({ error: 'no free credits', reason: 'no free credits — buy more or pause another query' });
      }
      return reply.code(204).send();
    }
  );

  app.post(
    '/api/feed/rotate',
    { preHandler: deps.requireAuth },
    async request => {
      const token = await rotateFeedToken(deps.db, request.userId!);
      return buildFeedUrls(deps.publicBaseUrl, token);
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
      // A blocked or already-paused query never occupied a purchased slot,
      // so deleting one must not release one either — mirrors "deactivating
      // never touches billing".
      if (deleted.active) {
        await deps.billingService.releaseSlotOnDelete(request.userId!);
      }
      return reply.code(204).send();
    }
  );
}