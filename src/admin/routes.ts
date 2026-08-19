import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import { deleteAccount } from '../auth/account.js';
import type { UserRole } from '../auth/magicLink.js';

export interface AdminRouteDeps {
  db: Db;
  requireAdmin: preHandlerHookHandler;
}

interface UserRow {
  _id: ObjectId;
  email: string;
  role?: UserRole;
  created_at?: Date;
}

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