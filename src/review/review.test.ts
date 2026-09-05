import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import Fastify from 'fastify';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
import { getOrCreateReviewToken, buildReviewActionUrls } from './reviewTokens';
import { buildReviewEntryContent, reviewEntryTitle } from './reviewDescription';
import { handleReviewCallback } from './reviewCallback';
import { registerReviewRoutes } from './routes';
import { registerFeedRoutes } from '../feed/routes';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';

describe('review tokens', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('returns the same live token for an event and mints action URLs for all three actions', async () => {
    const eventId = new ObjectId();
    const queryId = new ObjectId();

    const first = await getOrCreateReviewToken(db, eventId, queryId, 'user-1');
    const second = await getOrCreateReviewToken(db, eventId, queryId, 'user-1');
    expect(second).toBe(first);

    const urls = buildReviewActionUrls('http://localhost:3000', first);
    expect(urls.approveUrl).toContain(`/api/review/callback?token=${first}&action=approve`);
    expect(urls.dismissUrl).toContain('&action=dismiss');
    expect(urls.suppressUrl).toContain('&action=suppress');
  });

  it('mints a fresh token once the old one is consumed', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'rt@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);

    const eventId = new ObjectId(candidates[0].id);
    const first = await getOrCreateReviewToken(db, eventId, new ObjectId(queryId), userId);
    const applied = await handleReviewCallback(db, first, 'dismiss');
    expect(applied.ok).toBe(true);

    const second = await getOrCreateReviewToken(db, eventId, new ObjectId(queryId), userId);
    expect(second).not.toBe(first);
  });
});

describe('review entry content', () => {
  it('embeds working approve/dismiss/suppress links plus a plain-text fallback', () => {
    const content = buildReviewEntryContent({
      publicBaseUrl: 'http://localhost:3000',
      token: 'tok123',
      queryText: 'Auer Dult Munich',
      label: 'Frühjahrsdult',
      startDate: '2026-04-11',
      endDate: '2026-05-11',
      sourceUrl: 'https://auerdult.de',
    });

    for (const action of ['approve', 'dismiss', 'suppress'] as const) {
      expect(content.html).toContain(`action=${action}`);
      expect(content.text).toContain(`action=${action}`);
    }
    expect(content.html).toContain('<a href=');
    // Plain-text fallback carries the raw URLs for clients that strip HTML.
    expect(content.text).toContain('http://localhost:3000/api/review/callback?token=tok123');
  });

  it('escapes user-controlled text in the HTML variant', () => {
    const content = buildReviewEntryContent({
      publicBaseUrl: 'http://localhost:3000',
      token: 'tok123',
      queryText: '"><script>alert(1)</script>',
      label: '<b>Bold</b>',
      startDate: '2026-04-11',
      endDate: '2026-04-11',
      sourceUrl: 'https://example.org',
    });

    expect(content.html).not.toContain('<script>');
    expect(content.html).not.toContain('<b>Bold</b>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('titles review entries distinctly from confirmed events', () => {
    expect(reviewEntryTitle('Frühjahrsdult')).toBe('Review: Frühjahrsdult');
  });
});

describe('review callback', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'rc@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  async function reviewTokenFor(queryId: string, eventId: string): Promise<string> {
    return getOrCreateReviewToken(db, new ObjectId(eventId), new ObjectId(queryId), userId);
  }

  it('approve flips the candidate to approved and the token is single-use', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const token = await reviewTokenFor(queryId, candidates[0].id);

    const result = await handleReviewCallback(db, token, 'approve');
    expect(result).toMatchObject({ ok: true, action: 'approve', eventLabel: 'Frühjahrsdult' });

    const stored = await db.collection('events').findOne({ _id: new ObjectId(candidates[0].id) });
    expect(stored?.status).toBe('approved');

    // Replaying the same link fails — the token is consumed.
    const replay = await handleReviewCallback(db, token, 'approve');
    expect(replay).toMatchObject({ ok: false, reason: 'invalid-or-used' });
  });

  it('dismiss flips the candidate to dismissed', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Oktoberfest', [
      { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
    ]);
    const token = await reviewTokenFor(queryId, candidates[0].id);

    const result = await handleReviewCallback(db, token, 'dismiss');
    expect(result).toMatchObject({ ok: true, action: 'dismiss' });

    const stored = await db.collection('events').findOne({ _id: new ObjectId(candidates[0].id) });
    expect(stored?.status).toBe('dismissed');
  });

  it('suppress deletes the originating query and all its events', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Tour dates', [
      { label: 'Munich show', startDate: '2026-05-01', endDate: '2026-05-01', sourceUrl: 'https://a.example' },
      { label: 'Berlin show', startDate: '2026-05-03', endDate: '2026-05-03', sourceUrl: 'https://a.example' },
    ]);
    const token = await reviewTokenFor(queryId, candidates[0].id);

    const result = await handleReviewCallback(db, token, 'suppress');
    expect(result).toMatchObject({ ok: true, action: 'suppress', queryText: 'Tour dates' });

    expect(await db.collection('queries').countDocuments({ _id: new ObjectId(queryId) })).toBe(0);
    expect(await db.collection('events').countDocuments({ query_id: new ObjectId(queryId) })).toBe(0);
  });

  it('rejects unknown tokens and unknown actions', async () => {
    expect(await handleReviewCallback(db, 'does-not-exist', 'approve')).toMatchObject({
      ok: false,
      reason: 'invalid-or-used',
    });

    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const token = await reviewTokenFor(queryId, candidates[0].id);
    expect(await handleReviewCallback(db, token, 'explode')).toMatchObject({
      ok: false,
      reason: 'invalid-action',
    });
  });

  it('reports already-acted when the event left candidate via the in-app flow', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const token = await reviewTokenFor(queryId, candidates[0].id);

    // In-app approval first (same setEventStatus target the callback uses).
    await db
      .collection('events')
      .updateOne({ _id: new ObjectId(candidates[0].id) }, { $set: { status: 'approved' } });

    expect(await handleReviewCallback(db, token, 'approve')).toMatchObject({
      ok: false,
      reason: 'already-acted',
    });
  });
});

