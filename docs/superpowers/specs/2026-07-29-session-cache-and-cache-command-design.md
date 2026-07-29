# Reusable punch flow + session cache + caching toggles — design

**Date:** 2026-07-29
**Status:** approved (decisions settled), ready for spec review → planning

## Goal

Make the tool **flexible and reusable** — usable by the author now, a colleague,
or later an Agent / the deployed Worker — by driving everything from `Config` and
routing every caller through one shared punch flow. Concretely:

1. A single reusable `src/` orchestration, `runPunch`, that CLI, Worker, and a
   future Agent all call (instead of three copies of "session → check → punch").
2. A **session cookie cache** so the ~10-day `__ModuleSessionCookie` is reused
   across runs instead of a fresh login every time.
3. Two independent **config toggles** (calendar check, session cache) plus a
   per-run **`--force`** override on `punch`.

Everything is config-driven; nothing is hardcoded, so each user/Agent/Worker
supplies its own `Config`.

## Config: one model, no value-flags

Precedence, highest wins: **env vars > `.dev.vars` > code defaults.**
- Secrets (`MAYO_USERNAME`/`MAYO_PASSWORD`) come from `export` or `.dev.vars` —
  never CLI args (argv leaks to shell history / `ps`).
- Location / coords / toggles come from `.dev.vars` (set via the `config` CLI) or env.
- **No `--user/--pass/--location/--pos` flags.** A bot punches from a fixed place
  (set once); a genuine one-off elsewhere is done on the phone. The only per-run
  flag is `--force` (a behavior override, not a config value).

New booleans in `Config` (via `loadConfig`, default `true`):
```ts
calendarCheck: bool(env, "CALENDAR_CHECK", true),
sessionCache:  bool(env, "SESSION_CACHE", true),
```
These affect the shared flow (below); the Worker's scheduler already does its own
time-gating and simply passes through.

## Two toggles + `--force`

- **`CALENDAR_CHECK`** (default on): the punch checks today's shift date/time
  against today (workday guard), reading the calendar cache (auto-sync when past
  TTL or missing). Off → skip the check, just punch.
- **`SESSION_CACHE`** (default on): reuse the validated cached cookie; fresh login
  only when missing / expired / dead. Off → fresh login every run.
- **`punch <in|out> --force|-f`**: skip the calendar check for that one run
  regardless of `CALENDAR_CHECK` (effective check = `cfg.calendarCheck && !force`).
  Does not touch the session cache.

## Revocation handling — validate before use

A cached cookie can be killed server-side before its TTL (password change, forced
logout). So when the session cache is on: **before trusting a cached cookie, run
one cheap authenticated GET (the locations list); if it fails, discard and log in
fresh.** Uniform (independent of how each API module reports auth failure) and
safe (a GET has no side effects — we never punch with an unvalidated cookie).

## Architecture

`src/` holds the reusable core; `scripts/` are thin CLI adapters. The deployed
Worker is untouched behaviorally (stateless, no filesystem) but shares the core.

### `src/cache-store.ts` (new) — shared storage interface

Extract `CacheStore` (currently in `calendar-cache.ts`) so both caches share it:
```ts
export interface CacheStore {
  read: (key: string) => Promise<string | null>;
  write: (key: string, contents: string) => Promise<void>;
}
```
`calendar-cache.ts`, `session-cache.ts`, `scripts/cache-fs.ts` import it here.

### `src/session-cache.ts` (new) — storage-agnostic cookie cache, no `node:` import

```ts
export const SESSION_KEY = "session-cache.json";
export interface SessionFile { cookie: string; savedAt: string; } // ISO-8601
export interface SessionOpts { now?: () => Date; login?: (cfg: Config) => Promise<Session>; validate?: (s: Session) => Promise<boolean>; ttlMs?: number; }

export function readCachedCookie(raw: string | null, now: Date, ttlMs?: number): string | null // null on missing/corrupt/missing-field/unparseable/expired
export async function getSession(cfg: Config, store: CacheStore, opts?: SessionOpts): Promise<{ session: Session; source: "cache" | "fresh" }>
export async function saveSession(store: CacheStore, session: Session, now?: () => Date): Promise<void>
```
- TTL default **9 days**. `getSession`: read cached cookie → if present and (`!validate` or `await validate`) → `{source:"cache"}`; else `login`, save, `{source:"fresh"}`. Write failure non-fatal. All boundaries injectable → unit-tested with no network.

### `src/flow.ts` (new) — the reusable orchestration hub

