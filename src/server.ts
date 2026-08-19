import { buildApp } from './app.js';
import { createClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { SmtpEmailSender, ConsoleEmailSender, type EmailSender } from './email/EmailSender.js';
import { searxngSearch } from './search/searxngClient.js';
import { extractDates } from './search/opencodeClient.js';
import { createSearchOrchestrator } from './search/searchOrchestrator.js';
import { startScheduler } from './scheduler/scheduler.js';
import nodemailer from 'nodemailer';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const client = await createClient(process.env.DATABASE_URL!);
  const db = client.db();
  await runMigrations(db);

  const emailSender: EmailSender = process.env.SMTP_HOST
    ? new SmtpEmailSender(
        nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        }),
        process.env.SMTP_FROM ?? 'dontforget@lehel.xyz'
      )
    : new ConsoleEmailSender(); // dev fallback — prints the magic link to stdout

  const runQuery = createSearchOrchestrator({
    searxngSearch: query =>
      searxngSearch(process.env.SEARXNG_BASE_URL!, query, process.env.SEARXNG_TOKEN!),
    extractDates: (query, results) =>
      extractDates(process.env.OPENCODE_BASE_URL!, process.env.OPENCODE_API_KEY!, query, results),
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  // Whose emails get the admin role on sign-in (comma-separated). The admin
  // UI is only reachable by those accounts — no admin UI to bootstrap itself.
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(email => email.length > 0);

  const app = await buildApp({
    db,
    emailSender,
    publicBaseUrl,
    adminEmails,
    // In production the backend serves the built frontend itself (below),
    // so the magic-link callback redirect stays same-origin ('/'). In dev
    // the frontend is a separate Vite server — redirect there instead, or
    // the callback 404s trying to GET '/' on a backend that has no such
    // route outside production.
    frontendUrl: process.env.FRONTEND_URL ?? (isProduction ? '/' : 'http://localhost:5173'),
    runQuery,
  });

  // Default enabled — only skip starting the scheduler when explicitly
  // disabled. Prevents every `tsx watch` restart in local dev from firing
  // real searxng/opencode calls if the dev DB has any due query.
  if (process.env.SCHEDULER_ENABLED !== 'false') {
    startScheduler(db, { runQuery, emailSender, publicBaseUrl });
  }

  if (isProduction) {
    app.register(fastifyStatic, {
      root: join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'),
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});