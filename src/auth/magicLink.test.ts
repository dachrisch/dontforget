import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { MagicLinkService } from './magicLink';
import { CapturingEmailSender } from '../email/EmailSender';

describe('MagicLinkService', () => {
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

  it('promotes an allowlisted email to admin on first sign-in', async () => {
    const service = new MagicLinkService(
      db,
      new CapturingEmailSender(),
      'http://localhost:3000',
      ['admin@example.com']
    );

    await service.requestLink('admin@example.com');

    const user = await db.collection('users').findOne({ email: 'admin@example.com' });
    expect(user).toMatchObject({ role: 'admin' });
    expect(user!.created_at).toBeInstanceOf(Date);
  });

  it('keeps an existing admin promoted even if the allowlist shrinks', async () => {
    const service = new MagicLinkService(db, new CapturingEmailSender(), 'http://localhost:3000');
    await db.collection('users').insertOne({ email: 'admin@example.com', role: 'admin' });

    await service.requestLink('admin@example.com');

    const user = await db.collection('users').findOne({ email: 'admin@example.com' });
    expect(user).toMatchObject({ role: 'admin' });
  });

  it('does not grant the admin role to a non-allowlisted email', async () => {
    const service = new MagicLinkService(
      db,
      new CapturingEmailSender(),
      'http://localhost:3000',
      ['admin@example.com']
    );

    await service.requestLink('user@example.com');

    const user = await db.collection('users').findOne({ email: 'user@example.com' });
    expect(user!.role).toBeUndefined();
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