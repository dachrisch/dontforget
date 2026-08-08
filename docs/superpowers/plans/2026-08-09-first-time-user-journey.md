# First-Time User Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-time happy path end to end — magic-link sign-in, submit a query, watch it resolve synchronously, review and approve candidate dates, get an ICS + RSS feed link — as one working full-stack slice.

**Architecture:** A Fastify + TypeScript backend (Postgres via `pg`, no ORM) exposing a small JSON API, and a plain-TypeScript (no framework) single-page frontend built with Vite that renders one workspace page whose results card morphs through five states. Backend and frontend are two sibling npm packages in this repo; deployment automation stays in the `servyy-container` infra repo per `docs/design.md` §6 and is out of scope here.

**Tech Stack:** Node 20, TypeScript 5, Fastify 4, `pg` (no ORM — hand-written SQL + a tiny migration runner), Vitest, Vite, `nodemailer`, `ics`, `feed`.

## Global Constraints

- Scope is exactly `docs/design.md` §7 (first-time happy path). Scheduler / recurring re-runs, the return-visit dashboard, and empty/error states are **explicitly out of scope** — see §7 "Explicitly out of scope for this pass" and §8 "Still open". Do not build them.
- Deployment (Ansible role, Traefik routing, Docker Compose in `servyy-container`) is out of scope — see §6. This plan only produces a repo that runs locally.
- The Chat UI is "one input box plus a results list, not a general conversation UI" (`docs/design.md` §3) — the frontend is one page with one morphing results card, never a multi-page wizard.
- First run is synchronous (§7 decision) — the `/api/queries` request handler calls searxng and opencode inline and returns candidates in the same response. Only a future scheduler (out of scope) would make this async.
- Approval is per-event (§7 decision) — never a single approve/reject action for the whole batch.
- Both ICS and RSS ship together (§7 decision) — every task that touches feeds implements both formats, never one alone.
- Auth is magic link, no password (§7 decision, 2026-08-09 addendum) — no password field, hash, or login form appears anywhere in this plan.
- Tests that touch Postgres run against a real local database (via `docker-compose.dev.yml`), never a mocked DB layer. Tests that touch the network (searxng, opencode, SMTP) mock `fetch` / inject a fake transporter — never hit real external services from a test run.

---

## External Service Reference

Read this before Task 6 — it's the actual, verified contract for the two external dependencies, not a guess.

### searxng

- Base URL: `https://search.lehel.xyz` (prod), reachable with no auth.
- JSON API is confirmed **enabled** on this instance (verified 2026-08-09 — many self-hosted SearXNG instances ship with JSON output disabled by default, but this one has it on):

  ```bash
  curl -s "https://search.lehel.xyz/search?q=wikipedia&format=json"
  ```

  Confirmed response envelope:

  ```json
  {"query": "wikipedia", "results": [], "answers": [], "corrections": [], "infoboxes": [], "suggestions": [], "unresponsive_engines": []}
  ```

  `results[]` items follow SearXNG's standard shape — `title`, `url`, `content`, plus other fields the client below ignores.
- **Known gap in this plan:** every query tried while writing this plan (including generic ones like "wikipedia") came back with zero results and an empty `unresponsive_engines` list, from *this planning sandbox's* network path. That smells like an egress restriction of the sandbox, not of production — `search.lehel.xyz` is a working, already-deployed service other tools rely on. Re-verify with a real query once Task 6's client runs from a normal dev machine or `servyy-test.lxd` before assuming anything is broken.
- No API key. Rate limiting is not implemented by this plan (see `docs/design.md` §8, still open).

### opencode

- Base URL: `https://opencode.lehel.xyz` (prod) / `https://opencode.servyy-test.lxd` (test).
- Every call needs `X-Api-Key: <key>`. The key lives in the `servyy-container` repo at `ansible/plays/vars/secrets.yml` (`opencode.api_key`, git-crypt encrypted) and is mirrored to Vaultwarden as `opencode api key (<host>)`. **Never commit this key into the `dontforget` repo** — it's supplied to this app at runtime as the `OPENCODE_API_KEY` env var.
- Confirmed-allowed surface for this key (container repo, `history/2026-08-08_opencode-api-key-forwardauth.md` + its design spec): `POST /api/session` (create a session) and everything under `/api/session/{id}/...` — `message`, `prompt`, `event`, `wait`, `context`, `history`, `interrupt`, `compact`, `agent`, `model`, `permission`, `question`. Verified live against production with curl on 2026-08-08 (`POST /api/session` + correct key → 200, returns a session).
- **Blocked for this key, do not call:** bare `GET /api/session` (list all) and `GET /api/session/active` — both 401 even with a valid key. Only create-then-act-within-the-session-you-got-back is allowed.
- **Not yet confirmed:** the exact JSON request/response body for `POST /api/session` and `POST /api/session/{id}/message`. Root and `/doc` both return 401 without opencode's own Basic Auth credentials, which this plan doesn't have access to, so the shape below is a best-effort starting point, not a verified fact. **Task 6 Step 1 is a mandatory live check** — run it with the real key before trusting the parsing code, and adjust `parseSessionId` / `parseReplyText` in `opencodeClient.ts` if the real shape differs.

---

## File Structure

```
dontforget/
├── package.json, tsconfig.json, vitest.config.ts   (backend)
├── docker-compose.dev.yml                          (local Postgres for dev + tests)
├── .env.example
├── migrations/001_init.sql
├── src/
│   ├── types.ts
│   ├── server.ts                 # entrypoint: build app, connect pool, listen
│   ├── app.ts                    # buildApp(deps) -> Fastify instance (used by tests + server.ts)
│   ├── db/{pool.ts,migrate.ts}
│   ├── email/EmailSender.ts
│   ├── auth/{magicLink.ts,session.ts,routes.ts}
│   ├── search/{searxngClient.ts,opencodeClient.ts,searchOrchestrator.ts}
│   ├── queries/{queriesRepo.ts,approveEvents.ts,routes.ts}
│   └── feed/{feedToken.ts,icsGenerator.ts,rssGenerator.ts,routes.ts}
└── web/                           (frontend, separate npm package)
    ├── package.json, vite.config.ts, index.html
    └── src/{types.ts,state.ts,api.ts,render.ts,main.ts}
```

---

### Task 1: Backend scaffolding + health check

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/app.ts`, `src/server.ts`
- Test: `src/app.test.ts`

**Interfaces:**
- Produces: `buildApp(): FastifyInstance` — every later task's route-registration tasks call this and add routes to the instance it returns.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dontforget-server",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "@fastify/cookie": "^9.3.0",
    "@fastify/static": "^7.0.0",
    "pg": "^8.11.5",
    "nodemailer": "^6.9.13",
    "ics": "^3.7.2",
    "feed": "^4.2.2"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "tsx": "^4.7.2",
    "vitest": "^1.6.0",
    "@types/node": "^20.12.7",
    "@types/pg": "^8.11.6",
    "@types/nodemailer": "^6.4.15"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
web/node_modules/
web/dist/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`

- [ ] **Step 6: Write the failing test**

`src/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildApp } from './app';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/app.test.ts`
Expected: FAIL — `Cannot find module './app'`

- [ ] **Step 8: Write minimal implementation**

`src/app.ts`:

```ts
import Fastify, { FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
```

`src/server.ts`:

```ts
import { buildApp } from './app';

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: '0.0.0.0' })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/app.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/app.ts src/app.test.ts src/server.ts
git commit -m "feat: scaffold backend with health check"
```

---

### Task 2: Postgres schema, migrations & pool

**Files:**
- Create: `docker-compose.dev.yml`, `.env.example`
- Create: `migrations/001_init.sql`
- Create: `src/db/pool.ts`, `src/db/migrate.ts`
- Test: `src/db/migrate.test.ts`

**Interfaces:**
- Produces: `createPool(connectionString: string): Pool`, `runMigrations(pool: Pool): Promise<string[]>` (returns names of newly-applied migration files). Every later DB-touching task imports `createPool`.

