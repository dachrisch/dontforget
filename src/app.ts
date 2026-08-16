import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
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

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cookie);

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
  registerFeedRoutes(app, { db: deps.db });

  return app;
}