import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { MagicLinkService } from './magicLink.js';
import { SessionService, createRequireAuth, SESSION_COOKIE } from './session.js';
import { deleteAccount } from './account.js';

export interface AuthRouteDeps {
  db: Db;
  magicLinkService: MagicLinkService;
  sessionService: SessionService;
  frontendUrl: string;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post<{ Body: { email: string } }>(
    '/api/auth/magic-link',
    // Each request fires an email, so this route is the spam/abuse vector —
    // tighten the app-wide 100/min ceiling to a few requests per minute.
    // Attackers can still vary the target email, so don't key by email;
    // per-IP (the plugin default) is the right bucket here.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const email = request.body?.email;
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'invalid email' });
      }
      await deps.magicLinkService.requestLink(email);
      return reply.code(202).send({ sent: true });
    }
  );

  app.get<{ Querystring: { token: string } }>('/api/auth/callback', async (request, reply) => {
    const token = request.query?.token;
    if (typeof token !== 'string' || !token) {
      return reply.code(400).send({ error: 'invalid or expired link' });
    }
    const userId = await deps.magicLinkService.verifyToken(token);
    if (!userId) {
      return reply.code(400).send({ error: 'invalid or expired link' });
    }
    const sessionId = await deps.sessionService.createSession(userId);
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return reply.redirect(deps.frontendUrl);
  });

  const requireAuth = createRequireAuth(deps.sessionService);
  app.get('/api/me', { preHandler: requireAuth }, async () => ({ authenticated: true }));

  app.post('/api/auth/signout', async (request, reply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (sessionId) {
      await deps.sessionService.deleteSession(sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.delete('/api/auth/account', { preHandler: requireAuth }, async (request, reply) => {
    await deleteAccount(deps.db, request.userId!);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
