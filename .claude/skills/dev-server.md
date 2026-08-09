---
name: dontforget-dev-server
description: Use when starting dontforget's backend and frontend dev servers locally for manual testing or debugging
---

# dontforget Dev Server

## Overview

Running dontforget locally means a Fastify backend (port 3000) and a Vite frontend dev server, both talking to a MongoDB 8 container on the shared `servyy-test.lxd` host — Docker never runs on the local laptop directly. This skill covers getting both servers up against a persistent dev database.

**REQUIRED BACKGROUND:** See `.claude/skills/test-runner.md` for the parallel test-DB setup — same servyy-test host, same pattern, deliberately a *different* container (`dontforget-mongo-dev` on port 27019, not `dontforget-mongo` on 27018) so resetting one never wipes the other.

## When to Use

- Manual testing of the sign-in → query → approve → feed flow in a browser
- Debugging API endpoints against real data
- Interactive development while changing backend or frontend code
- Trying opencode/searxng integration against the real infra endpoints (there's no mocking outside tests)

## Core Pattern

### 1. Set up the dev database

```bash
./scripts/spinup_dev_db.sh
```

Creates/reuses the `dontforget-mongo-dev` container on `servyy-test.lxd`, port 27019. Prints the IP to use — **capture it**, it changes if `servyy-test` gets recreated. Data persists across sessions; don't pass `--fresh` unless you deliberately want to wipe it (unlike the test DB, which you reset routinely).

### 2. Configure the environment

```bash
export DATABASE_URL="mongodb://<IP-printed-above>:27019/dontforget"
export PUBLIC_BASE_URL="http://localhost:3000"
export SEARXNG_BASE_URL="https://search.lehel.xyz"
export SEARXNG_TOKEN="<container repo's ansible/plays/vars/secrets.yml, vault_searxng_brave_token>"
export OPENCODE_BASE_URL="https://opencode.lehel.xyz"
export OPENCODE_API_KEY="<container repo's ansible/plays/vars/secrets.yml, opencode.api_key>"
```

Both `SEARXNG_TOKEN` and `OPENCODE_API_KEY` are required to run a query end-to-end (searches call the real `search.lehel.xyz` and `opencode.lehel.xyz` — nothing is mocked outside tests). Without them, sign-in and the empty workspace still work; submitting a query will fail (or worse, silently return zero candidates — see Common Mistakes). Both values live in the `container` repo's `ansible/plays/vars/secrets.yml` (git-crypt encrypted, but plaintext on disk once unlocked).

Leave `SMTP_HOST` unset — see step 4.

### 3. Install dependencies (first time / after pulling dependency changes)

```bash
npm ci
cd web && npm ci && cd ..
```

### 4. Start both dev servers

```bash
npm run dev          # backend, http://localhost:3000 (tsx watch — restarts on save)
```

```bash
cd web && npm run dev  # frontend, Vite — proxies /api and /f to :3000
```

Run these in two terminals (or background one). With no `SMTP_HOST` set, `ConsoleEmailSender` prints magic-sign-in links to the backend's terminal instead of emailing them — copy the printed `/api/auth/callback?token=...` URL into the browser to sign in.

### 5. Open the app

Vite prints its own URL (typically `http://localhost:5173`) — open that, not port 3000 directly.

## Quick Reference

| Task | Command |
|---|---|
| Start/reuse dev DB | `./scripts/spinup_dev_db.sh` |
| Wipe dev DB (deliberate) | `./scripts/spinup_dev_db.sh --fresh` |
| Get dev DB IP | `lxc list servyy-test --format json \| jq -r '.[0].state.network.eth0.addresses[] \| select(.family=="inet") \| .address'` |
| Set DATABASE_URL | `export DATABASE_URL="mongodb://<IP>:27019/dontforget"` |
| Backend dev server | `npm run dev` (port 3000, restarts on save) |
| Frontend dev server | `cd web && npm run dev` (Vite, proxies to :3000) |
| Dev DB logs | `ssh servyy-test.lxd "docker logs dontforget-mongo-dev"` |
| Connect manually | `mongosh "mongodb://<IP>:27019/dontforget"` |

## Complete Startup Workflow

```bash
./scripts/spinup_dev_db.sh
export DATABASE_URL="mongodb://$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1):27019/dontforget"
export PUBLIC_BASE_URL="http://localhost:3000"
export SEARXNG_BASE_URL="https://search.lehel.xyz"
export OPENCODE_BASE_URL="https://opencode.lehel.xyz"
export OPENCODE_API_KEY="<real key>"

npm ci && cd web && npm ci && cd ..
npm run dev &
cd web && npm run dev
```

## Common Mistakes

**❌ Magic-link sign-in 404s with "Route GET:/ not found"**
- Was a real bug: the callback redirect was hardcoded to `/`, which only exists on the backend in production (serving the built frontend statically). Fixed — the callback now redirects to `FRONTEND_URL` (defaults to `http://localhost:5173` outside production). If this recurs, check that fix wasn't reverted in `src/auth/routes.ts` / `src/server.ts`.

**❌ Trying `docker compose up` locally**
- Error: `docker: command not found`, or a permission denial
- Fix: `./scripts/spinup_dev_db.sh` — Docker only runs on `servyy-test`

**❌ Opening `http://localhost:3000` in the browser**
- That's the backend API only, no UI. Open the Vite dev server's own URL instead.

**❌ Submitting a query with no `OPENCODE_API_KEY` set**
- The request will fail — `extractDates()` calls the real opencode API and needs the key
- Fix: export a real key before `npm run dev`

**❌ A query returns zero candidates with no error**
- Not a bug — this instance's search engines are SearXNG "private engines" and silently return nothing without a matching `SEARXNG_TOKEN`. See `src/search/searxngClient.ts`'s top comment.
- Fix: export `SEARXNG_TOKEN` before `npm run dev`

**❌ A query takes 10-40+ seconds, or times out / errors with an opencode 503**
- Expected latency: `extractDates()` polls opencode for the reply (create session → send prompt → poll `GET .../message` up to 30s) rather than getting it back inline — see `src/search/opencodeClient.ts`'s top comment for the confirmed API shape
- A "Provider request failed with HTTP 503: Endpoint is unavailable" or "opencode reply timed out" error is the upstream LLM provider being flaky, observed live 2026-08-09 — not a dontforget bug. Retry the query.

**❌ Reusing the *test* database's connection string for dev, or vice versa**
- `dontforget-mongo` (27018) is the test DB, reset routinely; `dontforget-mongo-dev` (27019) is dev, meant to persist
- Mixing them up means dev data vanishes on the next test run, or test runs pollute what you're looking at in the browser

**❌ Stale IP after `servyy-test` gets recreated**
- Symptom: `DATABASE_URL` connection refused even though the container is fine
- Fix: re-export `DATABASE_URL` using the current IP

## Troubleshooting

**Backend won't start / crashes on boot:**
```bash
# Is the dev DB actually up?
ssh servyy-test.lxd "docker ps --format '{{.Names}}: {{.Status}}'" | grep dontforget-mongo-dev

# If not:
./scripts/spinup_dev_db.sh
```

**Sign-in link never appears:**
Check the backend's terminal output, not email — `ConsoleEmailSender` is the dev fallback whenever `SMTP_HOST` is unset (see `src/server.ts`).

**Query submission fails / opencode errors:**
Confirm `OPENCODE_API_KEY` is set and current — see `.claude/skills/test-runner.md`'s "External Service Reference" pointer in `docs/superpowers/plans/2026-08-09-first-time-user-journey.md` for how the key is scoped (session-create + session-scoped chat only).

## Cleanup

**Stop servers:** `Ctrl+C` in each terminal.

**Dev DB persists** in its `servyy-test` container between sessions — nothing to redo next time except re-exporting `DATABASE_URL` if the IP changed.

**Reset dev data:** `./scripts/spinup_dev_db.sh --fresh` (deliberate — see Common Mistakes).