- [ ] **Step 1: Create `docker-compose.dev.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: dontforget
      POSTGRES_PASSWORD: dontforget
      POSTGRES_DB: dontforget
    ports:
      - "5432:5432"
    volumes:
      - dontforget-dev-db:/var/lib/postgresql/data

volumes:
  dontforget-dev-db:
```

- [ ] **Step 2: Create `.env.example`**

```
DATABASE_URL=postgres://dontforget:dontforget@localhost:5432/dontforget
PUBLIC_BASE_URL=http://localhost:3000
SEARXNG_BASE_URL=https://search.lehel.xyz
OPENCODE_BASE_URL=https://opencode.lehel.xyz
OPENCODE_API_KEY=changeme
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=dontforget@lehel.xyz
```

- [ ] **Step 3: Start local Postgres**

Run: `docker compose -f docker-compose.dev.yml up -d db`
Verify: `docker compose -f docker-compose.dev.yml ps` shows `db` healthy/running.

- [ ] **Step 4: Create the schema migration**

`migrations/001_init.sql`:

```sql
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table magic_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id text primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  query_text text not null,
  recurrence_interval text not null default 'monthly',
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  query_id uuid not null references queries(id),
  label text not null,
  start_date date not null,
  end_date date not null,
  source_url text not null,
  status text not null default 'candidate' check (status in ('candidate', 'approved')),
  created_at timestamptz not null default now()
);

create table feed_tokens (
  user_id uuid primary key references users(id),
  token text not null unique,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 5: Write the failing test**

`src/db/migrate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from './pool';
import { runMigrations } from './migrate';
import type { Pool } from 'pg';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('runMigrations', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(TEST_DB_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies pending migrations and is idempotent', async () => {
    await pool.query('drop schema public cascade; create schema public;');

    const firstRun = await runMigrations(pool);
    expect(firstRun).toEqual(['001_init.sql']);

    const tables = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    );
    expect(tables.rows.map(r => r.table_name)).toEqual(
      expect.arrayContaining(['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens'])
    );

    const secondRun = await runMigrations(pool);
    expect(secondRun).toEqual([]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: FAIL — `Cannot find module './pool'`

- [ ] **Step 7: Write minimal implementation**

`src/db/pool.ts`:

```ts
import { Pool } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
```

`src/db/migrate.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await pool.query('select name from schema_migrations')).rows.map(r => r.name as string)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    newlyApplied.push(file);
  }

  return newlyApplied;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add docker-compose.dev.yml .env.example migrations/001_init.sql src/db
git commit -m "feat: add Postgres schema, migration runner, and dev DB"
```

---

### Task 3: Email sender

**Files:**
- Create: `src/email/EmailSender.ts`
- Test: `src/email/EmailSender.test.ts`

**Interfaces:**
- Produces: `interface EmailSender { send(to: string, subject: string, body: string): Promise<void> }`, `class CapturingEmailSender implements EmailSender` (has `.sent: {to,subject,body}[]`), `class SmtpEmailSender implements EmailSender`. Task 4 consumes `EmailSender`.

- [ ] **Step 1: Write the failing test**

`src/email/EmailSender.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { CapturingEmailSender, SmtpEmailSender, type MailTransporter } from './EmailSender';

describe('CapturingEmailSender', () => {
  it('records sent emails without sending anything', async () => {
    const sender = new CapturingEmailSender();
    await sender.send('a@example.com', 'Subject', 'Body');
    expect(sender.sent).toEqual([{ to: 'a@example.com', subject: 'Subject', body: 'Body' }]);
  });
});

describe('SmtpEmailSender', () => {
  it('delegates to the transporter with the configured from address', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const transporter: MailTransporter = { sendMail };
    const sender = new SmtpEmailSender(transporter, 'dontforget@lehel.xyz');

    await sender.send('a@example.com', 'Subject', 'Body');

    expect(sendMail).toHaveBeenCalledWith({
      from: 'dontforget@lehel.xyz',
      to: 'a@example.com',
      subject: 'Subject',
      text: 'Body',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/email/EmailSender.test.ts`
Expected: FAIL — `Cannot find module './EmailSender'`

- [ ] **Step 3: Write minimal implementation**

`src/email/EmailSender.ts`:

```ts
export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

export class CapturingEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string }[] = [];

  async send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
  }
}

export interface MailTransporter {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private transporter: MailTransporter,
    private from: string
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text: body });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/email/EmailSender.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/email
git commit -m "feat: add EmailSender with SMTP and capturing implementations"
```

---

### Task 4: Auth internals — magic links & sessions

**Files:**
- Create: `src/auth/magicLink.ts`, `src/auth/session.ts`
- Test: `src/auth/magicLink.test.ts`, `src/auth/session.test.ts`

**Interfaces:**
- Consumes: `EmailSender` (Task 3), `createPool`/`runMigrations` (Task 2).
- Produces: `class MagicLinkService { requestLink(email): Promise<void>; verifyToken(token): Promise<string|null> }`, `class SessionService { createSession(userId): Promise<string>; getUserId(sessionId): Promise<string|null> }`, `createRequireAuth(sessionService): preHandlerHookHandler`. Task 5 (auth routes) and Task 8/10 (queries/feed routes) consume all three.

- [ ] **Step 1: Write the failing tests**

`src/auth/magicLink.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { MagicLinkService } from './magicLink';
import { CapturingEmailSender } from '../email/EmailSender';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('MagicLinkService', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('emails a link containing a token that verifies to the same user', async () => {
    const emailSender = new CapturingEmailSender();
    const service = new MagicLinkService(pool, emailSender, 'http://localhost:3000');

    await service.requestLink('a@example.com');

    expect(emailSender.sent).toHaveLength(1);
    const link = emailSender.sent[0].body;
    const token = new URL(link.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const userId = await service.verifyToken(token);
    expect(userId).not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    const service = new MagicLinkService(pool, new CapturingEmailSender(), 'http://localhost:3000');
    expect(await service.verifyToken('not-a-real-token')).toBeNull();
  });

  it('is single-use', async () => {
    const emailSender = new CapturingEmailSender();
    const service = new MagicLinkService(pool, emailSender, 'http://localhost:3000');
    await service.requestLink('b@example.com');
    const token = new URL(emailSender.sent[0].body.match(/https?:\/\/\S+/)![0]).searchParams.get(
      'token'
    )!;

    expect(await service.verifyToken(token)).not.toBeNull();
    expect(await service.verifyToken(token)).toBeNull();
  });
});
```

`src/auth/session.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { SessionService } from './session';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('SessionService', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a session that resolves back to the same user', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (email) values ('c@example.com') returning id`
    );
    const service = new SessionService(pool);

    const sessionId = await service.createSession(rows[0].id);
    expect(await service.getUserId(sessionId)).toBe(rows[0].id);
  });

  it('returns null for an unknown session', async () => {
    const service = new SessionService(pool);
    expect(await service.getUserId('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/auth`
Expected: FAIL — `Cannot find module './magicLink'` / `'./session'`

- [ ] **Step 3: Write minimal implementation**

`src/auth/magicLink.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { EmailSender } from '../email/EmailSender';

const TOKEN_TTL_MS = 15 * 60 * 1000;

export class MagicLinkService {
  constructor(
    private pool: Pool,
    private emailSender: EmailSender,
    private baseUrl: string
  ) {}

  async requestLink(email: string): Promise<void> {
    const userResult = await this.pool.query<{ id: string }>(
      `insert into users (email) values ($1)
       on conflict (email) do update set email = excluded.email
       returning id`,
      [email]
    );
    const userId = userResult.rows[0].id;

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await this.pool.query(
      `insert into magic_links (user_id, token, expires_at) values ($1, $2, $3)`,
      [userId, token, expiresAt]
    );

    const link = `${this.baseUrl}/api/auth/callback?token=${token}`;
    await this.emailSender.send(email, 'Your dontforget sign-in link', `Sign in: ${link}`);
  }

  async verifyToken(token: string): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(
      `update magic_links set used_at = now()
       where token = $1 and used_at is null and expires_at > now()
       returning user_id`,
      [token]
    );
    return result.rows[0]?.user_id ?? null;
  }
}
```

`src/auth/session.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'df_session';

export class SessionService {
  constructor(private pool: Pool) {}

  async createSession(userId: string): Promise<string> {
    const id = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.pool.query(`insert into sessions (id, user_id, expires_at) values ($1, $2, $3)`, [
      id,
      userId,
      expiresAt,
    ]);
    return id;
  }

  async getUserId(sessionId: string): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(
      `select user_id from sessions where id = $1 and expires_at > now()`,
      [sessionId]
    );
    return result.rows[0]?.user_id ?? null;
  }
}

export function createRequireAuth(sessionService: SessionService): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    const userId = sessionId ? await sessionService.getUserId(sessionId) : null;
    if (!userId) {
      reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    request.userId = userId;
  };
}

export { SESSION_COOKIE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/auth`
Expected: PASS (requires `docker compose -f docker-compose.dev.yml up -d db` running from Task 2)

- [ ] **Step 5: Commit**

```bash
git add src/auth/magicLink.ts src/auth/magicLink.test.ts src/auth/session.ts src/auth/session.test.ts
git commit -m "feat: add magic-link and session services"
```

---

### Task 5: Auth HTTP routes

**Files:**
- Create: `src/auth/routes.ts`
- Modify: `src/app.ts` — accept dependencies, register `@fastify/cookie` and auth routes
- Test: `src/auth/routes.test.ts`

**Interfaces:**
- Consumes: `MagicLinkService`, `SessionService`, `createRequireAuth`, `SESSION_COOKIE` (Task 4).
- Produces: `registerAuthRoutes(app, deps)` registering `POST /api/auth/magic-link`, `GET /api/auth/callback`, `GET /api/me`. `buildApp(deps: AppDeps)` now takes dependencies — every later route-registration task adds to this same signature.

- [ ] **Step 1: Write the failing test**

`src/auth/routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import type { Pool } from 'pg';

function fakePool(): Pool {
  return {} as Pool;
}

describe('auth routes', () => {
  it('POST /api/auth/magic-link accepts an email and returns 202', async () => {
    const emailSender = new CapturingEmailSender();
    const app = buildApp({
      pool: fakePool(),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    });

    // stub the DB call inside MagicLinkService by spying on the pool's query method
    (app as any).__deps.pool.query = vi.fn().mockResolvedValue({ rows: [{ id: 'user-1' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/magic-link',
      payload: { email: 'a@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(emailSender.sent).toHaveLength(1);
  });

  it('GET /api/me returns 401 with no session cookie', async () => {
    const app = buildApp({
      pool: fakePool(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
    });

    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/routes.test.ts`
Expected: FAIL — `buildApp` doesn't accept an argument yet / `/api/auth/magic-link` is a 404

- [ ] **Step 3: Write minimal implementation**

`src/auth/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { MagicLinkService } from './magicLink';
import { SessionService, createRequireAuth, SESSION_COOKIE } from './session';

export interface AuthRouteDeps {
  magicLinkService: MagicLinkService;
  sessionService: SessionService;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post<{ Body: { email: string } }>('/api/auth/magic-link', async (request, reply) => {
    const { email } = request.body;
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid email' });
    }
    await deps.magicLinkService.requestLink(email);
    return reply.code(202).send({ sent: true });
  });

  app.get<{ Querystring: { token: string } }>('/api/auth/callback', async (request, reply) => {
    const userId = await deps.magicLinkService.verifyToken(request.query.token);
    if (!userId) {
      return reply.code(400).send({ error: 'invalid or expired link' });
    }
    const sessionId = await deps.sessionService.createSession(userId);
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return reply.redirect('/');
  });

  const requireAuth = createRequireAuth(deps.sessionService);
  app.get('/api/me', { preHandler: requireAuth }, async () => ({ authenticated: true }));
}
```

`src/app.ts` (replace entirely):

```ts
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { EmailSender } from './email/EmailSender';
import { MagicLinkService } from './auth/magicLink';
import { SessionService } from './auth/session';
import { registerAuthRoutes } from './auth/routes';

export interface AppDeps {
  pool: Pool;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cookie);

  app.get('/health', async () => ({ status: 'ok' }));

  const magicLinkService = new MagicLinkService(deps.pool, deps.emailSender, deps.publicBaseUrl);
  const sessionService = new SessionService(deps.pool);
  registerAuthRoutes(app, { magicLinkService, sessionService });

  (app as any).__deps = deps;

  return app;
}
```

`src/server.ts` (replace entirely):

```ts
import { buildApp } from './app';
import { createPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { SmtpEmailSender, CapturingEmailSender, type EmailSender } from './email/EmailSender';
import nodemailer from 'nodemailer';

async function main() {
  const pool = createPool(process.env.DATABASE_URL!);
  await runMigrations(pool);

  const emailSender: EmailSender = process.env.SMTP_HOST
    ? new SmtpEmailSender(
        nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        }),
        process.env.SMTP_FROM ?? 'dontforget@lehel.xyz'
      )
    : new CapturingEmailSender(); // dev fallback — logs nothing sent; see Task 14 for console logging

  const app = buildApp({
    pool,
    emailSender,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth/routes.test.ts src/app.test.ts`
Expected: PASS. (Update `src/app.test.ts` from Task 1 to call `buildApp({ pool: {} as any, emailSender: new CapturingEmailSender(), publicBaseUrl: 'http://localhost:3000' })` — the health check doesn't touch the pool, so a stub is fine there.)

- [ ] **Step 5: Commit**

```bash
git add src/auth/routes.ts src/auth/routes.test.ts src/app.ts src/app.test.ts src/server.ts package.json
git commit -m "feat: add magic-link auth routes and wire dependencies through buildApp"
```

---

### Task 6: External clients — searxng & opencode

**Files:**
- Create: `src/search/searxngClient.ts`, `src/search/opencodeClient.ts`
- Test: `src/search/searxngClient.test.ts`, `src/search/opencodeClient.test.ts`

**Interfaces:**
- Produces: `searxngSearch(baseUrl, query): Promise<SearchResult[]>`, `extractDates(baseUrl, apiKey, query, results): Promise<ExtractedEvent[]>`. Task 7 (orchestrator) consumes both.

- [ ] **Step 1: Confirm the live opencode contract (manual, not automated)**

With the real key (from Vaultwarden, or decrypted `secrets.yml` — never paste it into this repo):

```bash
curl -s -X POST https://opencode.lehel.xyz/api/session \
  -H "X-Api-Key: $OPENCODE_API_KEY" -H "Content-Type: application/json" -d '{}'
```

Note the exact field holding the new session's id (this plan assumes `id`, matching opencode's documented `ses_...` id format from the ForwardAuth history doc). Then:

```bash
curl -s -X POST https://opencode.lehel.xyz/api/session/<id>/message \
  -H "X-Api-Key: $OPENCODE_API_KEY" -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"Reply with exactly: {\"ok\":true}"}]}'
```

If either field name or the message endpoint's request shape differs from what Step 3 below assumes, update `parseSessionId` / the request body in `opencodeClient.ts` accordingly before moving on — the tests in Step 2 use fixtures, so they'll keep passing either way, but the fixtures should be updated to match reality.

- [ ] **Step 2: Write the failing tests**

`src/search/searxngClient.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searxngSearch } from './searxngClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searxngSearch', () => {
  it('parses results from the JSON API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: 'Auer Dult Munich',
        results: [{ title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring fair dates' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searxngSearch('https://search.lehel.xyz', 'Auer Dult Munich');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://search.lehel.xyz/search?q=Auer%20Dult%20Munich&format=json'
    );
    expect(results).toEqual([
      { title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring fair dates' },
    ]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(searxngSearch('https://search.lehel.xyz', 'x')).rejects.toThrow('503');
  });
});
```

`src/search/opencodeClient.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractDates } from './opencodeClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractDates', () => {
  it('creates a session, sends the prompt, and parses the JSON reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ses_123' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [
            {
              type: 'text',
              text:
                'Here you go:\n{"events":[{"label":"Frühjahrsdult","startDate":"2026-04-11","endDate":"2026-05-11","sourceUrl":"https://auerdult.de"}]}',
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const events = await extractDates(
      'https://opencode.lehel.xyz',
      'test-key',
      'Auer Dult Munich',
      [{ title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring dates' }]
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://opencode.lehel.xyz/api/session',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://opencode.lehel.xyz/api/session/ses_123/message',
      expect.objectContaining({ method: 'POST' })
    );
    expect(events).toEqual([
      {
        label: 'Frühjahrsdult',
        startDate: '2026-04-11',
        endDate: '2026-05-11',
        sourceUrl: 'https://auerdult.de',
      },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/search`
Expected: FAIL — modules don't exist

- [ ] **Step 4: Write minimal implementation**

`src/search/searxngClient.ts`:

```ts
import type { SearchResult } from '../types';

export async function searxngSearch(baseUrl: string, query: string): Promise<SearchResult[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`searxng request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    results: Array<{ title: string; url: string; content?: string }>;
  };
  return data.results.map(r => ({ title: r.title, url: r.url, content: r.content ?? '' }));
}
```

`src/search/opencodeClient.ts`:

```ts
import type { SearchResult, ExtractedEvent } from '../types';

export async function extractDates(
  baseUrl: string,
  apiKey: string,
  query: string,
  results: SearchResult[]
): Promise<ExtractedEvent[]> {
  const sessionId = await createSession(baseUrl, apiKey);
  const replyText = await sendMessage(baseUrl, apiKey, sessionId, buildPrompt(query, results));
  return parseEvents(replyText);
}

async function createSession(baseUrl: string, apiKey: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`opencode session create failed: ${response.status}`);
  }
  const data = (await response.json()) as { id: string };
  return data.id;
}

