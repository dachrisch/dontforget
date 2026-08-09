import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { MagicLinkService } from './magicLink';
import { CapturingEmailSender } from '../email/EmailSender';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('MagicLinkService', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
    await runMigrations(db);
  });

  beforeEach(async () => {
    for (const name of ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens']) {
      await db.collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await client.close();
  });

  it('emails a link containing a token that verifies to the same user', async () => {
    const emailSender = new CapturingEmailSender();
    const service = new MagicLinkService(db, emailSender, 'http://localhost:3000');

    await service.requestLink('a@example.com');

    expect(emailSender.sent).toHaveLength(1);
    const link = emailSender.sent[0].body;
    const token = new URL(link.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const userId = await service.verifyToken(token);
    expect(userId).not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    const service = new MagicLinkService(db, new CapturingEmailSender(), 'http://localhost:3000');
    expect(await service.verifyToken('not-a-real-token')).toBeNull();
  });

  it('is single-use', async () => {
    const emailSender = new CapturingEmailSender();
    const service = new MagicLinkService(db, emailSender, 'http://localhost:3000');
    await service.requestLink('b@example.com');
    const token = new URL(emailSender.sent[0].body.match(/https?:\/\/\S+/)![0]).searchParams.get(
      'token'
    )!;

    expect(await service.verifyToken(token)).not.toBeNull();
    expect(await service.verifyToken(token)).toBeNull();
  });
});