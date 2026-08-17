import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { buildIcs } from './icsGenerator.js';
import { buildRss } from './rssGenerator.js';
import type { CandidateEvent } from '../types.js';

export interface FeedRouteDeps {
  db: Db;
  publicBaseUrl: string;
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

    const tokenRow = await deps.db.collection<{ _id: unknown; user_id: string }>('feed_tokens').findOne({ token });
    if (!tokenRow) {
      return reply.code(404).send();
    }

    // A calendar app just polled this subscription — record it so the
    // dashboard can answer "when was the calendar last fetched?".
    await deps.db
      .collection('feed_tokens')
      .updateOne({ _id: tokenRow._id }, { $set: { last_fetched_at: new Date() } });

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
      .sort({ start_date: 1 })
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
    return reply.send(buildRss(events, `${deps.publicBaseUrl}/f/${token}`));
  });
}