async function sendMessage(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  text: string
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
  if (!response.ok) {
    throw new Error(`opencode message failed: ${response.status}`);
  }
  const data = (await response.json()) as { parts: Array<{ type: string; text?: string }> };
  const textPart = data.parts.find(p => p.type === 'text' && p.text);
  if (!textPart?.text) {
    throw new Error('opencode reply had no text part');
  }
  return textPart.text;
}

function buildPrompt(query: string, results: SearchResult[]): string {
  const resultsBlock = results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');
  return [
    `Extract every concrete date mentioned for "${query}" from these search results.`,
    `Respond with only JSON, no prose: {"events":[{"label":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sourceUrl":string}]}`,
    `If a result gives a single day, set startDate and endDate to the same date. If nothing is found, respond {"events":[]}.`,
    '',
    resultsBlock,
  ].join('\n');
}

function parseEvents(replyText: string): ExtractedEvent[] {
  const jsonMatch = replyText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('opencode reply did not contain JSON');
  }
  const parsed = JSON.parse(jsonMatch[0]) as { events: ExtractedEvent[] };
  return parsed.events;
}
```

`src/types.ts`:

```ts
export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface ExtractedEvent {
  label: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
  sourceUrl: string;
}

export interface CandidateEvent extends ExtractedEvent {
  id: string;
  status: 'candidate' | 'approved';
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/search`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/search/searxngClient.ts src/search/searxngClient.test.ts src/search/opencodeClient.ts src/search/opencodeClient.test.ts
git commit -m "feat: add searxng and opencode HTTP clients"
```

---

### Task 7: Search Orchestrator

**Files:**
- Create: `src/search/searchOrchestrator.ts`
- Test: `src/search/searchOrchestrator.test.ts`

**Interfaces:**
- Consumes: `searxngSearch`, `extractDates` (Task 6).
- Produces: `createSearchOrchestrator(deps): (query: string) => Promise<ExtractedEvent[]>`. Task 8 consumes this as `runQuery`.

- [ ] **Step 1: Write the failing test**

`src/search/searchOrchestrator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSearchOrchestrator } from './searchOrchestrator';

describe('createSearchOrchestrator', () => {
  it('searches then extracts, in order', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractDates = vi
      .fn()
      .mockResolvedValue([{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }]);

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('Auer Dult Munich');

    expect(searxngSearch).toHaveBeenCalledWith('Auer Dult Munich');
    expect(extractDates).toHaveBeenCalledWith('Auer Dult Munich', [{ title: 't', url: 'u', content: 'c' }]);
    expect(events).toEqual([{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }]);
  });

  it('skips extraction when search returns nothing', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([]);
    const extractDates = vi.fn();

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('nothing found query');

    expect(extractDates).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/search/searchOrchestrator.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Write minimal implementation**

`src/search/searchOrchestrator.ts`:

```ts
import type { SearchResult, ExtractedEvent } from '../types';

export interface SearchOrchestratorDeps {
  searxngSearch: (query: string) => Promise<SearchResult[]>;
  extractDates: (query: string, results: SearchResult[]) => Promise<ExtractedEvent[]>;
}

export function createSearchOrchestrator(
  deps: SearchOrchestratorDeps
): (query: string) => Promise<ExtractedEvent[]> {
  return async function runQuery(query: string): Promise<ExtractedEvent[]> {
    const results = await deps.searxngSearch(query);
    if (results.length === 0) {
      return [];
    }
    return deps.extractDates(query, results);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/search/searchOrchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/search/searchOrchestrator.ts src/search/searchOrchestrator.test.ts
git commit -m "feat: add search orchestrator composing searxng and opencode"
```

---

### Task 8: Queries — create + candidate list

**Files:**
- Create: `src/queries/queriesRepo.ts`, `src/queries/routes.ts`
- Modify: `src/app.ts` — wire orchestrator + query routes into `AppDeps`
- Test: `src/queries/queriesRepo.test.ts`, `src/queries/routes.test.ts`

**Interfaces:**
- Consumes: `CandidateEvent`/`ExtractedEvent` (Task 6 types), `runQuery` (Task 7), `createRequireAuth` (Task 4).
- Produces: `createQueryWithCandidates(pool, userId, queryText, events): Promise<{queryId, candidates}>`. Task 10 (approve) consumes the `queries`/`events` tables this writes to.

- [ ] **Step 1: Write the failing tests**

`src/queries/queriesRepo.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from './queriesRepo';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('createQueryWithCandidates', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (email) values ('d@example.com') returning id`
    );
    userId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserts the query and one candidate row per event', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(pool, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
    ]);

    expect(queryId).toBeTruthy();
    expect(candidates).toHaveLength(2);
    expect(candidates.every(c => c.status === 'candidate')).toBe(true);

    const stored = await pool.query('select count(*) from events where query_id = $1', [queryId]);
    expect(Number(stored.rows[0].count)).toBe(2);
  });
});
```

`src/queries/routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';

describe('POST /api/queries', () => {
  it('requires auth', async () => {
    const app = buildApp({
      pool: {} as any,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      runQuery: vi.fn(),
    });

    const response = await app.inject({ method: 'POST', url: '/api/queries', payload: { text: 'x' } });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/queries`
Expected: FAIL — modules don't exist / `runQuery` not accepted by `AppDeps`

- [ ] **Step 3: Write minimal implementation**

`src/queries/queriesRepo.ts`:

```ts
import type { Pool } from 'pg';
import type { ExtractedEvent, CandidateEvent } from '../types';

export async function createQueryWithCandidates(
  pool: Pool,
  userId: string,
  queryText: string,
  events: ExtractedEvent[]
): Promise<{ queryId: string; candidates: CandidateEvent[] }> {
  const queryResult = await pool.query<{ id: string }>(
    `insert into queries (user_id, query_text) values ($1, $2) returning id`,
    [userId, queryText]
  );
  const queryId = queryResult.rows[0].id;

  const candidates: CandidateEvent[] = [];
  for (const event of events) {
    const eventResult = await pool.query<{ id: string; status: 'candidate' | 'approved' }>(
      `insert into events (query_id, label, start_date, end_date, source_url)
       values ($1, $2, $3, $4, $5)
       returning id, status`,
      [queryId, event.label, event.startDate, event.endDate, event.sourceUrl]
    );
    candidates.push({ ...event, id: eventResult.rows[0].id, status: eventResult.rows[0].status });
  }

  return { queryId, candidates };
}
```

`src/queries/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createQueryWithCandidates } from './queriesRepo';
import type { ExtractedEvent } from '../types';
import type { preHandlerHookHandler } from 'fastify';

export interface QueryRouteDeps {
  pool: Pool;
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
  requireAuth: preHandlerHookHandler;
}

export function registerQueryRoutes(app: FastifyInstance, deps: QueryRouteDeps): void {
  app.post<{ Body: { text: string } }>(
    '/api/queries',
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) {
        return reply.code(400).send({ error: 'text is required' });
      }
      const events = await deps.runQuery(text);
      const { queryId, candidates } = await createQueryWithCandidates(
        deps.pool,
        request.userId!,
        text,
        events
      );
      return reply.send({ queryId, candidates });
    }
  );
}
```

`src/app.ts` — add to `AppDeps` and wire in:

```ts
// add to imports
import { registerQueryRoutes } from './queries/routes';
import { createRequireAuth } from './auth/session';
import type { ExtractedEvent } from './types';

// AppDeps gains:
export interface AppDeps {
  pool: Pool;
  emailSender: EmailSender;
  publicBaseUrl: string;
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
}

// inside buildApp, after sessionService is created:
const requireAuth = createRequireAuth(sessionService);
registerQueryRoutes(app, { pool: deps.pool, runQuery: deps.runQuery, requireAuth });
```

`src/server.ts` — construct the real orchestrator and pass it in:

```ts
// add imports
import { searxngSearch } from './search/searxngClient';
import { extractDates } from './search/opencodeClient';
import { createSearchOrchestrator } from './search/searchOrchestrator';

// before buildApp(...):
const runQuery = createSearchOrchestrator({
  searxngSearch: query => searxngSearch(process.env.SEARXNG_BASE_URL!, query),
  extractDates: (query, results) =>
    extractDates(process.env.OPENCODE_BASE_URL!, process.env.OPENCODE_API_KEY!, query, results),
});

// add `runQuery` to the buildApp({...}) call
```

Also update `src/app.test.ts`, `src/auth/routes.test.ts` to pass `runQuery: async () => []` in their `buildApp(...)` calls, since `AppDeps` now requires it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS across the whole suite

- [ ] **Step 5: Commit**

```bash
git add src/queries/queriesRepo.ts src/queries/queriesRepo.test.ts src/queries/routes.ts src/queries/routes.test.ts src/app.ts src/app.test.ts src/auth/routes.test.ts src/server.ts
git commit -m "feat: add POST /api/queries running the search orchestrator synchronously"
```

---

### Task 9: Feed building blocks — token, ICS, RSS

**Files:**
- Create: `src/feed/feedToken.ts`, `src/feed/icsGenerator.ts`, `src/feed/rssGenerator.ts`
- Test: `src/feed/feedToken.test.ts`, `src/feed/icsGenerator.test.ts`, `src/feed/rssGenerator.test.ts`

**Interfaces:**
- Produces: `getOrCreateFeedToken(pool, userId): Promise<string>`, `buildIcs(events: CandidateEvent[]): string`, `buildRss(events: CandidateEvent[], feedBaseUrl: string): string`. Task 10 consumes all three.

- [ ] **Step 1: Write the failing tests**

`src/feed/feedToken.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { getOrCreateFeedToken } from './feedToken';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('getOrCreateFeedToken', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (email) values ('e@example.com') returning id`
    );
    userId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a token once and reuses it on subsequent calls', async () => {
    const first = await getOrCreateFeedToken(pool, userId);
    const second = await getOrCreateFeedToken(pool, userId);
    expect(first).toBe(second);

    const rows = await pool.query('select count(*) from feed_tokens where user_id = $1', [userId]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });
});
```

`src/feed/icsGenerator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildIcs } from './icsGenerator';
import type { CandidateEvent } from '../types';

