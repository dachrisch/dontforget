import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';

describe('POST /api/queries', () => {
  it('requires auth', async () => {
    const app = await buildApp({
      db: {} as any,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: vi.fn(),
    });

    const response = await app.inject({ method: 'POST', url: '/api/queries', payload: { text: 'x' } });
    expect(response.statusCode).toBe(401);
  });
});