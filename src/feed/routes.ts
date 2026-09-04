import type { FastifyInstance, FastifyReply } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import { buildIcs, type IcsFeedEvent } from './icsGenerator.js';
import { buildRss, type RssFeedEvent } from './rssGenerator.js';
import type { CandidateEvent } from '../types.js';
import { getOrCreateReviewToken } from '../review/reviewTokens.js';
import { buildReviewEntryContent, reviewEntryTitle } from '../review/reviewDescription.js';

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
  const queryTextById = new Map<string, string>(
    queries.map(q => [q._id.toString(), (q.query_text as string) ?? ''])
  );
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

  // Candidate events become one-off review entries — the primary triage
  // surface — so the user never has to open the app to approve. Each entry
  // is distinct from the real event (Review: title, review- id) and carries
  // Approve / Not interested this time / Not interested at all links. Once
  // any action lands, the event leaves `candidate` (or its query is
  // deleted), so the entry is naturally not re-presented.
  const candidateRows = await deps.db
    .collection('events')
    .find({
      query_id: { $in: queryIds },
      status: 'candidate',
    })
    .sort({ start_date: 1 })
    .toArray();

  const reviewIcsEvents: IcsFeedEvent[] = [];
  const reviewRssEvents: RssFeedEvent[] = [];
  for (const row of candidateRows) {
    const eventId = row._id as ObjectId;
    const queryId = row.query_id as ObjectId;
    const reviewToken = await getOrCreateReviewToken(deps.db, eventId, queryId, tokenRow.user_id);
    const content = buildReviewEntryContent({
      publicBaseUrl: deps.publicBaseUrl,
      token: reviewToken,
      queryText: queryTextById.get(queryId.toString()) ?? '',
      label: row.label as string,
      startDate: row.start_date as string,
      endDate: row.end_date as string,
      sourceUrl: row.source_url as string,
    });
    const reviewId = `review-${eventId.toString()}`;
    const reviewLabel = reviewEntryTitle(row.label as string);
    reviewIcsEvents.push({
      id: reviewId,
      label: reviewLabel,
      startDate: row.start_date as string,
      endDate: row.end_date as string,
      sourceUrl: row.source_url as string,
      status: 'candidate',
      description: content.text,
      htmlDescription: content.html,
    });
    reviewRssEvents.push({
      id: reviewId,
      label: reviewLabel,
      startDate: row.start_date as string,
      endDate: row.end_date as string,
      sourceUrl: row.source_url as string,
      status: 'candidate',
      description: content.html,
    });
  }

  // Event labels routinely carry umlauts ("Frühjahrsdult"), so the charset has
  // to be explicit: Google Calendar parses the feed during the subscribe step
  // and rejects the whole subscription — "Oops, we couldn't add this calendar"
  // — if it decodes the body as anything but UTF-8.
  if (ext === 'ics') {
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    return reply.send(
      buildIcs([
        ...events,
        ...reviewIcsEvents,
      ])
    );
  }
  reply.header('Content-Type', 'application/rss+xml; charset=utf-8');
  return reply.send(
    buildRss([...events, ...reviewRssEvents], `${deps.publicBaseUrl}/f/${token}`)
  );
}
