import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Db } from 'mongodb';
import type { EmailSender } from './email/EmailSender.js';
import { MagicLinkService } from './auth/magicLink.js';
import { SessionService, createRequireAuth, createRequireAdmin } from './auth/session.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerQueryRoutes } from './queries/routes.js';
import { registerFeedRoutes } from './feed/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerBillingRoutes } from './billing/routes.js';
import { registerBillingWebhook } from './billing/webhook.js';
import type { BillingService } from './billing/billingService.js';
import { createNoopModelRegistry } from './search/models.js';
import type { ModelRegistry } from './search/models.js';
import { createMetricsService } from './search/metrics.js';
import type { MetricsService } from './search/metrics.js';
import type { ExtractionResult } from './types.js';

export interface AppDeps {
  db: Db;
  emailSender: EmailSender;
  publicBaseUrl: string;
  frontendUrl: string;
  runQuery: (query: string) => Promise<ExtractionResult>;
  billingService: BillingService;
  webhookSecret?: string;
  // Model registry + metrics are required for the admin model/health
  // endpoints; defaulted to no-op variants when omitted so unit tests that
  // only exercise user/query flows don't need to provide them.
  modelRegistry?: ModelRegistry;
  metrics?: MetricsService;
  // Emails that get the admin role on sign-in. Defaults to none — a
  // deployment without ADMIN_EMAILS simply has no admin UI.
  adminEmails?: readonly string[];
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

  const magicLinkService = new MagicLinkService(
    deps.db,
    deps.emailSender,
    deps.publicBaseUrl,
    deps.adminEmails ?? []
  );
  const sessionService = new SessionService(deps.db);
  registerAuthRoutes(app, { db: deps.db, magicLinkService, sessionService, frontendUrl: deps.frontendUrl });

  const requireAuth = createRequireAuth(sessionService);
  registerQueryRoutes(app, {
    db: deps.db,
    runQuery: deps.runQuery,
    requireAuth,
    publicBaseUrl: deps.publicBaseUrl,
    billingService: deps.billingService,
  });
  registerFeedRoutes(app, { db: deps.db, publicBaseUrl: deps.publicBaseUrl });
  registerAdminRoutes(app, {
    db: deps.db,
    requireAdmin: createRequireAdmin(sessionService),
    // Defaults when a test only exercises user/query flows: an empty model
    // registry and a metrics service that records nothing.
    modelRegistry:
      deps.modelRegistry ??
      createNoopModelRegistry(),
    metrics: deps.metrics ?? createMetricsService(null),
  });
  registerBillingRoutes(app, {
    billingService: deps.billingService,
    requireAuth,
    publicBaseUrl: deps.publicBaseUrl,
  });
  registerBillingWebhook(app, { billingService: deps.billingService, webhookSecret: deps.webhookSecret });

  return app;
}
