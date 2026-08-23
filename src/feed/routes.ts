import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from 'mongodb';
import { buildIcs } from './icsGenerator.js';
import { buildRss } from './rssGenerator.js';
import type { CandidateEvent } from '../types.js';

export interface FeedRouteDeps {
  db: Db;
  publicBaseUrl: string;
}

type FeedExt = 'ics' | 'rss';

function parseExt(fileName: string): FeedExt | null {
  if (fileName.endsWith('.ics')) return 'ics';
  if (fileName.endsWith('.rss')) return 'rss';
  return null;
}

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  // Legacy shape (/f/<token>.ics) — still served so calendars that
  // subscribed before the readable-slug URL existed keep working.
  app.get<{ Params: { tokenWithExt: string } }>('/f/:tokenWithExt', async (request, reply) => {
    const raw = request.params.tokenWithExt;
    const ext = parseExt(raw);
    const token = ext ? raw.slice(0, -(ext.length + 1)) : null;
    if (!token || !ext) {
      return reply.code(404).send();
    }
    return serveFeed(deps, token, ext, reply);
  });

  // Current shape (/f/<token>/dontforget.ics). Google Calendar's "Add by
  // URL" flow ignores X-WR-CALNAME/NAME and shows the raw feed URL as the
  // calendar name, so this puts a readable name in the URL itself. The slug
  // segment is otherwise unchecked — only the token and extension matter.
  app.get<{ Params: { token: string; slug: string } }>('/f/:token/:slug', async (request, reply) => {
    const ext = parseExt(request.params.slug);
    if (!ext) {
      return reply.code(404).send();
    }
    return serveFeed(deps, request.params.token, ext, reply);
  });
}

async function serveFeed(deps: FeedRouteDeps, token: string, ext: FeedExt, reply: FastifyReply) {
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

  // Event labels routinely carry umlauts ("Frühjahrsdult"), so the charset has
  // to be explicit: Google Calendar parses the feed during the subscribe step
  // and rejects the whole subscription — "Oops, we couldn't add this calendar"
  // — if it decodes the body as anything but UTF-8.
  if (ext === 'ics') {
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    return reply.send(buildIcs(events));
  }
  reply.header('Content-Type', 'application/rss+xml; charset=utf-8');
  return reply.send(buildRss(events, `${deps.publicBaseUrl}/f/${token}`));
}
