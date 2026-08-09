import { describe, it, expect } from 'vitest';
import { buildApp } from './app';
import { CapturingEmailSender } from './email/EmailSender';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = buildApp({
      db: {} as any,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => [],
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});