# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`apolloxe-mayohr-punch` clocks you in/out of Apollo XE (MayoHR) via the GPS
`/locate` endpoint (validates by **location, not IP**). **The project is the punch
tool: you drive it from the CLI (`npm run punch in|out`), and the core (`src/`) is
Agent-callable.** An optional **Cloudflare Worker** (a single alarm-driven Durable
Object, `src/punch-day.ts`) is just one consumer that runs the same core to
auto-punch. The GPS punch deliberately works around the
employer's office-only IP control on the *web* punch — that trade-off is the user's
decision; keep it documented in the README, and never log or echo the MayoHR
password (it lives only in secrets).

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

- **Non-secret config = `wrangler.toml [vars]`, single source** shared by the CLI
  and the deployed Worker (username, location, coords, timezone, toggles, DRY_RUN…).
  The CLI reads it via `scripts/wrangler-vars.ts parseTomlVars` (`scripts/_env.ts`);
  `config set` (except password) writes it via `upsertTomlVars`. Any CLI run
  auto-migrates stray non-secret keys out of `.dev.vars` (`_env.ts migrateDevVars`,
  run once per process in `mergedEnv`). Don't reintroduce a second non-secret store.
- **Password only** lives in the gitignored `.dev.vars` (local, mode 0600; also read
  by `wrangler dev`) and, for the deployed Worker, `wrangler secret put MAYO_PASSWORD`.
  It must never go in `wrangler.toml` — `wrangler deploy` uploads `[vars]` as plaintext.
- **CLI precedence**: real env > `.dev.vars` > `wrangler.toml [vars]` > code defaults
  (`scripts/_env.ts mergedEnv`). The Worker reads only `env` (`src/config.ts loadConfig`).

## Architecture

Two layers. **`src/` is the only implementation of every MayoHR API call** —
CLI helpers in `scripts/` call the same `src/` modules so they can't drift from
deployed behaviour (an earlier duplicated login is what once hid an
`accept-language` bug; don't recreate that pattern).

Per-tick flow (`src/punch-day.ts runTick`, the heart of the Worker — a Durable
Object whose `alarm()` is a precise timer, plus a daily cron backstop calling
`ensure()`):

```
read stored plan ─ missing/other day? → peek cached calendar (no login; miss → login+fetch)
                 │                        → buildDayPlan (roll random epoch targets) → save
                 └ this day? → no MayoHR call
then dueAction(plan, now) → in | out | none → (if punching) login → punch → set done-flag / throw
finally setAlarm(nextAlarm(plan)) → next target, else tomorrow 00:05 (past → now+1s, catch-up)
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
- **`day-machine.ts`** (pure) — the Worker's per-day plan: `buildDayPlan` (roll the
  randomized clock-in/out offsets **once**, incl. seconds, into absolute epoch-ms
  targets), `dueAction` (in/out/none for an instant), `nextAlarm` (when to wake
  next). No I/O → unit-tested directly.
- **`punch-day.ts`** — the `PunchDay` Durable Object + its testable core `runTick`
  (injectable `TickDeps`). `alarm()` and the cron's `ensure()` both call `runTick`.
- **`do-store.ts`** — `CacheStore` over the DO's SQLite storage (session + calendar
  caches live there; no KV).
- **`time.ts`, `config.ts`** — pure time math (incl. `zonedTimeToEpoch`), env→Config.
  Success/failure is signaled by `punch.ts summarize()` — the CLI via exit codes,
  the Worker by throwing (no email).
- **`index.ts`** — exports the `PunchDay` DO; its `scheduled()` cron backstop `await`s
  `stub.ensure()` (not `ctx.waitUntil`) so a failure marks the invocation failed.

### Two design decisions that everything hangs on

1. **One Durable Object, alarm-driven (no KV, no Workflow).** A single `PunchDay`
   DO (`idFromName("singleton")`) owns the schedule. Its SQLite storage holds the
   cookie, calendar cache, and today's plan (via `do-store`); its `alarm()` is a
   precise timer. Each day it wakes ~3×: build the plan, punch in, punch out — so
   **MayoHR is hit ~3×/day** (calendar + in + out), login amortized via the stored
   cookie. Idempotency is still the server's: `already_done`/`cooldown` both count
   as done. The cron (`5 16 * * *` = 00:05 Taipei) is only a **backstop** that calls
   `ensure()`; the DO otherwise re-arms its own alarm (in → out → tomorrow), and a
   past alarm time (after an outage) fires immediately for catch-up.

2. **Direction and timing come from the shift, frozen once.** `buildDayPlan` reads
   that day's shift and rolls the random early-in/late-out offsets **once**, incl. a
   random 0–59 s, into **absolute epoch-ms** targets (`inAt`/`outAt`). No noon split,
   no poll grid — the alarm fires at the exact instant, so the punch time is real
   minute/second-level random (looks human). Clock-in is always early
   (`inAt = shiftStart − (reactionBufferMin + random)`), clock-out always late.

### Testability convention

Every impure boundary is an injectable last parameter with a real default:
`fetch` (`fetchImpl = fetch`), randomness (`rand = Math.random`), and `runTick`'s
whole `TickDeps` (acquireSession/getDay/peekDay/punch/now/rand). Tests inject fakes
(incl. a fake DO storage); production passes nothing. Preserve this when adding
code — don't call `Math.random`/`fetch`/`Date.now()` directly in testable logic.

## API contract

The MayoHR API is undocumented — everything here is reverse-engineered from live
testing. The confirmed behavior lives in the code (`auth.ts`, `calendar.ts`,
`punch.ts`) and its comments; treat those as the source of truth and keep them
accurate whenever API handling changes. The one unverified spot is `tripSheets`
datetime field names in `calendar.ts` (moot while `RESPECT_LEAVE=false`).
