import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { approveEvents } from '../queries/approveEvents';
import { registerFeedRoutes } from './routes';
import Fastify from 'fastify';

describe('feed routes', () => {
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

  it('serves ICS and RSS for a valid token, 404 for an unknown one', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'h@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const icsResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(icsResponse.statusCode).toBe(200);
    expect(icsResponse.body).toContain('Frühjahrsdult');

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.statusCode).toBe(200);
    expect(rssResponse.body).toContain('<rss');

    const missing = await app.inject({ method: 'GET', url: '/f/does-not-exist.ics' });
    expect(missing.statusCode).toBe(404);
  });

  it('builds the RSS channel link from the configured public base URL, not the request protocol', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'rss@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'https://dontforget.lehel.xyz'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'https://dontforget.lehel.xyz' });

    const rssResponse = await app.inject({
      method: 'GET',
      url: `/f/${token}.rss`,
      headers: { 'x-forwarded-proto': 'http' },
    });

    expect(rssResponse.statusCode).toBe(200);
    // Behind Traefik the request protocol reads as http; the channel link
    // must still use the configured https public base URL so feed readers
    // and validators don't end up on an http link.
    expect(rssResponse.body).toContain(`<link>https://dontforget.lehel.xyz/f/${token}</link>`);
    expect(rssResponse.body).not.toContain('<link>http://');
  });

  it('records when the calendar was last fetched', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'j@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const before = await db.collection('feed_tokens').findOne({ token });
    expect(before?.last_fetched_at).toBeUndefined();

    await app.inject({ method: 'GET', url: `/f/${token}.ics` });

    const after = await db.collection('feed_tokens').findOne({ token });
    expect(after?.last_fetched_at).toBeInstanceOf(Date);
  });

  it('lists approved events chronologically regardless of insertion order', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'i@example.com' });
    const userId = insertedId.toString();
    // Later-dated event inserted first, on purpose — the feed must sort by
    // date itself rather than relying on insertion/natural order.
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(
      db,
      userId,
      queryId,
      candidates.map(c => c.id),
      'http://x'
    ))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const icsResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(icsResponse.body.indexOf('Frühjahrsdult')).toBeLessThan(icsResponse.body.indexOf('Jakobidult'));

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.body.indexOf('Frühjahrsdult')).toBeLessThan(rssResponse.body.indexOf('Jakobidult'));
  });
});