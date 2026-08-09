---
name: dontforget-test-runner
description: Use when running dontforget's test suite locally, verifying tests pass before committing, or hitting Mongo connection errors while testing
---

# dontforget Test Runner

## Overview

dontforget is two npm packages (root = backend, `web/` = frontend). Backend tests (`src/**/*.test.ts`) talk to a real MongoDB 8 instance — nothing is mocked at the DB layer. Frontend tests (`web/src/**/*.test.ts`) are pure/jsdom and need no database.

**Docker is only allowed on `servyy-test`, never on the local laptop.** The test database runs as a `mongo:8` Docker container on the shared `servyy-test.lxd` host, reached over SSH — mirroring `~/dev/leaguesphere/container/spinup_test_db.sh` exactly (same pattern, mariadb swapped for mongo). That host is shared across apps: another app (`job-search`) already binds host port 27017 with its own mongo:8 container, so dontforget's publishes on **27018** instead.

## When to Use

- Running the backend or frontend test suite locally
- Verifying changes don't break existing tests before committing
- Debugging `MongoServerSelectionError` / connection-timeout errors from `src/db/client.ts` in tests
- Setting up this repo for the first time

## Core Pattern

### 1. Start the test database

```bash
./scripts/spinup_test_db.sh
```

Ensures `servyy-test.lxd` is up, then creates/reuses a `dontforget-mongo` container on it, published on port 27018. Prints the container's IP and the `TEST_DATABASE_URL` to export — **capture it**, the IP changes if the LXD container is recreated.

Use `--fresh` to remove the container and start with an empty database:

```bash
./scripts/spinup_test_db.sh --fresh
```

### 2. Export the test database URL

```bash
export TEST_DATABASE_URL="mongodb://<IP-printed-above>:27018/dontforget-test"
```

Or capture it directly:

```bash
export TEST_DATABASE_URL="mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27018/dontforget-test"
```

### 3. Install dependencies (first time / after pulling dependency changes)

```bash
npm ci            # backend, from repo root
cd web && npm ci   # frontend
```

### 4. Run the tests

**Backend (from repo root):**
```bash
npm test
```

**Frontend (no DB needed):**
```bash
cd web && npm test
```

**Single backend file:**
```bash
npx vitest run src/auth/magicLink.test.ts
```

**Single test by name:**
```bash
npx vitest run src/auth/magicLink.test.ts -t "is single-use"
```

`vitest.config.ts` sets `fileParallelism: false` because every DB-touching test file shares the same database; running files in parallel would race on the same collections. If `TEST_DATABASE_URL` isn't exported, `src/testSupport.ts` falls back to `mongodb://localhost:27017/dontforget-test` — that only works if something else is forwarding that port locally; normally you want the exported servyy-test URL instead.

## Quick Reference

| Task | Command |
|---|---|
| Start/reuse test DB | `./scripts/spinup_test_db.sh` |
| Fresh test DB (wipe data) | `./scripts/spinup_test_db.sh --fresh` |
| Get DB IP | `lxc list servyy-test --format json \| jq -r '.[0].state.network.eth0.addresses[] \| select(.family=="inet") \| .address'` |
| Set TEST_DATABASE_URL | `export TEST_DATABASE_URL="mongodb://<IP>:27018/dontforget-test"` |
| Backend tests | `npm test` |
| Frontend tests | `cd web && npm test` |
| Single backend file | `npx vitest run src/path/to.test.ts` |
| Type-check backend | `npx tsc -p tsconfig.json --noEmit` |
| Type-check frontend | `cd web && npx tsc -p tsconfig.json --noEmit` |
| Mongo logs | `ssh servyy-test.lxd "docker logs dontforget-mongo"` |
| Connect manually | `mongosh "mongodb://<IP>:27018/dontforget-test"` |

## Complete Workflow

**One-time / per session setup:**
```bash
npm ci
cd web && npm ci && cd ..
./scripts/spinup_test_db.sh
export TEST_DATABASE_URL="mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27018/dontforget-test"
```

**Run tests (repeat as needed, DB persists):**
```bash
npm test
cd web && npm test
```

## Common Mistakes

**❌ Trying to run Mongo with local `docker`/`docker compose`**
- Error: `docker: command not found`, or a permission denial before that
- Cause: Docker is not installed/permitted on the local laptop — it's only allowed on `servyy-test`
- Fix: `./scripts/spinup_test_db.sh`, which does everything over SSH to `servyy-test.lxd`

**❌ Running `npm test` without exporting `TEST_DATABASE_URL`**
- Error: connection timeout in `beforeAll`, then `TypeError: Cannot read properties of undefined (reading 'close')` in `afterAll` (client never got assigned)
- Fix: export `TEST_DATABASE_URL` from step 2 before running tests

**❌ Assuming port 27017 on servyy-test**
- Error: connection refused, or you connect to the wrong app's database
- Cause: `job-search-mongo` already owns host port 27017 on the shared `servyy-test` host
- Fix: dontforget's container publishes on **27018** — use that port

**❌ Reusing a stale `TEST_DATABASE_URL` after `servyy-test` was recreated**
- Symptom: connection refused / timeout even though `spinup_test_db.sh` reported success
- Cause: the LXD container's IP changed
- Fix: re-export `TEST_DATABASE_URL` using the IP `spinup_test_db.sh` just printed

**❌ Running backend and frontend tests as one `npm test` from root**
- They're separate npm packages with separate `package.json`/`vitest.config.ts` — frontend tests must be run from `web/`, not root

**❌ Editing a migration file and expecting old data to pick it up**
- `src/db/migrate.ts` tracks applied migrations in a `schema_migrations` collection; a changed `001_init.ts` won't re-run against an already-migrated DB
- Fix: `./scripts/spinup_test_db.sh --fresh` to start from an empty database

## Troubleshooting

**Tests hang / time out in `beforeAll`:**
```bash
# Is servyy-test up, and is the container running?
lxc list servyy-test
ssh servyy-test.lxd "docker ps -a --format '{{.Names}}: {{.Status}}'" | grep dontforget-mongo

# If not:
./scripts/spinup_test_db.sh --fresh
```

**Port already allocated when creating the container:**
```bash
# Something else on servyy-test is already using the port. Check what's bound:
ssh servyy-test.lxd "docker ps --format '{{.Names}}: {{.Ports}}'"

# Pick a free host port and update HOST_PORT in scripts/spinup_test_db.sh
```

**"Collection already exists" / `NamespaceExists` migration errors:**
This was a real bug (unconditional `createCollection` on every `runMigrations()` call) — fixed in `src/db/migrate.ts`. If it recurs, check that fix wasn't reverted.

**Connect manually to poke at data:**
```bash
mongosh "mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27018/dontforget-test"
```
