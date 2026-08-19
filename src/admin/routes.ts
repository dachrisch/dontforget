import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import { deleteAccount } from '../auth/account.js';
import type { UserRole } from '../auth/magicLink.js';
import type { ModelRegistry, ModelRole } from '../search/models.js';
import type { MetricsService } from '../search/metrics.js';

export interface AdminRouteDeps {
  db: Db;
  requireAdmin: preHandlerHookHandler;
  modelRegistry: ModelRegistry;
  metrics: MetricsService;
}

interface UserRow {
  _id: ObjectId;
  email: string;
  role?: UserRole;
  created_at?: Date;
}

// Aggregate window used by the model/search health endpoints.
const METRICS_WINDOW_DAYS = 7;
const METRICS_SINCE = () => new Date(Date.now() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // User- and query-count rollups over the existing collections — no
  // activity-log collection yet, so these numbers are derivable on demand.
  app.get('/api/admin/stats', { preHandler: deps.requireAdmin }, async () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalUsers, totalQueries, approvedEvents, candidateEvents, activeUserIds] = await Promise.all([
      deps.db.collection('users').countDocuments(),
      deps.db.collection('queries').countDocuments(),
      deps.db.collection('events').countDocuments({ status: 'approved' }),
      deps.db.collection('events').countDocuments({ status: 'candidate' }),
      deps.db.collection('queries').distinct('user_id', { last_run_at: { $gte: weekAgo } }),
    ]);
    return {
      totalUsers,
      totalQueries,
      approvedEvents,
      candidateEvents,
      activeUsers7d: activeUserIds.length,
    };
  });

  // Model performance + registry: every configured model with its 7-day
  // success rate and latency, so an admin can spot an unresponsive model and
  // switch the default/backup or retire it.
  app.get('/api/admin/models', { preHandler: deps.requireAdmin }, async () => {
    const models = await deps.modelRegistry.list();
    const aggregates = await aggregateModelMetrics(deps.db);
    return models.map(model => {
      const agg = aggregates.get(model.id) ?? emptyModelAgg();
      return {
        id: model.id,
        providerId: model.providerID,
        role: model.role ?? null,
        enabled: model.enabled,
        calls: agg.calls,
        failures: agg.failures,
        successRate: agg.calls === 0 ? null : Number(((1 - agg.failures / agg.calls) * 100).toFixed(1)),
        avgLatencyMs: agg.avgLatencyMs,
        maxLatencyMs: agg.maxLatencyMs,
      };
    });
  });

  app.post<{ Body: { id: string; providerID: string } }>(
    '/api/admin/models',
    { preHandler: deps.requireAdmin },
    async (request, reply) => {
      const id = request.body?.id?.trim();
      const providerID = request.body?.providerID?.trim();
      if (!id || !providerID) {
        return reply.code(400).send({ error: 'id and providerID are required' });
      }
      const model = await deps.modelRegistry.add({ id, providerID });
      if (!model) {
        return reply.code(409).send({ error: 'a model with this id already exists' });
      }
      return reply.code(201).send({ id: model.id, providerId: model.providerID, role: model.role ?? null, enabled: model.enabled });
    }
  );

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; role?: ModelRole | null } }>(
    '/api/admin/models/:id',
    { preHandler: deps.requireAdmin },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.enabled === undefined && body.role === undefined) {
        return reply.code(400).send({ error: 'nothing to update' });
      }
      const model = await deps.modelRegistry.update(request.params.id, { enabled: body.enabled, role: body.role });
      if (!model) {
        return reply.code(404).send({ error: 'model not found' });
      }
      return reply.send({ id: model.id, providerId: model.providerID, role: model.role ?? null, enabled: model.enabled });
    }
  );

  // Search availability: 7-day search call volume, failure rate and latency,
  // so an admin can tell at a glance whether searxng is reachable and
  // returning results.
  app.get('/api/admin/search', { preHandler: deps.requireAdmin }, async () => {
    const since = METRICS_SINCE();
    const [total, failures, avg] = await Promise.all([
      deps.db.collection('search_metrics').countDocuments({ created_at: { $gte: since } }),
      deps.db.collection('search_metrics').countDocuments({ created_at: { $gte: since }, outcome: 'failure' }),
      deps.db
        .collection('search_metrics')
        .aggregate<{ avgMs: number; maxMs: number; avgResults: number }>([
          { $match: { created_at: { $gte: since } } },
          {
            $group: {
              _id: null,
              avgMs: { $avg: '$duration_ms' },
              maxMs: { $max: '$duration_ms' },
              avgResults: { $avg: '$result_count' },
            },
          },
        ])
        .toArray(),
    ]);
    const agg = avg[0];
    const lastError = await deps.db
      .collection('search_metrics')
      .findOne({ outcome: 'failure' }, { sort: { created_at: -1 } });
    return {
      calls: total,
      failures,
      errorRate: total === 0 ? null : Number(((failures / total) * 100).toFixed(1)),
      avgLatencyMs: agg ? Math.round(agg.avgMs) : null,
      maxLatencyMs: agg ? Math.round(agg.maxMs) : null,
      avgResultCount: agg ? Math.round(agg.avgResults) : null,
      lastErrorAt: lastError?.created_at ? (lastError.created_at as Date).toISOString() : null,
    };
  });

  app.get('/api/admin/users', { preHandler: deps.requireAdmin }, async () => {
    const userRows = await deps.db
      .collection<UserRow>('users')
      .find({}, { projection: { email: 1, role: 1, created_at: 1 } })
      .sort({ created_at: 1 })
      .toArray();

    // queries.user_id is stored as the string form of users._id, so the
    // join happens in JS rather than $lookup — same pattern as
    // queriesRepo's eventCountsByQuery.
    const countRows = await deps.db
      .collection<{ _id: string; count: number }>('queries')
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$user_id', count: { $sum: 1 } } }])
      .toArray();
    const countByUser = new Map(countRows.map(row => [row._id, row.count]));

    return userRows.map(user => ({
      id: user._id.toString(),
      email: user.email,
      role: user.role ?? 'user',
      createdAt: user.created_at ? user.created_at.toISOString() : null,
      queryCount: countByUser.get(user._id.toString()) ?? 0,
    }));
  });

  app.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: deps.requireAdmin },
    async (request, reply) => {
      if (request.params.id === request.userId) {
        return reply.code(403).send({ error: 'cannot delete your own account' });
      }
      if (!ObjectId.isValid(request.params.id)) {
        return reply.code(400).send({ error: 'invalid user id' });
      }
      await deleteAccount(deps.db, request.params.id);
      return reply.code(204).send();
    }
  );
}

interface ModelAgg {
  calls: number;
  failures: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

function emptyModelAgg(): ModelAgg {
  return { calls: 0, failures: 0, avgLatencyMs: null, maxLatencyMs: null };
}

async function aggregateModelMetrics(db: Db): Promise<Map<string, ModelAgg>> {
  const rows = await db
    .collection('model_metrics')
    .aggregate<{ _id: string; calls: number; failures: number; avgMs: number | null; maxMs: number | null }>([
      { $match: { created_at: { $gte: METRICS_SINCE() } } },
      {
        $group: {
          _id: '$model_id',
          calls: { $sum: 1 },
          failures: { $sum: { $cond: [{ $eq: ['$outcome', 'failure'] }, 1, 0] } },
          avgMs: { $avg: '$duration_ms' },
          maxMs: { $max: '$duration_ms' },
        },
      },
    ])
    .toArray();

  const map = new Map<string, ModelAgg>();
  for (const row of rows) {
    map.set(row._id, {
      calls: row.calls,
      failures: row.failures,
      avgLatencyMs: row.avgMs == null ? null : Math.round(row.avgMs),
      maxLatencyMs: row.maxMs == null ? null : Math.round(row.maxMs),
    });
  }
  return map;
}