describe('buildIcs', () => {
  it('renders one VEVENT per approved event', () => {
    const events: CandidateEvent[] = [
      { id: '1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de', status: 'approved' },
      { id: '2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de', status: 'approved' },
    ];

    const ics = buildIcs(events);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toContain('SUMMARY:Frühjahrsdult');
  });
});
```

`src/feed/rssGenerator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRss } from './rssGenerator';
import type { CandidateEvent } from '../types';

describe('buildRss', () => {
  it('renders one item per approved event', () => {
    const events: CandidateEvent[] = [
      { id: '1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de', status: 'approved' },
    ];

    const rss = buildRss(events, 'https://dontforget.lehel.xyz/f/abc');

    expect(rss).toContain('<rss');
    expect((rss.match(/<item>/g) ?? []).length).toBe(1);
    expect(rss).toContain('Frühjahrsdult');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/feed`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Write minimal implementation**

`src/feed/feedToken.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export async function getOrCreateFeedToken(pool: Pool, userId: string): Promise<string> {
  const candidateToken = randomBytes(24).toString('hex');
  const result = await pool.query<{ token: string }>(
    `insert into feed_tokens (user_id, token) values ($1, $2)
     on conflict (user_id) do update set user_id = excluded.user_id
     returning token`,
    [userId, candidateToken]
  );
  return result.rows[0].token;
}
```

(The `on conflict` clause never touches the `token` column, so `RETURNING` always yields the *existing* token when one is already there — atomic, race-safe, single round trip.)

`src/feed/icsGenerator.ts`:

```ts
import { createEvents, type EventAttributes } from 'ics';
import type { CandidateEvent } from '../types';

export function buildIcs(events: CandidateEvent[]): string {
  const { error, value } = createEvents(events.map(toIcsEvent));
  if (error || !value) {
    throw new Error(`failed to build ICS: ${error?.message ?? 'unknown error'}`);
  }
  return value;
}

function toIcsEvent(event: CandidateEvent): EventAttributes {
  return {
    title: event.label,
    start: toDateArray(event.startDate),
    end: toDateArray(addDays(event.endDate, 1)), // DTEND is exclusive for all-day events
    url: event.sourceUrl,
  };
}

function toDateArray(isoDate: string): [number, number, number] {
  const [y, m, d] = isoDate.split('-').map(Number);
  return [y, m, d];
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
```

`src/feed/rssGenerator.ts`:

```ts
import { Feed } from 'feed';
import type { CandidateEvent } from '../types';

export function buildRss(events: CandidateEvent[], feedBaseUrl: string): string {
  const feed = new Feed({
    title: 'dontforget',
    id: feedBaseUrl,
    link: feedBaseUrl,
    description: 'Approved recurring-event dates',
    copyright: '',
  });

  for (const event of events) {
    feed.addItem({
      title: `${event.label} — ${event.startDate}`,
      id: event.id,
      link: event.sourceUrl,
      description: `${event.startDate} to ${event.endDate}`,
      date: new Date(`${event.startDate}T00:00:00Z`),
    });
  }

  return feed.rss2();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/feed`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feed/feedToken.ts src/feed/feedToken.test.ts src/feed/icsGenerator.ts src/feed/icsGenerator.test.ts src/feed/rssGenerator.ts src/feed/rssGenerator.test.ts
git commit -m "feat: add feed token minting and ICS/RSS generators"
```

---

### Task 10: Approve events + feed routes

**Files:**
- Create: `src/queries/approveEvents.ts`, `src/feed/routes.ts`
- Modify: `src/queries/routes.ts` — add the approve endpoint
- Modify: `src/app.ts` — register feed routes
- Test: `src/queries/approveEvents.test.ts`, `src/feed/routes.test.ts`

**Interfaces:**
- Consumes: `getOrCreateFeedToken`, `buildIcs`, `buildRss` (Task 9).
- Produces: `approveEvents(pool, userId, queryId, eventIds, publicBaseUrl): Promise<{icsUrl,rssUrl}|null>`.

- [ ] **Step 1: Write the failing tests**

`src/queries/approveEvents.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from './queriesRepo';
import { approveEvents } from './approveEvents';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('approveEvents', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (email) values ('f@example.com') returning id`
    );
    userId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('approves only the selected events and returns feed URLs', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(pool, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    const result = await approveEvents(
      pool,
      userId,
      queryId,
      [candidates[0].id],
      'http://localhost:3000'
    );

    expect(result).not.toBeNull();
    expect(result!.icsUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.ics$/);
    expect(result!.rssUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.rss$/);

    const statuses = await pool.query('select status from events where query_id = $1 order by start_date', [
      queryId,
    ]);
    expect(statuses.rows.map(r => r.status)).toEqual(['approved', 'candidate']);
  });

  it('returns null for a query the user does not own', async () => {
    const { rows: otherUser } = await pool.query<{ id: string }>(
      `insert into users (email) values ('g@example.com') returning id`
    );
    const { queryId } = await createQueryWithCandidates(pool, otherUser[0].id, 'Not yours', []);

    const result = await approveEvents(pool, userId, queryId, [], 'http://localhost:3000');
    expect(result).toBeNull();
  });
});
```

`src/feed/routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { approveEvents } from '../queries/approveEvents';
import { registerFeedRoutes } from './routes';
import Fastify from 'fastify';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dontforget:dontforget@localhost:5432/dontforget';

describe('feed routes', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate magic_links, sessions, feed_tokens, events, queries, users cascade');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('serves ICS and RSS for a valid token, 404 for an unknown one', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (email) values ('h@example.com') returning id`
    );
    const userId = rows[0].id;
    const { queryId, candidates } = await createQueryWithCandidates(pool, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(pool, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { pool });

    const icsResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(icsResponse.statusCode).toBe(200);
    expect(icsResponse.body).toContain('Frühjahrsdult');

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.statusCode).toBe(200);
    expect(rssResponse.body).toContain('<rss');

    const missing = await app.inject({ method: 'GET', url: '/f/does-not-exist.ics' });
    expect(missing.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/queries/approveEvents.test.ts src/feed/routes.test.ts`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Write minimal implementation**

`src/queries/approveEvents.ts`:

```ts
import type { Pool } from 'pg';
import { getOrCreateFeedToken } from '../feed/feedToken';

export async function approveEvents(
  pool: Pool,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string
): Promise<{ icsUrl: string; rssUrl: string } | null> {
  const ownership = await pool.query('select id from queries where id = $1 and user_id = $2', [
    queryId,
    userId,
  ]);
  if (ownership.rows.length === 0) {
    return null;
  }

  if (eventIds.length > 0) {
    await pool.query(
      `update events set status = 'approved' where query_id = $1 and id = any($2::uuid[])`,
      [queryId, eventIds]
    );
  }

  const token = await getOrCreateFeedToken(pool, userId);
  return {
    icsUrl: `${publicBaseUrl}/f/${token}.ics`,
    rssUrl: `${publicBaseUrl}/f/${token}.rss`,
  };
}
```

`src/feed/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildIcs } from './icsGenerator';
import { buildRss } from './rssGenerator';
import type { CandidateEvent } from '../types';

export interface FeedRouteDeps {
  pool: Pool;
}

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  app.get<{ Params: { tokenWithExt: string } }>('/f/:tokenWithExt', async (request, reply) => {
    const raw = request.params.tokenWithExt;
    const icsMatch = raw.match(/^(.+)\.ics$/);
    const rssMatch = raw.match(/^(.+)\.rss$/);
    const token = icsMatch?.[1] ?? rssMatch?.[1];
    if (!token) {
      return reply.code(404).send();
    }

    const tokenRow = await deps.pool.query<{ user_id: string }>(
      'select user_id from feed_tokens where token = $1',
      [token]
    );
    if (tokenRow.rows.length === 0) {
      return reply.code(404).send();
    }

    const eventsResult = await deps.pool.query<CandidateEvent & { start_date: string; end_date: string; source_url: string }>(
      `select e.id, e.label, e.start_date, e.end_date, e.source_url, e.status
       from events e
       join queries q on q.id = e.query_id
       where q.user_id = $1 and e.status = 'approved'`,
      [tokenRow.rows[0].user_id]
    );
    const events: CandidateEvent[] = eventsResult.rows.map(r => ({
      id: r.id,
      label: r.label,
      startDate: r.start_date,
      endDate: r.end_date,
      sourceUrl: r.source_url,
      status: 'approved',
    }));

    if (icsMatch) {
      reply.header('Content-Type', 'text/calendar');
      return reply.send(buildIcs(events));
    }
    reply.header('Content-Type', 'application/rss+xml');
    return reply.send(buildRss(events, `${request.protocol}://${request.hostname}/f/${token}`));
  });
}
```

`src/queries/routes.ts` — add the approve endpoint:

```ts
// add import
import { approveEvents } from './approveEvents';

// inside registerQueryRoutes, after the POST /api/queries handler:
app.post<{ Params: { id: string }; Body: { eventIds: string[] } }>(
  '/api/queries/:id/approve',
  { preHandler: deps.requireAuth },
  async (request, reply) => {
    const result = await approveEvents(
      deps.pool,
      request.userId!,
      request.params.id,
      request.body.eventIds ?? [],
      deps.publicBaseUrl
    );
    if (!result) {
      return reply.code(403).send({ error: 'not your query' });
    }
    return reply.send(result);
  }
);
```

`QueryRouteDeps` in `src/queries/routes.ts` gains `publicBaseUrl: string`; `src/app.ts`'s call to `registerQueryRoutes` passes `publicBaseUrl: deps.publicBaseUrl`, and gains a call to `registerFeedRoutes(app, { pool: deps.pool })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS across the whole suite

- [ ] **Step 5: Commit**

```bash
git add src/queries/approveEvents.ts src/queries/approveEvents.test.ts src/feed/routes.ts src/feed/routes.test.ts src/queries/routes.ts src/app.ts
git commit -m "feat: add per-event approval and public ICS/RSS feed endpoints"
```

---

### Task 11: Frontend scaffolding + state machine

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/tsconfig.json`
- Create: `web/src/types.ts`, `web/src/state.ts`
- Test: `web/src/state.test.ts`

**Interfaces:**
- Produces: `WorkspaceState`, `WorkspaceEvent`, `reducer(state, event): WorkspaceState`. Task 12/13/14 consume this.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "dontforget-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "vite": "^5.2.11",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "jsdom": "^24.0.0"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`**

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/f': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>dontforget</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Install dependencies**

Run: `cd web && npm install`

- [ ] **Step 4: Write the failing test**

`web/src/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';

describe('reducer', () => {
  it('moves from empty to loading on SUBMIT_QUERY', () => {
    const state: WorkspaceState = { kind: 'empty' };
    const next = reducer(state, { type: 'SUBMIT_QUERY', text: 'Auer Dult Munich' });
    expect(next).toEqual({ kind: 'loading', queryText: 'Auer Dult Munich' });
  });

  it('moves from loading to review with all candidates pre-selected', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Auer Dult Munich' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate' },
      ],
    });
    expect(next).toEqual({
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
    });
  });

  it('toggles one candidate without touching the others', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
        { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
    };
    const next = reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e2' });
    expect(next).toEqual({
      ...state,
      candidates: [state.candidates[0], { ...state.candidates[1], selected: false }],
    });
  });

  it('moves from review to feedReady keeping only selected candidates', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
        { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', selected: false },
      ],
    };
    const next = reducer(state, {
      type: 'APPROVE_RESOLVED',
      icsUrl: 'https://x/f/t.ics',
      rssUrl: 'https://x/f/t.rss',
    });
    expect(next).toEqual({
      kind: 'feedReady',
      icsUrl: 'https://x/f/t.ics',
      rssUrl: 'https://x/f/t.rss',
      approved: [state.candidates[0]],
    });
  });

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e1' })).toBe(state);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd web && npx vitest run src/state.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 6: Write minimal implementation**

`web/src/types.ts`:

```ts
export interface CandidateEvent {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  status: 'candidate' | 'approved';
}
```

`web/src/state.ts`:

```ts
import type { CandidateEvent } from './types';

export interface SelectableCandidate extends CandidateEvent {
  selected: boolean;
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'empty' }
  | { kind: 'loading'; queryText: string }
  | { kind: 'review'; queryId: string; candidates: SelectableCandidate[] }
  | { kind: 'feedReady'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] };

export type WorkspaceEvent =
  | { type: 'SUBMIT_QUERY'; text: string }
  | { type: 'QUERY_RESOLVED'; queryId: string; candidates: CandidateEvent[] }
  | { type: 'TOGGLE_CANDIDATE'; id: string }
  | { type: 'APPROVE_RESOLVED'; icsUrl: string; rssUrl: string };

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'SUBMIT_QUERY':
      if (state.kind !== 'empty') return state;
      return { kind: 'loading', queryText: event.text };

    case 'QUERY_RESOLVED':
      if (state.kind !== 'loading') return state;
      return {
        kind: 'review',
        queryId: event.queryId,
        candidates: event.candidates.map(c => ({ ...c, selected: true })),
      };

    case 'TOGGLE_CANDIDATE':
      if (state.kind !== 'review') return state;
      return {
        ...state,
        candidates: state.candidates.map(c => (c.id === event.id ? { ...c, selected: !c.selected } : c)),
      };

    case 'APPROVE_RESOLVED':
      if (state.kind !== 'review') return state;
      return {
        kind: 'feedReady',
        icsUrl: event.icsUrl,
        rssUrl: event.rssUrl,
        approved: state.candidates.filter(c => c.selected),
      };

    default:
      return state;
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd web && npx vitest run src/state.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/package.json web/tsconfig.json web/vite.config.ts web/index.html web/src/types.ts web/src/state.ts web/src/state.test.ts
git commit -m "feat: scaffold frontend and add workspace state machine"
```

---

### Task 12: API client

**Files:**
- Create: `web/src/api.ts`
- Test: `web/src/api.test.ts`

**Interfaces:**
- Produces: `requestMagicLink(email): Promise<void>`, `checkSession(): Promise<boolean>`, `submitQuery(text): Promise<{queryId, candidates}>`, `approveEvents(queryId, eventIds): Promise<{icsUrl, rssUrl}>`, `class ApiError extends Error`. Task 14 (`main.ts`) consumes all of these.

- [ ] **Step 1: Write the failing test**

`web/src/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestMagicLink, checkSession, submitQuery, approveEvents, ApiError } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('requestMagicLink posts the email', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await requestMagicLink('a@example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/magic-link',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })
    );
  });

  it('checkSession returns true only on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(await checkSession()).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await checkSession()).toBe(false);
  });

  it('submitQuery parses the JSON body on success', async () => {
    const body = { queryId: 'q1', candidates: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await submitQuery('Auer Dult Munich')).toEqual(body);
  });

  it('approveEvents throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(approveEvents('q1', ['e1'])).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/api.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Write minimal implementation**

`web/src/api.ts`:

```ts
import type { CandidateEvent } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json() as Promise<T>;
}

export async function requestMagicLink(email: string): Promise<void> {
  const response = await fetch('/api/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'failed to request link');
  }
}

export async function checkSession(): Promise<boolean> {
  const response = await fetch('/api/me', { credentials: 'include' });
  return response.ok;
}

export async function submitQuery(
  text: string
): Promise<{ queryId: string; candidates: CandidateEvent[] }> {
  const response = await fetch('/api/queries', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return handle(response);
}

export async function approveEvents(
  queryId: string,
  eventIds: string[]
): Promise<{ icsUrl: string; rssUrl: string }> {
  const response = await fetch(`/api/queries/${queryId}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIds }),
  });
  return handle(response);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/api.test.ts
