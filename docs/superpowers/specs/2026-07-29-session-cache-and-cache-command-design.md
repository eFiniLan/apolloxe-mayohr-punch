# Session cookie cache + unified `cache` command — design

**Date:** 2026-07-29
**Status:** approved (decisions settled), ready for spec review → planning

## Problem

Every CLI command (`punch`, `locations`, `calendar:sync`, `config set location`)
does a fresh 3-step MayoHR login on each run — scrape the CSRF form, POST the
password, follow `checkticket` to get `__ModuleSessionCookie`. That cookie lives
~10 days, so re-logging in every run is wasteful and repeats the most bot-like
part of the flow (the password POST) far more than necessary.

Goal: cache the session cookie locally and reuse it across runs, so the real
login happens ~once per 9 days instead of every command. Also fold the now
too-narrow `calendar:sync` into a unified `cache` command, since there are two
caches to manage.

## Scope

CLI-only, same as the calendar cache. The deployed Worker is untouched (stateless,
no filesystem). This adds a second local cache alongside `calendar-cache.json`.

## Revocation handling — validate before use

A cached cookie can be killed server-side **before** its TTL (password change,
forced logout). Blindly reusing a dead-but-unexpired cookie would make commands
fail repeatedly until the TTL passed — a footgun. So:

**Before trusting a cached cookie, run one cheap authenticated GET (the locations
list) to confirm it's alive.** If that GET fails (401 / login-redirect / network
error), discard the cookie and do a full login. This is uniform (independent of
how each API module reports auth failure) and safe (a GET has no side effects —
crucially, we never punch with an unvalidated cookie).

Trade-off accepted: a validating GET (~300ms) instead of skipping auth entirely.
Still cheaper than the 3-step login, and it cuts the password-logins to ~one per
9 days — the main win.

## Architecture

Mirrors the calendar cache: storage-agnostic core in `src/`, file store in
`scripts/`, validator in the CLI layer (it makes an API call, so it can't live in
the pure core).

### `src/cache-store.ts` (new) — shared storage interface

Extract the `CacheStore` interface (currently defined in `calendar-cache.ts`) so
both caches share it:

```ts
export interface CacheStore {
  read: (key: string) => Promise<string | null>; // null when absent
  write: (key: string, contents: string) => Promise<void>;
}
```

`calendar-cache.ts`, `session-cache.ts`, and `scripts/cache-fs.ts` all import it
from here. `calendar-cache.ts` drops its local definition.

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

// Force-write a cookie to the cache (used by `cache sync`).
export async function saveSession(store: CacheStore, session: Session, now?: () => Date): Promise<void>
```

- TTL default: **9 days** (`9 * 24 * 60 * 60 * 1000`), margin under the ~10-day cookie life.
- `readCachedCookie` returns null on missing/corrupt/missing-field/unparseable-date/expired.
- `getSession` flow: read cached cookie → if present and (`!validate` or `await validate(session)`) → return `{source:"cache"}`; else `login(cfg)`, save, return `{source:"fresh"}`.
- `login`/`now`/`validate`/`ttlMs` injectable → unit-testable with no network.

### `scripts/session.ts` (new) — the CLI session helper (with validator)

```ts
export async function cliSession(cfg: Config): Promise<{ session: Session; source: "cache" | "fresh" }>
```
Calls `getSession(cfg, fileStore, { validate })` where
`validate = (s) => getLocations(s, cfg).then(() => true).catch(() => false)`.
One place, reused by every entrypoint. Not imported by tests (they test
`src/session-cache.ts` directly with fakes).

### Wiring — entrypoints swap `login(cfg)` → `cliSession(cfg)`

- `scripts/punch-now.ts`, `scripts/list-locations.ts`, `scripts/config-cli.ts`
  (the no-id `set location` path): `const { session } = await cliSession(cfg);`
  in place of `const session = await login(cfg);`. Where useful, surface the
  `source` (cache/fresh) in output.
- `list-locations` will do two GETs (validate + its own listing). Accepted — it's
  a rare command; keeping the validation uniform avoids the revocation footgun.

## Unified `cache` command — `scripts/cache-cli.ts` (new)

Replaces `scripts/sync-calendar.ts` and the `calendar:sync` npm script.

```
npm run cache sync    # one fresh login → saveSession + syncCalendar (warms BOTH caches, no punch)
npm run cache clear   # delete session-cache.json and calendar-cache.json
```

- `sync`: `login(cfg)` fresh (guarantees a fresh cookie), `saveSession(fileStore, session)`,
  then `syncCalendar(session, cfg, dateKey, fileStore)`. Reports both warmed
  (cookie saved; N calendar days). Uses `login` directly, not `cliSession`, since
  the point is to refresh, not reuse.
- `clear`: `unlink` `SESSION_KEY` and `CACHE_KEY` (ignore ENOENT); report which were removed.
- `scripts/sync-calendar.ts` is deleted; `package.json` drops `calendar:sync`, adds `"cache": "tsx scripts/cache-cli.ts"`.

## Security & config

- `session-cache.json` holds a ~9-day bearer token → **gitignore it**, and make
  `scripts/cache-fs.ts` `fileStore.write` set mode `0600` (+ `chmod`), which also
  harmlessly tightens `calendar-cache.json`.
- Both cache files are written at the process CWD (the key IS the path), same as today.

## Testing

- `test/session-cache.test.ts` (new), all with injected `store`/`now`/`login`/`validate`, no network:
  - `readCachedCookie`: fresh→cookie; expired (>TTL)→null; missing raw→null; corrupt JSON→null; missing `cookie`/`savedAt`→null; unparseable `savedAt`→null.
  - `getSession`: no cache → login + save + `source:"fresh"`; cached + validate→true → reuse, **no login**, `source:"cache"`; cached + validate→false → login + save + `source:"fresh"`; expired → login; write failure → non-fatal (still returns fresh session); no `validate` provided + cached → reuse without a check.
  - `saveSession`: writes `{cookie, savedAt}` JSON via the store.
- Existing calendar-cache/locations/etc. tests must stay green after the `CacheStore` extraction.
- Entrypoints and the `getLocations` validator are verified by a live run (against a throwaway cache; the real login path is already proven).

## Out of scope

- Worker-side caching (stateless; no filesystem — a future KV `CacheStore` could reuse this core).
- `cache status` (YAGNI for now).
- Any change to punch/calendar behavior beyond how the session is obtained.
