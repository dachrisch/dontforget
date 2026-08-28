# CLAUDE.md — dontforget

> Recurring event reminder service: search + AI extraction of dates,
> published as a calendar/RSS feed.
> Status: architecture approved, pre-implementation. See `docs/design.md`
> for the full design.

## What this is

The user searches once for something that recurs on unpredictable dates
(Oktoberfest, the Auer Dult in Munich, a touring artist's next concert) and
saves it as a standing query. The service re-runs that search on a
schedule, asks `opencode` to extract real dates from the results, and
publishes approved dates as an ICS/RSS feed the user subscribes to once.

## External dependencies

Both already deployed in the `servyy-container` infra repo (sibling repo,
not a dependency of this codebase at build time):

- **searxng** — `https://search.lehel.xyz` — web search
- **opencode** — `https://code.lehel.xyz` — session-scoped date
  extraction only, via the `X-Api-Key` ForwardAuth gate (infra repo:
  `history/2026-08-08_opencode-api-key-forwardauth.md`). Never given
  autonomous search access — see design doc §4 for why.

## Key architecture decisions

- Multi-user from day one
- TypeScript / Node, full-stack
- Backend API is the single hub with credentials for searxng, opencode, and
  the database; a Search Orchestrator module drives searxng directly and
  hands opencode only text to extract from (never a live search tool)
- Approved queries auto-add new dates found on scheduled re-runs — no
  re-approval needed
- Feed URLs carry an unguessable per-user token, no login prompt for
  calendar clients

## Deployment

Application code lives here. Deployment automation (Ansible role, Traefik
routing, Docker Compose) lives in the `servyy-container` infra repo,
modeled on the `ls_app` role used for `leaguesphere`. Test on
`servyy-test.lxd` before `lehel.xyz`; production deploy requires explicit
approval per that repo's policy.

## Data model (sketch, not yet implemented)

- Users
- Queries — keyword/topic, recurrence interval, `last_run_at`
- Events — `candidate` \| `approved`, extracted date, source URL, query id
- Feed tokens — per-user unguessable token for ICS/RSS endpoints

## Open questions

Not yet decided — see `docs/design.md` §7:

- Notification mechanism when a re-run finds something new
- Whether RSS ships in v1 or ICS-first with RSS as a follow-up
- Rate limits / cost guardrails on opencode + searxng calls per query