git commit -m "feat: add frontend API client"
```

---

### Task 13: Workspace renderer

**Files:**
- Create: `web/src/render.ts`
- Test: `web/src/render.test.ts`

**Interfaces:**
- Consumes: `WorkspaceState` (Task 11).
- Produces: `renderWorkspace(container: HTMLElement, state: WorkspaceState, handlers: WorkspaceHandlers): void`. Task 14 (`main.ts`) consumes this.

- [ ] **Step 1: Write the failing test**

`web/src/render.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderWorkspace, type WorkspaceHandlers } from './render';

function noopHandlers(): WorkspaceHandlers {
  return {
    onRequestMagicLink: vi.fn(),
    onSubmitQuery: vi.fn(),
    onToggleCandidate: vi.fn(),
    onApprove: vi.fn(),
  };
}

describe('renderWorkspace', () => {
  it('renders the sign-in state and wires the magic-link handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'signedOut' }, handlers);

    expect(container.textContent).toContain('Sign in');
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!;
    input.value = 'a@example.com';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onRequestMagicLink).toHaveBeenCalledWith('a@example.com');
  });

  it('renders the empty workspace and submits a query on enter', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'empty' }, handlers);

    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    input.value = 'Auer Dult Munich';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich');
  });

  it('renders the loading state', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());
    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toMatch(/searching/i);
  });

  it('renders candidate rows and toggles on click', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate', selected: true },
        ],
      },
      handlers
    );

    expect(container.textContent).toContain('Frühjahrsdult');
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    expect(handlers.onToggleCandidate).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve]')!.click();
    expect(handlers.onApprove).toHaveBeenCalled();
  });

  it('renders the feed-ready state with both URLs', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'feedReady',
        icsUrl: 'https://x/f/t.ics',
        rssUrl: 'https://x/f/t.rss',
        approved: [],
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('https://x/f/t.ics');
    expect(container.textContent).toContain('https://x/f/t.rss');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/render.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Write minimal implementation**

`web/src/render.ts`:

```ts
import type { WorkspaceState } from './state';

export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string) => void;
  onToggleCandidate: (id: string) => void;
  onApprove: () => void;
}

export function renderWorkspace(
  container: HTMLElement,
  state: WorkspaceState,
  handlers: WorkspaceHandlers
): void {
  container.innerHTML = '';
  container.appendChild(render(state, handlers));
}

function render(state: WorkspaceState, handlers: WorkspaceHandlers): HTMLElement {
  switch (state.kind) {
    case 'signedOut':
      return renderSignedOut(handlers);
    case 'empty':
      return renderEmpty(handlers);
    case 'loading':
      return renderLoading(state.queryText);
    case 'review':
      return renderReview(state.candidates, handlers);
    case 'feedReady':
      return renderFeedReady(state.icsUrl, state.rssUrl);
  }
}

function renderSignedOut(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <h1>Sign in</h1>
    <p>No password — we'll email you a link.</p>
    <form>
      <input type="email" name="email" placeholder="you@example.com" required />
      <button type="submit">Email me a link</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const email = wrapper.querySelector<HTMLInputElement>('input[type=email]')!.value;
    handlers.onRequestMagicLink(email);
  });
  return wrapper;
}

function renderEmpty(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form>
      <input name="query" placeholder="What do you want to track?" required />
      <button type="submit">Search</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  return wrapper;
}

function renderLoading(queryText: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <span class="chip">${escapeHtml(queryText)}</span>
    <p>Searching → extracting dates…</p>
  `;
  return wrapper;
}

