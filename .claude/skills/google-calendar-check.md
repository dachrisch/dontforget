---
name: dontforget-google-calendar-check
description: Use when "Add to Google Calendar" isn't working for dontforget feeds — diagnostic checklist and known findings from investigating a silent/error subscribe failure
---

# dontforget Google Calendar Subscribe Check

## Overview

> **STATUS — root-caused and fixed 2026-08-23.** `webcal://` resolves to plain `http://`, dontforget's Traefik router listened only on `websecure`, so every calendar client got a 404 from Traefik before reaching the app. Fixed with an HTTP→HTTPS redirect router; confirmed by Google's own importer completing a scheduled fetch at 10:42:46Z the same day. **If "add to calendar" breaks again, this is a regression check first, an investigation second** — jump to step 2 and the Known Findings Log rather than re-running the whole checklist. Steps 3–6 exist mainly to record what was already eliminated.

dontforget offers three "add to calendar" buttons (`web/src/render.ts`): Google Calendar (`calendar.google.com/calendar/r?cid=webcal://...`), Apple Calendar (`webcal://` direct), Outlook (`outlook.live.com/calendar/.../addfromweb?url=...`). Google Calendar's "Add by URL" flow has been unreliable for dontforget's feeds in testing — this skill is the diagnostic checklist and the record of what's already been ruled out, so a future session doesn't redo the same multi-hour investigation from scratch.

**Symptom:** clicking "Add to Google Calendar" (or pasting the feed URL into Google Calendar Settings → Add calendar → From URL) does not result in the calendar appearing under "Other calendars" in Google Calendar. In desktop/automated browser testing this fails *silently* — no error shown, dialog just closes. On a real mobile device, Google Calendar does surface a visible toast: **"Oops, we couldn't add this calendar. Please try again in a few minutes."** (seen 2026-08-23) — meaning a request attempt does happen and fails, it's just invisible in the desktop flow.

## When to Use

