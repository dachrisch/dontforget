import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
import { approveEvents } from '../queries/approveEvents';
import { registerFeedRoutes } from './routes';
import Fastify from 'fastify';

function tokenFromIcsUrl(icsUrl: string): string {
  return icsUrl.match(/\/f\/([^/]+)\//)![1];
}

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
    const token = tokenFromIcsUrl(icsUrl);

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

  // Google Calendar's subscribe step fetches the feed and parses it before it
  // will accept the subscription. Without an explicit charset a parser is free
  // to fall back to something other than UTF-8, and every label with an umlaut
  // ("Frühjahrsdult") then decodes as mojibake or fails outright — which Google
  // reports to the user as "Oops, we couldn't add this calendar". Known-good
  // public feeds (gov.uk, Google's own holiday ICS) all send the charset.
  it('declares charset=utf-8 on both feed formats so non-ASCII labels survive', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'charset@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Umsonst und draußen Festival', startDate: '2026-08-21', endDate: '2026-08-24', sourceUrl: 'https://example.org' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = tokenFromIcsUrl(icsUrl);

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    for (const url of [`/f/${token}.ics`, `/f/${token}/dontforget.ics`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
      expect(response.body).toContain('draußen');
    }

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.statusCode).toBe(200);
    expect(rssResponse.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
  });

  it('serves the readable slug-style URL that approveEvents actually returns, and still serves the legacy URL', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'slug@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl, rssUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = tokenFromIcsUrl(icsUrl);
    expect(icsUrl).toBe(`http://x/f/${token}/dontforget.ics`);
    expect(rssUrl).toBe(`http://x/f/${token}/dontforget.rss`);

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const slugResponse = await app.inject({ method: 'GET', url: `/f/${token}/dontforget.ics` });
    expect(slugResponse.statusCode).toBe(200);
    expect(slugResponse.body).toContain('Frühjahrsdult');

    // The slug text itself isn't validated — only the token and extension matter.
    const otherSlug = await app.inject({ method: 'GET', url: `/f/${token}/anything.ics` });
    expect(otherSlug.statusCode).toBe(200);

    const badExt = await app.inject({ method: 'GET', url: `/f/${token}/dontforget.txt` });
    expect(badExt.statusCode).toBe(404);

    // Calendars already subscribed via the old bare-token URL keep working.
    const legacyResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(legacyResponse.statusCode).toBe(200);
    expect(legacyResponse.body).toContain('Frühjahrsdult');
  });

  it('builds the RSS channel link from the configured public base URL, not the request protocol', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'rss@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'https://dontforget.lehel.xyz'))!;
    const token = tokenFromIcsUrl(icsUrl);

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
    const token = tokenFromIcsUrl(icsUrl);

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
    const token = tokenFromIcsUrl(icsUrl);

    const app = Fastify();
    registerFeedRoutes(app, { db, publicBaseUrl: 'http://localhost:3000' });

    const icsResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(icsResponse.body.indexOf('Frühjahrsdult')).toBeLessThan(icsResponse.body.indexOf('Jakobidult'));

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.body.indexOf('Frühjahrsdult')).toBeLessThan(rssResponse.body.indexOf('Jakobidult'));
  });
});