describe('review callback route', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('renders a confirmation page on success and a 400 page for bad links', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'route@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const token = await getOrCreateReviewToken(
      db,
      new ObjectId(candidates[0].id),
      new ObjectId(queryId),
      userId
    );

    const app = Fastify();
    registerReviewRoutes(app, { db });

    const ok = await app.inject({
      method: 'GET',
      url: `/api/review/callback?token=${token}&action=approve`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.body).toContain('Approved');

    const replay = await app.inject({
      method: 'GET',
      url: `/api/review/callback?token=${token}&action=approve`,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('already used');

    const badAction = await app.inject({
      method: 'GET',
      url: `/api/review/callback?token=${token}&action=explode`,
    });
    expect(badAction.statusCode).toBe(400);
  });

  it('is registered on the app alongside the feed routes', async () => {
    const app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: vi.fn().mockResolvedValue({ events: [], cadence: null }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/review/callback?token=missing&action=approve',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('review entries in the feed', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('serves candidate review entries in ICS and RSS before any approval', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'feed@example.com' });
    const userId = insertedId.toString();
    // completeQueryRun now mints the feed token, so the feed exists while
    // everything is still awaiting review.
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    expect(queryId).toBeTruthy();
    const feedRow = await db.collection('feed_tokens').findOne({ user_id: userId });
    expect(feedRow?.token).toBeTruthy();

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const ics = await app.inject({ method: 'GET', url: `/f/${feedRow!.token}.ics` });
    expect(ics.statusCode).toBe(200);
    // Review entry is distinct from the confirmed entry.
    expect(ics.body).toContain('SUMMARY:Review: Frühjahrsdult');
    expect(ics.body).toContain('UID:review-');
    // Plain-text DESCRIPTION fallback plus HTML variant with links.
    expect(ics.body).toContain('/api/review/callback?token=');
    expect(ics.body).toContain('action=approve');
    expect(ics.body).toContain('action=dismiss');
    expect(ics.body).toContain('action=suppress');
    expect(ics.body).toContain('X-ALT-DESC');
    expect(ics.body.match(/BEGIN:VEVENT/g)).toHaveLength(1);

    const rss = await app.inject({ method: 'GET', url: `/f/${feedRow!.token}.rss` });
    expect(rss.statusCode).toBe(200);
    expect(rss.body).toContain('Review: Frühjahrsdult');
    expect(rss.body).toContain('action=approve');
  });

  it('replaces the review entry with the confirmed event after approval, and drops it after dismiss/suppress', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'swap@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
    ]);
    const feedRow = (await db.collection('feed_tokens').findOne({ user_id: userId }))!;
    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });
    const fetchIcs = async () =>
      (await app.inject({ method: 'GET', url: `/f/${feedRow.token}.ics` })).body as string;

    // Approve the first candidate via its review link: the review entry is
    // replaced by the normal confirmed entry.
    const approveToken = await getOrCreateReviewToken(
      db,
      new ObjectId(candidates[0].id),
      new ObjectId(queryId),
      userId
    );
    expect((await handleReviewCallback(db, approveToken, 'approve')).ok).toBe(true);
    let ics = await fetchIcs();
    expect(ics).toContain('SUMMARY:Frühjahrsdult');
    expect(ics).not.toContain('SUMMARY:Review: Frühjahrsdult');
    expect(ics).toContain('SUMMARY:Review: Jakobidult');

    // Dismiss the second: its review entry disappears with nothing replacing it.
    const dismissToken = await getOrCreateReviewToken(
      db,
      new ObjectId(candidates[1].id),
      new ObjectId(queryId),
      userId
    );
    expect((await handleReviewCallback(db, dismissToken, 'dismiss')).ok).toBe(true);
    ics = await fetchIcs();
    expect(ics).not.toContain('Jakobidult');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('removes all review entries once the query is suppressed', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'supp@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Tour dates', [
      { label: 'Munich show', startDate: '2026-05-01', endDate: '2026-05-01', sourceUrl: 'https://a.example' },
    ]);
    const feedRow = (await db.collection('feed_tokens').findOne({ user_id: userId }))!;
    const token = await getOrCreateReviewToken(
      db,
      new ObjectId(candidates[0].id),
      new ObjectId(queryId),
      userId
    );
    expect((await handleReviewCallback(db, token, 'suppress')).ok).toBe(true);

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });
    const ics = await app.inject({ method: 'GET', url: `/f/${feedRow.token}.ics` });
    expect(ics.statusCode).toBe(200);
    expect(ics.body).not.toContain('Munich show');
    expect(ics.body).not.toContain('BEGIN:VEVENT');
  });
});