```ts
export async function acquireSession(cfg: Config, store: CacheStore | null): Promise<{ session: Session; source: "cache" | "fresh" }>
// store null OR cfg.sessionCache false → { session: await login(cfg), source: "fresh" }.
// else → getSession(cfg, store, { validate: s => getLocations(s, cfg).then(() => true).catch(() => false) }).

export interface RunPunchOpts { direction: "in" | "out"; force?: boolean; }
export interface RunPunchResult {
  step: "punched" | "skipped";
  reason?: string;                 // when skipped, e.g. "not a workday"
  outcome?: PunchOutcome;          // when punched
  sessionSource: "cache" | "fresh";
  dayInfo?: DayInfo;               // when the calendar was checked
}
export async function runPunch(cfg: Config, store: CacheStore | null, opts: RunPunchOpts, deps?): Promise<RunPunchResult>
// 1. { session, source } = acquireSession(cfg, store)
// 2. if cfg.calendarCheck && !opts.force:
//      dayInfo = store ? cachedDayInfo(session, cfg, todayKey, store) : getDayInfo(session, cfg, todayKey)
//      if !dayInfo.isWorkday → return { step:"skipped", reason:"not a workday", sessionSource:source, dayInfo }
// 3. outcome = punch(session, cfg, opts.direction)
// 4. return { step:"punched", outcome, sessionSource:source, dayInfo }
```
`deps` (login/getSession/punch/getDayInfo/cachedDayInfo/getLocations/now) are
injectable with real defaults, matching `scheduler.ts`'s `Deps` pattern, so
`runPunch` is unit-testable with no network. This is the single flow the CLI, the
Worker scheduler, and a future Agent call.

### Wiring — everyone calls the core

- **`scripts/punch-now.ts`**: parse `direction` + `--force/-f`; `const r = await runPunch(cfg, fileStore, { direction, force });` then print `r` (session source, workday/skip, outcome). Thin.
- **`scripts/list-locations.ts`, `scripts/config-cli.ts`** (no-id `set location`): use `acquireSession(cfg, fileStore)` in place of `login(cfg)`.
- **`scripts/sync-calendar.ts`** (`calendar:sync`): `login` fresh + `saveSession(fileStore, session)` (also warms the cookie) when `SESSION_CACHE` is on, then `syncCalendar`.
- **`src/scheduler.ts`** (Worker): keep its time-gating/direction-from-time/leave/notify. Replace its inline `login` + `getDayInfo`(workday) + `punch` with a call to `runPunch(cfg, null, { direction, force: true })` at punch time (it has already done timing + workday logic; `force:true` avoids a redundant re-check, `store:null` keeps it stateless/fresh-login). Its existing tests guard the refactor.

### Config CLI toggles (`scripts/config-cli.ts`, `scripts/dev-vars.ts`)

- `FIELDS` gains `calendar` → `["CALENDAR_CHECK"]`, `session` → `["SESSION_CACHE"]`.
- Boolean fields: `config set calendar on|off` (also `true|false`) → normalize to `"true"`/`"false"` in the entrypoint before upserting; `buildEntries` stays a pure mapper.
- `config list` adds `calendar : on|off` and `session : on|off`.

### Security

- `session-cache.json` holds a ~9-day bearer token → **gitignore it**, and make
  `scripts/cache-fs.ts` `fileStore.write` set mode `0600` (+ `chmod`), which also
  harmlessly tightens `calendar-cache.json`.

## Testing

- `test/session-cache.test.ts`: `readCachedCookie` (fresh / expired / missing / corrupt / missing-field / unparseable-date → null|cookie); `getSession` (no cache → login+save+`fresh`; cached+valid → reuse, no login, `cache`; cached+invalid → login+save; expired → login; write failure non-fatal; no validate + cached → reuse); `saveSession` writes `{cookie,savedAt}`.
- `test/flow.test.ts`: `runPunch` with injected deps — calendarCheck off → no calendar call, punches; `force:true` → skips check even with calendarCheck on; not-a-workday → `step:"skipped"`; workday → punches, returns outcome + sessionSource; `store:null` → login path (no session cache). `acquireSession`: sessionCache off / store null → login; on → getSession with a validator.
- `test/dev-vars.test.ts`: `buildEntries` cases for `calendar`/`session`.
- `test/config.test.ts`: `calendarCheck`/`sessionCache` default `true`; `"false"` → `false`.
- `test/scheduler.test.ts`: existing tests stay green after delegating the punch step to `runPunch` (adjust mocks as needed).
- Existing calendar-cache / locations / config tests stay green after the `CacheStore` extraction.
- Entrypoints + the live login/validator path verified by a real run (against a throwaway `.dev.vars`).

## Out of scope

- Worker-side session/calendar *caching* (stays stateless; a future KV `CacheStore` can reuse this core via `runPunch(cfg, kvStore, …)`).
- Any CLI value-flags beyond `--force` (`--user/--pass/--location/--pos` deliberately excluded).
- Building the Agent/MCP itself (this makes the core ready for one; the Agent is a later, separate effort).
