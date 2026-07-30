# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker (`apollo-auto-punch`) that auto-clocks in/out of Apollo XE
(MayoHR) driven by the user's own shift calendar. It logs in, reads Mayo's
schedule for the day, and punches via the GPS `/locate` endpoint. The GPS punch
validates by **location, not IP**, which is what lets it run from Cloudflare's
network — deliberately working around the employer's office-only IP control on
the *web* punch. That trade-off is the user's decision; keep it documented in the
README, and never log or echo the MayoHR password (it lives only in secrets).

## Commands

```bash
npm test                      # vitest run (all tests)
npx vitest run test/punch.test.ts       # a single test file
npx vitest run -t "cooldown"            # a single test by name
npm run typecheck             # tsc --noEmit
npm run dev                   # wrangler dev (reads .dev.vars)
npm run deploy                # wrangler deploy
npm run config                # show effective config; `config set location` (no id) lists offices
npm run calendar [YYYY-MM-DD]  # read-only: is it a workday + shift (exit 0=workday, 1=not)
npm run punch in|out          # CLI: a REAL end-to-end punch (prefix DRY_RUN=true to dry-run)
```

`npm run punch` (and `config set location` with no id) hit the **live MayoHR API**
with real credentials. Default to `DRY_RUN=true npm run punch ...` unless a real
punch is intended.

## Credentials & config

- **Local** (CLI helpers + `wrangler dev`): a gitignored `.dev.vars` in the root,
  `MAYO_USERNAME` / `MAYO_PASSWORD`. This is the single local credential store —
  do not reintroduce a second one (there used to be a `probe/secrets.json`; it's
  gone on purpose).
- **Deployed**: `wrangler secret put` for `MAYO_*`;
  non-secret vars live in `wrangler.toml` `[vars]`.
- Config precedence for CLI: real env vars > `.dev.vars` > code defaults
  (`scripts/_env.ts`). The Worker reads only `env` (`src/config.ts loadConfig`).

## Architecture

Two layers. **`src/` is the only implementation of every MayoHR API call** —
CLI helpers in `scripts/` call the same `src/` modules so they can't drift from
deployed behaviour (an earlier duplicated login is what once hid an
`accept-language` bug; don't recreate that pattern).

Per-cron-fire pipeline (`src/scheduler.ts runScheduler`, the heart of the system):

```
login → read today's calendar → workday? → (leave?) → time yet? → punch → exit code / throw
```

- **`auth.ts`** — the 3-step cookie-session login (scrape CSRF `__RequestVerificationToken`
  from login HTML → POST `/Token` for a single-use `code` → GET `checkticket`,
  following redirects to collect `__ModuleSessionCookie`). Returns a `Session`
  holding the cookie jar. This is the most fragile file: it screen-scrapes an
  undocumented login form. It fails **loudly** by design.
- **`calendar.ts`** — reads the month's scheduling calendar, maps one day to
  `DayInfo {isWorkday, onLeave, shiftStart, shiftEnd}`. `accept-language: en-us`
  is REQUIRED or the API returns a different, unusable shape.
- **`punch.ts`** — POST to the GPS `/locate` endpoint. Response is
  **self-verifying** (`Meta.HttpStatusCode==="200"` + `Data.AttendanceHistoryId`),
  so there is no read-back step. Maps server errors to outcomes.
- **`scheduler.ts`, `time.ts`, `config.ts`** — orchestration, pure time math,
  env→Config. Success/failure is signaled by `punch.ts summarize()` — the CLI via
  exit codes, the Worker by throwing (no email).
- **`index.ts`** — the cron entrypoint; `await`s `runScheduler` (not
  `ctx.waitUntil`) so a failure marks the invocation failed instead of green.

### Two design decisions that everything hangs on

1. **Stateless by default, optional KV.** MayoHR itself is the source of truth. A
   duplicate punch returns `already_done`; a punch <~10 min after another returns
   `cooldown`. The scheduler treats both as "a punch already happened → stay quiet",
   so the cron can fire every 5 min safely and re-login each time. Binding a KV
   namespace (`APOLLO_KV`) enables the Worker to cache the session cookie (9-day
   TTL, validate-before-use) and calendar via the shared `runPunch`/`getDay` core;
   unbound, it stays stateless. Either way, server idempotency is the Worker's
   safety net. Any feature reaching for stored state should first ask whether
   server idempotency covers it.

2. **Direction and timing are derived, not stored.** `hhmm < "12:00"` ⇒ clock-in,
   else clock-out. Clock-in is guaranteed **early** (target = `shiftStart −
   max(CRON_STEP_MIN, reactionBufferMin + random)`), clock-out guaranteed **late**
   — by construction, not by post-hoc checks. `CRON_STEP_MIN` (5) must stay in
   sync with `wrangler.toml` `crons` (`*/5`); it guarantees a tick lands in
   `[target, shiftStart)`.

### Testability convention

Every impure boundary is an injectable last parameter with a real default:
`fetch` (`fetchImpl = fetch`), randomness (`rand = Math.random`), and the
scheduler's whole `Deps` (acquireSession/getDay/punch/store/now/rand). Tests inject
fakes; production passes nothing. Preserve this when adding code — don't call
`Math.random`/`fetch`/`new Date()` directly in testable logic.

## Source of truth for the API

`docs/api-facts.md` is the confirmed, reverse-engineered contract (auth, calendar,
punch, error-status strings, GPS jitter math). It's derived from live testing, not
guessed — update it in lockstep whenever API handling changes. The one unverified
spot is `tripSheets` datetime field names in `calendar.ts` (moot while
`RESPECT_LEAVE=false`).
