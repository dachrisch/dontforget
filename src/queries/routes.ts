import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import {
  completeSeriesExpansion,
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
import { getSeriesById, insertDiscoveredSeries, listSeriesForQuery, reviewSeries } from './seriesRepo.js';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  isRecurrenceInterval,
  type ExtractionResult,
  type QueryStatus,
  type SeriesExtractionResult,
} from '../types.js';
import type { SeriesScope } from '../search/opencodeClient.js';

export interface QueryRouteDeps {
  db: Db;
  runQuery: (query: string) => Promise<ExtractionResult>;
  // Stage-1 discovery (issue #143). When present, new queries and explicit
  // refreshes discover series; per-series expansion uses runSeriesExpansion
  // (series-scoped dates) and falls back to runQuery.
  discoverSeries?: (query: string) => Promise<SeriesExtractionResult>;
  runSeriesExpansion?: (series: SeriesScope) => Promise<ExtractionResult>;
  requireAuth: preHandlerHookHandler;
  publicBaseUrl: string;
}

// Expands one series into dates that are occurrences of what the series
// applies to. Prefers the series-scoped path; older callers without it fall
// back to the generic query path on the series' keywords.
async function expandSeries(
  deps: QueryRouteDeps,
  series: { title: string; appliesTo: string; description: string; searchKeywords: string }
): Promise<ExtractionResult> {
  if (deps.runSeriesExpansion) {
    return deps.runSeriesExpansion(series);
  }
  return deps.runQuery(series.searchKeywords);
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
      // The search runs in the background (searxng + opencode can take a
      // minute or more), so the request only creates the query row and
      // returns. The dashboard shows the running card and picks up the
      // results on its next poll.
      const query = await createQuery(deps.db, request.userId!, text, interval ?? DEFAULT_RECURRENCE_INTERVAL);
      enqueueSearch(() =>
        runInitialQuery(deps.db, query, {
          runQuery: deps.runQuery,
          discoverSeries: deps.discoverSeries,
          applyCadence: interval === undefined,
          userId: request.userId!,
        })
      );
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
        .collection<{ _id: ObjectId; user_id: string; query_text: string; status?: QueryStatus }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (row.status === 'running') {
        return reply.code(409).send({ error: 'already running' });
      }
      await deps.db.collection('queries').updateOne({ _id: row._id }, { $set: { status: 'running' as const } });
      enqueueSearch(() =>
        runInitialQuery(
          deps.db,
          { _id: row._id, query_text: row.query_text },
          { runQuery: deps.runQuery, discoverSeries: deps.discoverSeries, applyCadence: false, userId: request.userId! }
        )
      );
      return reply.code(202).send({ queryId: row._id.toString() });
    }
  );

  // Series review (issue #143): one row per discovered series (title,
  // one-line description, 1-2 example sources), not hundreds of dated rows.
  app.get<{ Params: { id: string } }>(
    '/api/queries/:id/series',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const series = await listSeriesForQuery(deps.db, request.userId!, request.params.id);
      if (!series) {
        return reply.code(403).send({ error: 'not your query' });
      }
      return reply.send(series);
    }
  );

  // Approves/dismisses series; newly approved series expand into dated
  // candidate events in the background via the existing per-series path
  // (searxngSearch + extractDates + date-dedupe).
  app.post<{
    Params: { id: string };
    Body: { approveIds?: string[]; dismissIds?: string[] };
  }>('/api/queries/:id/series/review', { preHandler: deps.requireAuth }, async (request, reply) => {
    const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
    if (!queryObjectId) {
      return reply.code(403).send({ error: 'not your query' });
    }
    const updated = await reviewSeries(
      deps.db,
      request.userId!,
      request.params.id,
      request.body?.approveIds ?? [],
      request.body?.dismissIds ?? []
    );
    if (!updated) {
      return reply.code(403).send({ error: 'not your query' });
    }
    const newlyApproved = updated.filter(s => (request.body?.approveIds ?? []).includes(s.id));
    for (const series of newlyApproved) {
      const seriesObjectId = new ObjectId(series.id);
      enqueueSearch(async () => {
        try {
          const extracted = await expandSeries(deps, series);
          await completeSeriesExpansion(deps.db, queryObjectId, seriesObjectId, extracted.events);
        } catch (err) {
          console.error(`Series expansion failed for series ${series.id}:`, err);
        }
      });
    }
    return reply.send(updated);
  });

  // Expands one series on demand into dated events (existing per-series
  // path, reused). Dismissed series are never expanded.
  app.post<{ Params: { id: string; seriesId: string } }>(
    '/api/queries/:id/series/:seriesId/expand',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const series = await getSeriesById(deps.db, request.userId!, queryObjectId, request.params.seriesId);
      if (!series) {
        return reply.code(403).send({ error: 'not your query' });
      }
      if (series.status === 'dismissed') {
        return reply.code(409).send({ error: 'series dismissed' });
      }
      try {
        const extracted = await expandSeries(deps, {
          title: series.title,
          appliesTo: series.applies_to ?? series.title,
          description: series.description,
          searchKeywords: series.search_keywords,
        });
        const inserted = await completeSeriesExpansion(deps.db, queryObjectId, series._id, extracted.events);
        return reply.send(inserted);
      } catch (err) {
        console.error(`Series expansion failed for series ${series._id.toString()}:`, err);
        return reply.code(502).send({ error: 'expansion failed' });
      }
    }
  );

  // Explicit refresh only: re-runs series discovery (1 searxng + 1 LLM
  // call). Dismissed titles are never re-created (normalized-title dedupe).
  app.post<{ Params: { id: string } }>(
    '/api/queries/:id/series/refresh',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      if (!deps.discoverSeries) {
        return reply.code(409).send({ error: 'discovery unavailable' });
      }
      const queryObjectId = ObjectId.isValid(request.params.id) ? new ObjectId(request.params.id) : null;
      if (!queryObjectId) {
        return reply.code(403).send({ error: 'not your query' });
      }
      const row = await deps.db
        .collection<{ _id: ObjectId; user_id: string; query_text: string }>('queries')
        .findOne({ _id: queryObjectId, user_id: request.userId! });
      if (!row) {
        return reply.code(403).send({ error: 'not your query' });
      }
      try {
        const { series } = await deps.discoverSeries(row.query_text);
        const inserted = await insertDiscoveredSeries(deps.db, queryObjectId, request.userId!, series);
        return reply.send(inserted);
      } catch (err) {
        console.error(`Series refresh failed for query ${queryObjectId.toString()}:`, err);
        return reply.code(502).send({ error: 'discovery failed' });
      }
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
      return reply.code(204).send();
    }
  );
}