# dontforget

Some events recur every year but never on the same date — Oktoberfest, the
Auer Dult in Munich, a touring artist's next concert. `dontforget` keeps a
standing search for events like these, re-runs it on a schedule, uses an AI
backend to extract real dates from the results, and publishes what you
approve as a calendar feed (ICS/RSS) you subscribe to once.

Status: architecture designed, implementation in progress (first-time user
journey — see [`docs/superpowers/plans/2026-08-09-first-time-user-journey.md`](docs/superpowers/plans/2026-08-09-first-time-user-journey.md)).

See [`docs/design.md`](docs/design.md) for the full high-level design
(architecture, components, open questions) and [`CLAUDE.md`](CLAUDE.md) for
a quick project-context summary.

## Running locally

1. `docker compose -f docker-compose.dev.yml up -d mongo`
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