- User reports "Add to Google Calendar" not working for a dontforget feed
- Verifying a fix to the feed/subscribe flow actually resolved it (don't declare it fixed without redoing steps 1–3 below)
- Before touching feed URL structure, ICS content, or server-side rate limiting in response to a Calendar-subscribe complaint — check whether it's actually a Google-side issue first

## Diagnostic Order (cheapest/most-decisive first)

### 1. Verify the feed itself is valid

```bash
curl -sD - -o /tmp/feed.ics "https://dontforget.lehel.xyz/f/<token>/dontforget.ics"
```
Check: `HTTP 200`, `content-type: text/calendar`, valid `BEGIN:VCALENDAR`/`VEVENT` structure. Also check CRLF compliance (RFC 5545 requires `\r\n`, not bare `\n` — invisible to `curl`/eyeballing but some strict parsers care):
```bash
python3 -c "
data = open('/tmp/feed.ics','rb').read()
print('CRLF:', data.count(b'\r\n'), 'bare LF:', sum(1 for i,b in enumerate(data) if b==10 and (i==0 or data[i-1]!=13)))
"
```
As of 2026-08-22 this has always been clean — not the cause.

### 2. Check production server logs for an actual fetch attempt

**Start with Traefik, not the app.** This single command is what cracked the original investigation and should be the first thing run for any future report — it is the *only* place Google's importer is observable at all:

```bash
ssh lehel.xyz 'docker logs traefik.traefik 2>&1 | grep -i "Calendar-Importer"'
```

Omit `--since` on the first pass: the full retained history reveals the poll *cadence* and whether a subscription exists at all, which a narrow window hides. Read `RequestScheme`, `entryPointName`, `DownstreamStatus` and `OriginStatus` on each line — `OriginStatus: 0` means Traefik answered by itself and the app never saw the request. See the Known Findings Log for how this played out.

Then check the app container for requests that actually made it through:

```bash
ssh lehel.xyz "docker logs dontforget.web --since <ISO8601>Z 2>&1 | grep 'url\":\"/f/'"
```
Every logged `/f/*` line is `{"req":{"method":...,"url":...,"remoteAddress":...}}` followed by a `{"res":{"statusCode":...}}` line with the same `reqId`. `remoteAddress` is usually `172.18.0.1` (Traefik's internal docker-network IP, since Traefik proxies to the app container) — **not useful for identifying the real external caller**; don't try to reverse-DNS it. But not always: a real importer fetch has been seen arriving with its true `66.249.x.x` address intact, so a non-`172.18.0.1` value here is a genuine signal worth reading, not noise.

**Why the ordering matters (this gap cost the original investigation ~two days):** checking only the app container's logs shows nothing when Traefik rejects a request *before* forwarding it — which looked exactly like "Google never even tried." Traefik logs independently (JSON, see `container` repo's `traefik/traefik.yaml`) and is the only witness to that class of failure. Never conclude "no fetch attempt" from app logs alone.

**Traefik logs 4xx/5xx only.** So this asymmetry holds: a *failing* importer fetch appears in Traefik and not the app; a *succeeding* one appears in the app and not Traefik. Neither log alone tells the whole story — always read both before drawing a conclusion.

### 3. Check the fail2ban / Loki-based blocklist (servy production host only)

```bash
ssh lehel.xyz "sudo fail2ban-client status loki-blocklist"   # currently-banned IPs
ssh lehel.xyz "sudo cat /var/log/fail2ban-loki.log"           # full ban history + reason
```
Ban reasons: `ssh-brute-force`, `scanner-bot`, `excessive-errors`, `traefik-rate-limit` (≥10 req/60s), `traefik-aggressive-crawler` (≥20 req/2min) — see `container` repo's `ansible/plays/roles/system/templates/fail2ban/update-blocklist-from-loki.sh.j2`. Bans are **host-wide**, not dontforget-specific, and last 24h with a single-strike trigger.

**Caveat learned the hard way:** a `googleusercontent.com` reverse-DNS PTR does **not** mean "Google's own service" — that hostname pattern covers *any* customer VM rented on Google Cloud, including scanner bots. Don't unban/flag an IP as "Google's fetcher" on PTR alone. To check whether Google's own first-party infrastructure has ever been banned, cross-reference against Google's *own* published ranges (not general GCP customer ranges):
```bash
curl -s https://www.gstatic.com/ipranges/goog.json -o /tmp/goog.json
# then check each banned IP against /tmp/goog.json's prefixes (ipv4Prefix/ipv6Prefix)
```
As of 2026-08-22, zero of ~3900 historically-banned IPs matched Google's own ranges — this mechanism has never been confirmed to be the cause, but Traefik-layer rejection (see step 2's gap) is still unchecked.

### 4. Check Google Search Console for the domain

