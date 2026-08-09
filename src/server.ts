import { buildApp } from './app';
import { createClient } from './db/client';
import { runMigrations } from './db/migrate';
import { SmtpEmailSender, ConsoleEmailSender, type EmailSender } from './email/EmailSender';
import { searxngSearch } from './search/searxngClient';
import { extractDates } from './search/opencodeClient';
import { createSearchOrchestrator } from './search/searchOrchestrator';
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
    searxngSearch: query => searxngSearch(process.env.SEARXNG_BASE_URL!, query),
    extractDates: (query, results) =>
      extractDates(process.env.OPENCODE_BASE_URL!, process.env.OPENCODE_API_KEY!, query, results),
  });

  const app = buildApp({
    db,
    emailSender,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    runQuery,
  });

  if (process.env.NODE_ENV === 'production') {
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