import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Db } from 'mongodb';
import type { EmailSender } from './email/EmailSender';
import { MagicLinkService } from './auth/magicLink';
import { SessionService, createRequireAuth } from './auth/session';
import { registerAuthRoutes } from './auth/routes';
import { registerQueryRoutes } from './queries/routes';
import { registerFeedRoutes } from './feed/routes';
import type { ExtractedEvent } from './types';

export interface AppDeps {
  db: Db;
  emailSender: EmailSender;
  publicBaseUrl: string;
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cookie);

  app.get('/health', async () => ({ status: 'ok' }));

  const magicLinkService = new MagicLinkService(deps.db, deps.emailSender, deps.publicBaseUrl);
  const sessionService = new SessionService(deps.db);
  registerAuthRoutes(app, { magicLinkService, sessionService });

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