Requires a Google account with Search Console access to `lehel.xyz` (as of 2026-08-22, `dachrischx@gmail.com` has a verified domain property — check via `https://search.google.com/search-console` account switcher before assuming it's not set up).

```
https://search.google.com/search-console/security-issues?resource_id=sc-domain:lehel.xyz
https://search.google.com/search-console/manual-actions?resource_id=sc-domain:lehel.xyz
```
Both clean (no issues) as of 2026-08-22 — rules out a domain-wide Google penalty/flag as the cause. URL Inspection on a specific `/f/<token>/...` URL will show "unknown to Google" — this is **expected, not diagnostic**: it's an unguessable per-user token nothing links to, so Googlebot's organic web crawler (Search Console) has no way to discover it. Search indexing and Calendar's feed-subscribe fetcher are different Google subsystems; don't over-read organic-crawl absence as proof of anything about Calendar specifically.

**Don't bother scripting this — Search Console is a dead end for Calendar problems (checked 2026-08-23).** A CLI was installed (`npm i -g @gscdump/cli`, plus `@duckdb/duckdb-wasm` which it imports but declares only as an *optional* peer dep, so it crashes with `ERR_MODULE_NOT_FOUND` without it) specifically to dig further here. It cannot help, for two structural reasons confirmed against the official discovery doc (`https://searchconsole.googleapis.com/$discovery/rest?version=v1`):

1. The whole API surface is `searchanalytics.query`, `sites.*`, `sitemaps.*`, `urlInspection.index.inspect`, `urlTestingTools.mobileFriendlyTest.run`. **Manual actions and security issues — the two things this step checks — are UI-only and exposed by no API**, so no CLI can automate step 4 at all.
2. `Google-Calendar-Importer` is not Googlebot's indexing crawler. Search Console reports exclusively on the indexing pipeline, so importer fetches never appear there no matter which endpoint you query.

Use Traefik's access log (step 2) instead — it is the only place Calendar-importer traffic is observable, and it is what actually solved this.

### 5. Use a control feed to isolate account/browser vs. domain-specific

Subscribe to a known-good external ICS feed (e.g. `https://www.gov.uk/bank-holidays/england-and-wales.ics`) via the same account/flow. If the control succeeds instantly (it has, every time tested) while dontforget's feed doesn't, that rules out: browser automation issues, account-level throttling from repeated attempts, and any generic Google-Calendar-is-just-broken-right-now explanation.

### 6. Vary the remaining variables one at a time before concluding

Tested combinations (all failed identically as of 2026-08-22/23, control feed succeeded in the same sessions):
- 2 different Google accounts (`christian.daehn@gmail.com`, `dachrischx@gmail.com`)
- Legacy flat URL shape (`/f/<token>.ics`) vs. current nested shape (`/f/<token>/dontforget.ics`) — both routes are served in parallel by `src/feed/routes.ts`, see commit `0fe6715`/PR #127
- A brand-new never-submitted token vs. an older token with real prior fetch history
- The app's own "Add to Google Calendar" button (`cid=webcal://` deep link) vs. Google's native Settings → Add calendar → From URL form
- Retried on a second calendar day (2026-08-23) — identical failure, so it is not a same-day transient issue

## Known Findings Log

**2026-08-22/23:** Exhaustive elimination as above (feed content, DNS/TLS/CAA, rate limits, Search Console, account, URL shape, token freshness — all clean/ruled out). Desktop/automated testing showed *no visible error and no server-side evidence of any fetch attempt* — misleadingly suggesting Google's backend never even tried.

**2026-08-23, ROOT CAUSE FOUND:** a real mobile device showed a visible Google Calendar error toast — *"Oops, we couldn't add this calendar. Please try again in a few minutes."* That prompted checking **Traefik's own access logs** (`docker logs traefik.traefik`, not the app container — see step 2's gap) for the first time, which showed the real Google Calendar Importer *does* hit the server:

```json
{"ClientHost":"66.249.89.234","RequestHost":"dontforget.lehel.xyz","RequestPath":"/f/<token>.ics",
 "RequestScheme":"http","entryPointName":"web","DownstreamStatus":404,"OriginStatus":0,
 "request_User-Agent":"Google-Calendar-Importer"}
```

`66.249.x.x` is Googlebot's real, well-known crawl range (not a GCP customer VM — contrast with the `googleusercontent.com` false-lead in the Common Mistakes section). `RequestScheme: http` and `entryPointName: web` (not `websecure`) is the key detail: **the request came in on plain HTTP, and `OriginStatus: 0` confirms Traefik never even forwarded it to the app** — Traefik itself returned the 404.

