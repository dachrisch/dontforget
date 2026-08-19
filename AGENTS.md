# AGENTS.md — dontforget

Recurring-event reminder service: standing searches re-run on a schedule, an
AI extracts dates, users approve, results publish as ICS/RSS feeds. TypeScript
/ Node full-stack. See `docs/design.md` for architecture; `CLAUDE.md` is a
design-era summary and is partly stale (this repo is well past
"pre-implementation").

## Two npm packages, never one

- Root = backend: Fastify on :3000, MongoDB 8, no frontend code. Entry:
  `src/server.ts` → `buildApp` in `src/app.ts`.
- `web/` = frontend: Vite + plain TS (no framework), jsdom tests. Own
  `package.json`, `tsconfig.json`, deps, test suite.

Each needs its own `npm ci` and has its own `npm test`. Running `npm test`
from the root only runs backend tests.

## Commands

| Task | Command |
|---|---|
| Backend tests | `npm test` (root) |
| Frontend tests | `cd web && npm test` |
| Single backend test | `npx vitest run src/path/to.test.ts [-t "name"]` |
| Typecheck backend | `npx tsc -p tsconfig.json --noEmit` |
| Typecheck frontend | `cd web && npx tsc -p tsconfig.json --noEmit` |
| Backend dev | `npm run dev` (tsx watch, :3000) |
| Frontend dev | `cd web && npm run dev` (Vite, proxies `/api` and `/f/` to :3000) |

## Tests need a real MongoDB — never local Docker

Backend tests hit a live `mongo:8` on the shared `servyy-test.lxd` host;
nothing is mocked at the DB layer. Docker is **not** available on the dev
laptop — use `./scripts/spinup_test_db.sh` (prints the URL to export) and
`./scripts/spinup_dev_db.sh` for dev. `.claude/skills/test-runner.md` and
`dev-server.md` are the authoritative runbooks — read them before running
tests or the dev servers.

**In sandboxed/agent environments without access to `servyy-test.lxd` (no
`lxc`, `zsh`, or Docker), backend tests cannot be run locally — do not
attempt to spin up a Mongo substitute. Let them run on CI instead; verify
backend changes with `npx tsc -p tsconfig.json --noEmit` and the frontend
suite (`cd web && npm test`) before pushing.**

- `vitest.config.ts` sets `fileParallelism: false`: every backend test file
  shares one database and wipes collections between cases. Do not re-enable
  parallelism.
- Dev (`DATABASE_URL`, port 27019) and test (`TEST_DATABASE_URL`, port 27018)
  are deliberately different containers; swapping them loses dev data on the
  next test run.
- CI runs an in-job mongo service and sets `TEST_DATABASE_URL` to
  `mongodb://localhost:27017/dontforget-test` — local runs must not use
  port 27017 (owned by another app on servyy-test).

## Env / dev gotchas

- `SEARXNG_TOKEN` missing → every search silently returns zero candidates,
  no error. `OPENCODE_API_KEY` missing → query submission errors.
- `SCHEDULER_ENABLED` defaults to true and runs on every server boot. Set it
  to `false` for local dev, or every `tsx watch` restart fires real
  searxng/opencode calls for any due query in the dev DB.
- No `SMTP_HOST` in dev → magic-link URL prints to the backend console;
  copy the `/api/auth/callback?token=...` URL into the browser.
- Open the Vite URL (:5173), not :3000 — the backend has no UI in dev. In
  production the backend serves `web/dist` via `@fastify/static`.

## Code conventions

- ESM with `.js` extensions on relative imports (e.g. `import { x } from './y.js'`),
  despite `moduleResolution: Bundler`. Keep that style.
- Database migrations in `src/migrations/` are tracked in the
  `schema_migrations` collection — editing an applied migration does not
  re-run it. Reset with `./scripts/spinup_test_db.sh --fresh`.
- Global rate limiting in `app.ts` must be `await app.register(...)`d
  *before* routes are registered (per-route hooks install via `onRoute`).
- No lint/format script; CI's gate is `npm run build` (tsc) + vitest for both
  packages.

## CI / release

- `ci_branch.yaml` builds+tests both packages and the Docker image on master
  pushes and all PRs; `ci.yaml` (tag push) additionally publishes
  `dachrisch/dontforget`.
- `release-please` auto-bumps versions on master via conventional commits
  (renovate uses `fix:`-style commits). Keep commits conventional.