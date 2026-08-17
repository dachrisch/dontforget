import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Db } from 'mongodb';
import type { EmailSender } from './email/EmailSender.js';
import { MagicLinkService } from './auth/magicLink.js';
import { SessionService, createRequireAuth } from './auth/session.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerQueryRoutes } from './queries/routes.js';
import { registerFeedRoutes } from './feed/routes.js';
import type { ExtractionResult } from './types.js';

export interface AppDeps {
  db: Db;
  emailSender: EmailSender;
  publicBaseUrl: string;
  frontendUrl: string;
  runQuery: (query: string) => Promise<ExtractionResult>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // trustProxy: the app runs behind Traefik (TLS termination), and IP-based
  // rate limiting must see the client's real address from X-Forwarded-For,
  // not the proxy's — otherwise every visitor shares one rate-limit bucket.
  const app = Fastify({ logger: true, trustProxy: true });
  app.register(cookie);

  // Global per-IP ceiling for every route (including unauthenticated feeds);
  // the magic-link route tightens this further (see auth/routes.ts) because
  // each request sends an email. Must be awaited before registering routes:
  // the plugin installs its per-route onRequest hook via onRoute, which only
  // applies to routes registered after the plugin has loaded.
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.get('/health', async () => ({ status: 'ok' }));

  const magicLinkService = new MagicLinkService(deps.db, deps.emailSender, deps.publicBaseUrl);
  const sessionService = new SessionService(deps.db);
  registerAuthRoutes(app, { magicLinkService, sessionService, frontendUrl: deps.frontendUrl });

  const requireAuth = createRequireAuth(sessionService);
  registerQueryRoutes(app, {
    db: deps.db,
    runQuery: deps.runQuery,
    requireAuth,
    publicBaseUrl: deps.publicBaseUrl,
  });
  registerFeedRoutes(app, { db: deps.db, publicBaseUrl: deps.publicBaseUrl });

  return app;
}