**Why:** `webcal://` URIs resolve to plain `http://` by convention (confirmed: Google's importer, and presumably Apple/Outlook too, do this). dontforget's Traefik router (`dontforget/docker-compose.yml` in the `container` repo) is registered **only** on the `websecure` (HTTPS) entrypoint:
```yaml
- traefik.http.routers.${SERVICE_NAME}.entrypoints=${TRAEFIK_ENTRYPOINT:-websecure}
```
There is no HTTP→HTTPS redirect — `container/traefik/traefik.yaml`'s global redirect lines are commented out, and dontforget has no per-service redirect router (unlike `bumbleflies/docker-compose.yml`, which already has the exact needed pattern: a second router on `entrypoints=web` with a `redirectscheme` middleware to `https`). So **any client that resolves `webcal://` to plain HTTP gets an immediate, silent-to-the-app 404 from Traefik**, before ever reaching dontforget's code. Confirmed directly:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://dontforget.lehel.xyz/f/<token>.ics"  # 200
curl -s -o /dev/null -w "%{http_code}\n" "http://dontforget.lehel.xyz/f/<token>.ics"   # 404
```

**This is a real, fixable infra bug — not a Google-side limitation.** Fixed via a `bumbleflies`-style HTTP→HTTPS redirect router added to `dontforget/docker-compose.yml` (`container` repo, `fix/dontforget-webcal-http-redirect` branch, deployed 2026-08-23). **Non-trivial catch handled:** `ansible/testing`'s `dontforget_traefik_{entrypoint,tls}` overrides already force the *main* router onto plain `web` with `tls=false` on `servyy-test.lxd` (no real Let's Encrypt resolver there) — a naively-hardcoded second `-http` router would have collided with the main router on test. Solved with a new `TRAEFIK_HTTP_REDIRECT_HOST` var (`.env.j2`) that's only populated with the real host when TLS is enabled; on test it's empty, so the redirect router's rule matches nothing (harmless no-op) instead of colliding. Tested clean on `servyy-test.lxd` first, then deployed to production.

**Post-fix verification (2026-08-23, same day):**
```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://dontforget.lehel.xyz/f/<token>/dontforget.ics"  # 200
curl -s -o /dev/null -w "%{http_code}\n" "http://dontforget.lehel.xyz/f/<token>/dontforget.ics"    # 302 -> https, was 404
```
Traefik logs show **zero** 4xx/5xx for dontforget since the fix deployed (use `--since <ISO8601>Z` with an explicit `Z` — omitting it gets interpreted in server-local time, not UTC, and silently pulls in stale pre-fix entries).

**2026-08-23, FIX CONFIRMED END-TO-END.** Dumping the *full* retained importer history (not just a recent window) is what settled it:

```bash
ssh lehel.xyz 'docker logs traefik.traefik 2>&1 | grep -i "Calendar-Importer"'
```

31 requests, `2026-08-18T21:03:44Z` → `2026-08-23T08:40:45Z`, across two feed tokens — **every one of them `RequestScheme: http`, `entryPointName: web`, `DownstreamStatus: 404`, `OriginStatus: 0`**, on a stable per-token cadence of roughly 5–6 hours.

That history overturns the working assumption this skill was built on:

> **The subscriptions were live the whole time.** Google only polls feeds it holds an active subscription for, and it had been polling faithfully since at least 2026-08-18. The *subscribe* step never failed — every subsequent *content fetch* did. The calendar was registered on Google's side and simply never received a byte, which is why it presented as "the add didn't work."

Then the transport fix landed, and the next scheduled poll went through:

| Time (UTC) | Event |
|---|---|
| 08:40:45 | last pre-fix importer poll → **404** (Traefik) |
| 09:39:18 | `dontforget.web` recreated — redirect router goes live |
| 10:42:46 | importer `66.249.89.237` GETs `/f/<token>.ics` → **reaches the app container** |

The 10:42:46 hit lands exactly on that token's established `:42` cadence (previous polls 06:42, 01:42, 20:42), so it is Google's own scheduler, not a manual test. Verified with the importer's own UA:

```bash
curl -sL -o /dev/null -A "Google-Calendar-Importer" \
  -w "%{http_code} after %{num_redirects} redirect(s), %{size_download} bytes\n" \
  "http://dontforget.lehel.xyz/f/<token>.ics"    # 200 after 1 redirect(s)
```

**Trap for the next session — after the fix, success is invisible in Traefik's log.** `traefik.yaml` only logs 4xx/5xx, so a working importer fetch leaves *no* Traefik entry at all. Absence of Calendar-Importer lines post-fix is the success signal, not a sign the importer stopped coming. Confirm the positive case in the **app** container instead, where the importer shows up with its real IP rather than Traefik's `172.18.0.1`:

```bash
ssh lehel.xyz 'docker logs dontforget.web --since <ISO8601>Z 2>&1 | grep "/f/"'
# look for "remoteAddress":"66.249.x.x"  — that's the real importer;
# 172.18.0.1 entries are proxied browser/curl traffic
```

Remaining variable is purely Google-side: subscription-completion + UI propagation latency into "Other calendars" is not observable from the server and not controllable. Transport is proven; if a calendar still reads empty a day later, re-check the app log for 66.249.x.x hits before suspecting anything infrastructural again.

## Common Mistakes

**❌ Assuming "the calendar never appeared" means the subscribe request failed**
- It didn't. Google had held active subscriptions for two tokens since 2026-08-18 and was polling them every ~5–6 hours the entire time the feature looked broken — 31 consecutive 404s. *Subscribe* succeeded; every *content fetch* failed, so the calendar existed on Google's side but stayed empty, which is indistinguishable from "add failed" in the UI.
- Practical consequence: a steady poll cadence in Traefik's log is proof a subscription exists, and it means **re-adding the calendar is not the fix and generates no new information**. Fix the fetch and the existing subscription heals itself on its next scheduled poll — no user action needed.

**❌ Trusting a `type` action into the Google Calendar URL field without verifying**
- This environment's browser automation intermittently fails to actually deliver typed text into the "URL of calendar" field — the field stays empty/placeholder, the "Add calendar" button stays disabled, and clicking it is a no-op. Once, mistyped keystrokes even leaked through as Google Calendar keyboard shortcuts (navigated to an event-creation page) instead of landing in the field.
- Fix: always screenshot after typing and confirm the field actually shows the full URL *before* clicking Add. Don't trust the tool call's "success" report alone.

**❌ Assuming the "Rotate Feed URL" button's first click rotates the token**
- It's a two-step confirm (`Rotate feed URL` → `Confirm rotate?` → click again). The confirm state also times out and reverts if you wait too long between clicks (e.g. taking a screenshot first burns the window). If you read a cached/stale `read_page` subtree after clicking it, you can be testing a URL that's already been silently invalidated — always re-fetch fresh page state after any rotate to get the real current token.

**❌ Treating a `googleusercontent.com` PTR record as proof of "Google's own service"**
- See step 3's caveat — led to incorrectly unbanning an unrelated scanner IP in a previous session (2026-08-22) before realizing the raw Traefik logs showed it hitting the bare server IP with `/`, `/sub` paths and a spoofed browser UA, not fetching the actual dontforget feed.

**❌ Concluding "Google's subscribe backend just doesn't fetch new domains" from desktop-only testing**
- That was the working theory through most of 2026-08-22 (no visible error, no server logs, so it *looked* like Google silently declines to even try). The 2026-08-23 mobile screenshot disproved the "doesn't even try" part — there IS an attempt, it fails with a generic Google-side retry-suggesting error, and desktop just doesn't surface it. Re-verify assumptions from automated-only testing against a real device when possible.

## Related

- `container` repo: `ansible/plays/roles/system/templates/fail2ban/` (blocklist mechanism), `traefik/traefik.yaml` (access log config — only 4xx/5xx logged by default)
- `dontforget` repo: `src/feed/routes.ts` (feed serving, both URL shapes), `src/feed/feedUrl.ts` (URL construction), `web/src/render.ts` (the three add-to-calendar buttons)
- PR #125 (RFC 7986 `NAME` property — doesn't fix Google's display-name fallback), PR #127 (readable URL slug — motivated by #125's finding, unrelated to the subscribe-failure investigated here)
