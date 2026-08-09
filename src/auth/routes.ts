import type { FastifyInstance } from 'fastify';
import { MagicLinkService } from './magicLink.js';
import { SessionService, createRequireAuth, SESSION_COOKIE } from './session.js';

export interface AuthRouteDeps {
  magicLinkService: MagicLinkService;
  sessionService: SessionService;
  frontendUrl: string;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post<{ Body: { email: string } }>('/api/auth/magic-link', async (request, reply) => {
    const email = request.body?.email;
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid email' });
    }
    await deps.magicLinkService.requestLink(email);
    return reply.code(202).send({ sent: true });
  });

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
}