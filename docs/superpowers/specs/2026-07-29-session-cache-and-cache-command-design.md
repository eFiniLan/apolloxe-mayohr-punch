# Session cookie cache + caching config toggles — design

**Date:** 2026-07-29
**Status:** approved (decisions settled), ready for spec review → planning

## Problem

Every CLI command does a fresh 3-step MayoHR login on each run, even though the
`__ModuleSessionCookie` it obtains lives ~10 days. And the punch always reads the
calendar (workday/shift check) with no way to turn that off. We want both
behaviors cached and **independently toggleable via config** — no elaborate cache
management command.

## Approach: two independent toggles

The calendar cache and the session cache are **two different things, managed
separately**. Each is a config on/off flag (settable via the existing `config`
CLI), both **default ON**:

- **`CALENDAR_CHECK`** (default `true`):
  - **on** → before punching, check today's shift date/time against today, reading
    the calendar **cache** (auto-sync when the cache is past its TTL or missing,
    then check — the existing `cachedDayInfo` behavior).
  - **off** → skip the calendar check entirely: just punch, no workday guard, no
    calendar read.
- **`SESSION_CACHE`** (default `true`):
  - **on** → reuse the validated cached cookie (validate-before-use, 9-day TTL);
    fresh login only when it's missing / expired / dead.
  - **off** → fresh login every run (today's behavior).

The two are wholly independent. There is **no unified `cache` command** — the
toggles plus auto-sync (and validate-before-use) are the entire control surface.
`npm run calendar:sync` stays for on-demand pre-warm/verify of the calendar file.

Scope: CLI-only. The deployed Worker is untouched (stateless, no filesystem); it
never reads these flags (its scheduler always reads the calendar live).

## Revocation handling — validate before use (unchanged)

A cached cookie can be killed server-side before its TTL (password change, forced
logout). Reusing a dead-but-unexpired cookie would fail repeatedly until the TTL
passed. So when `SESSION_CACHE` is on: **before trusting a cached cookie, run one
cheap authenticated GET (the locations list); if it fails, discard and log in
fresh.** Uniform (independent of how each API module reports auth failure) and
safe (a GET has no side effects — we never punch with an unvalidated cookie).

## Architecture

### `src/cache-store.ts` (new) — shared storage interface

Extract the `CacheStore` interface (currently in `calendar-cache.ts`) so both
caches share it. `calendar-cache.ts`, `session-cache.ts`, and
`scripts/cache-fs.ts` import it from here.

```ts
export interface CacheStore {
  read: (key: string) => Promise<string | null>;
  write: (key: string, contents: string) => Promise<void>;
}
```

### `src/session-cache.ts` (new) — storage-agnostic core, no `node:` import

```ts
export const SESSION_KEY = "session-cache.json";
export interface SessionFile { cookie: string; savedAt: string; } // savedAt ISO-8601
export interface SessionOpts {
  now?: () => Date;
  login?: (cfg: Config) => Promise<Session>;
  validate?: (session: Session) => Promise<boolean>;
  ttlMs?: number;
}

// Pure: parse raw cache text, return the cookie iff present and savedAt < TTL.
export function readCachedCookie(raw: string | null, now: Date, ttlMs?: number): string | null

// Cached-or-fresh session. Reuses a cached cookie only if it validates; otherwise
// logs in fresh and saves. Write failure is non-fatal.
export async function getSession(
  cfg: Config, store: CacheStore, opts?: SessionOpts,
): Promise<{ session: Session; source: "cache" | "fresh" }>

// Force-write a cookie to the cache (used by `calendar:sync` / any pre-warm).
export async function saveSession(store: CacheStore, session: Session, now?: () => Date): Promise<void>
```

- TTL default: **9 days**, margin under the ~10-day cookie life.
- `readCachedCookie` → null on missing / corrupt / missing-field / unparseable-date / expired.
- `getSession` flow: read cached cookie → if present and (`!validate` or `await validate(session)`) → `{source:"cache"}`; else `login(cfg)`, save, `{source:"fresh"}`.
- All boundaries injectable → unit-testable with no network.

### `scripts/session.ts` (new) — CLI session helper honoring `SESSION_CACHE`

```ts
export async function cliSession(cfg: Config): Promise<{ session: Session; source: "cache" | "fresh" }>
```
- If `cfg.sessionCache` is off → `{ session: await login(cfg), source: "fresh" }` (no cache touched).
- If on → `getSession(cfg, fileStore, { validate })` where
  `validate = (s) => getLocations(s, cfg).then(() => true).catch(() => false)`.
- One place, reused by every entrypoint. Not imported by tests (they test
  `src/session-cache.ts` directly with fakes).

### Config additions (`src/config.ts`)

Add two booleans to `Config`, read by `loadConfig` (default `true`):
```ts
calendarCheck: bool(env, "CALENDAR_CHECK", true),
sessionCache:  bool(env, "SESSION_CACHE", true),
```
They only affect the CLI (below); the Worker's scheduler never consults them.

### Wiring

- **`scripts/punch-now.ts`**:
  - Session: `const { session } = await cliSession(cfg);` in place of `login(cfg)`.
  - Calendar: if `cfg.calendarCheck` → `cachedDayInfo(...)` + the existing workday
    guard/exit; if not → skip straight to the punch (log that the check is off).
- **`scripts/list-locations.ts`**, **`scripts/config-cli.ts`** (no-id `set
  location` path): session via `cliSession(cfg)` (they don't do a calendar check).
- **`scripts/sync-calendar.ts`** (`calendar:sync`): logs in and `saveSession` when
  `SESSION_CACHE` is on (so a sync also warms the cookie), then `syncCalendar`.

### Config CLI toggles (`scripts/config-cli.ts`, `scripts/dev-vars.ts`)

- Add fields to `FIELDS`: `calendar` → `["CALENDAR_CHECK"]`, `session` → `["SESSION_CACHE"]`.
- These are booleans: `config set calendar on|off` (also accept `true|false`) →
  normalize to `"true"`/`"false"` before upserting. Add a small `normalizeBool`
  step in the entrypoint for boolean fields; `buildEntries` stays a pure mapper.
- `config list` gains two lines: `calendar : on|off`, `session : on|off`.

### Security & config

- `session-cache.json` holds a ~9-day bearer token → **gitignore it**, and make
  `scripts/cache-fs.ts` `fileStore.write` set mode `0600` (+ `chmod`), which also
  harmlessly tightens `calendar-cache.json`.

## Testing

- `test/session-cache.test.ts` (new), injected `store`/`now`/`login`/`validate`, no network:
  - `readCachedCookie`: fresh→cookie; expired→null; missing raw→null; corrupt JSON→null; missing `cookie`/`savedAt`→null; unparseable `savedAt`→null.
  - `getSession`: no cache → login+save+`fresh`; cached+valid → reuse, **no login**, `cache`; cached+invalid → login+save+`fresh`; expired → login; write failure → non-fatal; no `validate` + cached → reuse without a check.
  - `saveSession`: writes `{cookie, savedAt}` via the store.
- `test/dev-vars.test.ts`: extend `buildEntries` cases for the `calendar`/`session` fields.
- `test/config.test.ts` (if present): `calendarCheck`/`sessionCache` default `true`; `"false"` → `false`.
- Existing calendar-cache / locations / config tests stay green after the `CacheStore` extraction.
- Entrypoints, the `getLocations` validator, and the toggles are verified by a live run (against a throwaway `.dev.vars`; the real login path is already proven).

## Out of scope

- Worker-side caching (stateless; a future KV `CacheStore` could reuse this core).
- A unified `cache` command / `cache clear` (dropped — toggles + auto-sync + validate-before-use are the control).
- Any change to punch/calendar behavior beyond the session source and the calendar-check toggle.