function renderReview(
  candidates: Array<{ id: string; label: string; startDate: string; endDate: string; sourceUrl: string; selected: boolean }>,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');
  const rows = candidates
    .map(
      c => `
      <div class="cand-row" data-id="${c.id}">
        <input type="checkbox" ${c.selected ? 'checked' : ''} />
        <span>${escapeHtml(c.startDate)}–${escapeHtml(c.endDate)} · ${escapeHtml(c.label)}</span>
        <a href="${escapeHtml(c.sourceUrl)}">source</a>
      </div>`
    )
    .join('');
  wrapper.innerHTML = `
    ${rows}
    <button type="button" data-action="approve">Approve selected (${candidates.filter(c => c.selected).length})</button>
  `;
  wrapper.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      const id = checkbox.closest<HTMLElement>('.cand-row')!.dataset.id!;
      handlers.onToggleCandidate(id);
    });
  });
  wrapper.querySelector('button[data-action=approve]')!.addEventListener('click', () => {
    handlers.onApprove();
  });
  return wrapper;
}

function renderFeedReady(icsUrl: string, rssUrl: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <p>Future runs add new dates automatically — nothing to approve next time.</p>
    <div>ICS: <a href="${escapeHtml(icsUrl)}">${escapeHtml(icsUrl)}</a></div>
    <div>RSS: <a href="${escapeHtml(rssUrl)}">${escapeHtml(rssUrl)}</a></div>
  `;
  return wrapper;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/render.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/render.ts web/src/render.test.ts
git commit -m "feat: add workspace renderer for all five journey states"
```

---

### Task 14: End-to-end wiring + manual verification

**Files:**
- Create: `web/src/main.ts`
- Modify: `src/server.ts` — serve the built frontend as static files in production
- Modify: `src/email/EmailSender.ts` usage in `src/server.ts` — dev fallback logs the link to the console instead of silently capturing it
- Create/modify: root `README.md` — "Running locally" section

**Interfaces:**
- Consumes: everything from Tasks 11–13.
- Produces: a runnable app. No new exported interfaces — this is the integration task.

- [ ] **Step 1: Wire `web/src/main.ts`**

```ts
import { reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import { requestMagicLink, checkSession, submitQuery, approveEvents } from './api';

const root = document.getElementById('root')!;

let state: WorkspaceState = { kind: 'signedOut' };

function setState(next: WorkspaceState) {
  state = next;
  paint();
}

function paint() {
  renderWorkspace(root, state, {
    onRequestMagicLink: email => {
      requestMagicLink(email).then(() => {
        root.innerHTML = '<p>Check your inbox — the link signs you in.</p>';
      });
    },
    onSubmitQuery: text => {
      setState(reducer(state, { type: 'SUBMIT_QUERY', text }));
      submitQuery(text).then(({ queryId, candidates }) => {
        setState(reducer(state, { type: 'QUERY_RESOLVED', queryId, candidates }));
      });
    },
    onToggleCandidate: id => {
      setState(reducer(state, { type: 'TOGGLE_CANDIDATE', id }));
    },
    onApprove: () => {
      if (state.kind !== 'review') return;
      const eventIds = state.candidates.filter(c => c.selected).map(c => c.id);
      approveEvents(state.queryId, eventIds).then(({ icsUrl, rssUrl }) => {
        setState(reducer(state, { type: 'APPROVE_RESOLVED', icsUrl, rssUrl }));
      });
    },
  });
}

checkSession().then(authenticated => {
  setState(authenticated ? { kind: 'empty' } : { kind: 'signedOut' });
});
```

- [ ] **Step 2: Serve the built frontend from the backend in production**

`src/server.ts` — add near the top-level route registration (after `buildApp` returns `app`, before `app.listen`):

```ts
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// after `const app = buildApp({...})`:
if (process.env.NODE_ENV === 'production') {
  app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'),
  });
}
```

- [ ] **Step 3: Dev-friendly email fallback**

`src/email/EmailSender.ts` — add a console-logging implementation alongside the existing two:

```ts
export class ConsoleEmailSender implements EmailSender {
  async send(to: string, subject: string, body: string): Promise<void> {
    console.log(`\n--- email to ${to} ---\n${subject}\n${body}\n---\n`);
  }
}
```

`src/server.ts` — swap the dev fallback:

```ts
// replace `new CapturingEmailSender()` with:
new ConsoleEmailSender()
```

(and import `ConsoleEmailSender` instead of `CapturingEmailSender` there — `CapturingEmailSender` stays test-only.)

- [ ] **Step 4: Add "Running locally" to `README.md`**

Append:

```markdown
## Running locally

1. `docker compose -f docker-compose.dev.yml up -d db`
2. `cp .env.example .env` and fill in `SEARXNG_BASE_URL`, `OPENCODE_BASE_URL`, `OPENCODE_API_KEY`
   (see `docs/superpowers/plans/2026-08-09-first-time-user-journey.md` → External Service Reference
   for where to find the opencode key)
3. `npm install && npm run dev` (backend, port 3000)
4. `cd web && npm install && npm run dev` (frontend, Vite dev server, proxies `/api` and `/f` to :3000)
5. Open the Vite dev server URL. Submit an email — since no `SMTP_HOST` is set in dev, the magic
   link is printed to the backend's console instead of emailed. Copy the printed
   `/api/auth/callback?token=...` URL into the browser to sign in.
6. Type a query (e.g. "Auer Dult Munich") and submit. This calls the real `search.lehel.xyz` and
   `opencode.lehel.xyz` — no mocking in dev/prod, only in tests.
```

- [ ] **Step 5: Manual verification (this task's test — there is no automated end-to-end test in this plan)**

Run through README's "Running locally" steps yourself:
1. Backend and frontend dev servers both start without errors.
2. Landing on the app with no session shows the sign-in screen (Task 13's `signedOut` render).
3. Submitting an email logs a magic link to the backend console; opening it signs you in and lands on the empty workspace.
4. Submitting a real query shows the loading state, then either candidate rows or an empty review screen — confirm against `docs/design.md` §7's "Known gap" note if zero results come back, and re-check the External Service Reference's searxng section.
5. Unchecking a candidate and clicking "Approve selected" shows the feed-ready screen with two working URLs; open the ICS URL directly in the browser and confirm it downloads/renders a valid calendar file with the approved event(s) only.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.ts src/server.ts src/email/EmailSender.ts README.md
git commit -m "feat: wire frontend to backend end to end and document local setup"
```

---

## Self-Review

**Spec coverage** (`docs/design.md` §7 states, in order):
1. Sign in → Task 5 (routes) + Task 13 (`signedOut` render).
2. Empty workspace → Task 13 (`empty` render).
3. Submitted/loading → Task 8 (synchronous `/api/queries`) + Task 13 (`loading` render).
4. Candidate review, per-event checkboxes → Task 8 (candidates persisted as `candidate`) + Task 13 (`review` render + toggle).
5. Feed ready, both ICS and RSS → Task 9 (generators) + Task 10 (approve + feed routes) + Task 13 (`feedReady` render).
Magic-link auth (2026-08-09 addendum) → Task 3 + 4 + 5. All five states and all four §7 decisions have a task. No gaps.

**Placeholder scan:** no "TBD"/"implement later" strings in any task. The one deliberately-uncertain item — opencode's exact message-endpoint schema — is handled as a concrete, executable verification step (Task 6 Step 1) with real curl commands, not a vague placeholder, and is flagged prominently in the External Service Reference per the request to call this out explicitly.

**Type consistency:** `ExtractedEvent`/`CandidateEvent` (backend `src/types.ts`, Task 6) and the duplicated frontend `web/src/types.ts` (Task 11) use identical field names (`label`, `startDate`, `endDate`, `sourceUrl`, `id`, `status`) so `submitQuery`'s response shape lines up with `QUERY_RESOLVED`'s expected payload without transformation. `runQuery` is defined once (Task 7) and consumed with the same signature in Task 8's `AppDeps`. `requireAuth` is created once (Task 4) and consumed identically by Task 8 and Task 10's routes.
