import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { buildIcs } from './icsGenerator';
import { buildRss } from './rssGenerator';
import type { CandidateEvent } from '../types';

export interface FeedRouteDeps {
  db: Db;
}

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  app.get<{ Params: { tokenWithExt: string } }>('/f/:tokenWithExt', async (request, reply) => {
    const raw = request.params.tokenWithExt;
    const icsMatch = raw.match(/^(.+)\.ics$/);
    const rssMatch = raw.match(/^(.+)\.rss$/);
    const token = icsMatch?.[1] ?? rssMatch?.[1];
    if (!token) {
      return reply.code(404).send();
    }

    const tokenRow = await deps.db.collection<{ user_id: string }>('feed_tokens').findOne({ token });
    if (!tokenRow) {
      return reply.code(404).send();
    }

    // all events for queries owned by this user
    const queries = await deps.db
      .collection('queries')
      .find({ user_id: tokenRow.user_id })
      .toArray();
    const queryIds = queries.map(q => q._id);
    const eventRows = await deps.db
      .collection('events')
      .find({
        query_id: { $in: queryIds },
        status: 'approved',
      })
      .toArray();
    const events: CandidateEvent[] = eventRows.map(r => ({
      id: r._id.toString(),
      label: r.label,
      startDate: r.start_date,
      endDate: r.end_date,
      sourceUrl: r.source_url,
      status: 'approved',
    }));

    if (icsMatch) {
      reply.header('Content-Type', 'text/calendar');
      return reply.send(buildIcs(events));
    }
    reply.header('Content-Type', 'application/rss+xml');
    return reply.send(buildRss(events, `${request.protocol}://${request.hostname}/f/${token}`));
  });
}