import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import type { Db } from 'mongodb';

function fakeDb(): Db {
  const collection = {
    updateOne: vi.fn().mockResolvedValue(undefined),
    insertOne: vi.fn().mockResolvedValue(undefined),
    findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'user-1' }),
    findOne: vi.fn().mockResolvedValue({ _id: 'user-1' }),
    find: vi.fn().mockReturnValue({ toArray: () => Promise.resolve([]) }),
  };
  return { collection: vi.fn().mockReturnValue(collection) } as unknown as Db;
}

describe('auth routes', () => {
  it('POST /api/auth/magic-link accepts an email and returns 202', async () => {
    const emailSender = new CapturingEmailSender();
    const app = buildApp({
      db: fakeDb(),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
      runQuery: async () => [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/magic-link',
      payload: { email: 'a@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(emailSender.sent).toHaveLength(1);
  });

  it('POST /api/auth/magic-link returns 400, not 500, with no request body', async () => {
    const app = buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      runQuery: vi.fn(),
    });

    const response = await app.inject({ method: 'POST', url: '/api/auth/magic-link' });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/auth/callback returns 400 for a missing token', async () => {
    const app = buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      runQuery: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/auth/callback' });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/me returns 401 with no session cookie', async () => {
    const app = buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      runQuery: async () => [],
    });

    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });
});