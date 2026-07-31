# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`apolloxe-mayohr-punch` clocks you in/out of Apollo XE (MayoHR) via the GPS
`/locate` endpoint (validates by **location, not IP**). **The project is the punch
tool: you drive it from the CLI (`npm run punch in|out`), and the core (`src/`) is
Agent-callable.** An optional, thin **Cloudflare Worker** is just one consumer that
runs the same core on a cron. The GPS punch deliberately works around the
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

Per-cron-fire flow (`src/scheduler.ts runScheduler`, the heart of the Worker):

```
read KV plan:<today> ─ missing? → peek cached calendar (no login; miss → login+fetch) → buildPlan → save
                     └ present? → no MayoHR call
then decide(plan, now) → in | out | skip → (if punching) login → punch → set done-flag / throw
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
- **`plan.ts`** — the Worker's per-day plan: `buildPlan` (roll the randomized
  clock-in/out targets once, from that day's shift), `decide` (in/out/skip for a
  wall-clock time), `read/savePlan` (KV). Pure + storage-thin → unit-tested directly.
- **`scheduler.ts`, `time.ts`, `config.ts`** — orchestration, pure time math,
  env→Config. Success/failure is signaled by `punch.ts summarize()` — the CLI via
  exit codes, the Worker by throwing (no email).
- **`index.ts`** — the cron entrypoint; `await`s `runScheduler` (not
  `ctx.waitUntil`) so a failure marks the invocation failed instead of green.

### Two design decisions that everything hangs on

1. **KV-backed daily plan (KV is required).** The Worker requires a bound
   `APOLLO_KV`. The first fire of the day writes `plan:<date>` (randomized
   clock-in/out targets + done-flags); later fires read it with **no MayoHR call**
   and punch only when a target arrives — so an all-day `*/10` cron stays cheap and
   gentle on Mayo. MayoHR is still the idempotency source of truth: a duplicate
   punch returns `already_done`, a too-soon one `cooldown`, both "already happened →
   stay quiet". KV also caches the session cookie (9-day TTL, validate-before-use)
   and calendar via the shared `getDay`/`runPunch` core. Login is deferred to an
   actual punch: "waiting" fires never authenticate, and even the daily plan build
   skips login when the calendar cache is warm (`peekDay`) — only a punch or a
   monthly cache refresh logs in. So ~142 of ~144 fires/day touch no MayoHR API.

2. **Direction and timing come from the plan, not a fixed window.** Both are
   derived from that day's actual shift and frozen into the plan — the random
   offsets are rolled **once** (in `buildPlan`) so the punch time is stable and
   human-looking, not re-rolled every fire. No noon split. Clock-in is guaranteed
   **early** (`inTarget = shiftStart − max(CRON_STEP_MIN, reactionBufferMin +
   random)`), clock-out **late**. `CRON_STEP_MIN` (10, in `src/plan.ts`) must stay
   in sync with `wrangler.toml` `crons` (`*/10`); it guarantees a poll lands in
   `[inTarget, shiftStart)` so clock-in never slips past the shift start.

### Testability convention

Every impure boundary is an injectable last parameter with a real default:
`fetch` (`fetchImpl = fetch`), randomness (`rand = Math.random`), and the
scheduler's whole `Deps` (acquireSession/getDay/punch/store/now/rand). Tests inject
fakes; production passes nothing. Preserve this when adding code — don't call
`Math.random`/`fetch`/`new Date()` directly in testable logic.

## API contract

The MayoHR API is undocumented — everything here is reverse-engineered from live
testing. The confirmed behavior lives in the code (`auth.ts`, `calendar.ts`,
`punch.ts`) and its comments; treat those as the source of truth and keep them
accurate whenever API handling changes. The one unverified spot is `tripSheets`
datetime field names in `calendar.ts` (moot while `RESPECT_LEAVE=false`).
