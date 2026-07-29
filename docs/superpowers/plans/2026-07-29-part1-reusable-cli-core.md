# Part 1 — Reusable CLI Core (session cache + toggles + runPunch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the punch CLI into a config-driven tool whose logic lives in one reusable `src/` flow (`runPunch`) an Agent can call, add a validate-before-use session cookie cache, and add independent calendar/session config toggles plus a `--force` per-run override.

**Architecture:** Extract the shared `CacheStore` interface, add a storage-agnostic `src/session-cache.ts`, and a `src/flow.ts` (`acquireSession` + `runPunch`) that the CLI entrypoints become thin adapters over. Everything is driven by `Config` (env > `.dev.vars` > defaults). The Worker (`src/scheduler.ts`, `src/index.ts`) is NOT touched.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), `tsx` for CLI scripts, Node `fs/promises` (only in `scripts/cache-fs.ts`).

## Global Constraints

- **Config precedence:** env vars > `.dev.vars` > code defaults. Secrets (`MAYO_USERNAME`/`MAYO_PASSWORD`) come from `export`/`.dev.vars`, never argv. The only per-run flag is `--force`/`-f`.
- **`src/` imports no `node:` module** (Workers pool safety). `scripts/cache-fs.ts` is the sole `node:fs` importer; no test and no `src/` file imports it.
- **`CALENDAR_CHECK` and `SESSION_CACHE` default `true`.** Effective calendar check = `cfg.calendarCheck && !force`.
- **Session cookie TTL = 9 days** (`9 * 24 * 60 * 60 * 1000`). Validate-before-use: reuse a cached cookie only if a cheap authenticated GET (locations) succeeds.
- **`session-cache.json`** is gitignored and written mode `0600`.
- **The Worker is out of scope:** do NOT modify `src/scheduler.ts` or `src/index.ts`; their tests must stay green.
- Every impure boundary is an injectable parameter with a real default (like `fetchImpl = fetch`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extract `CacheStore` into `src/cache-store.ts`

Pure refactor. Move the `CacheStore` interface out of `calendar-cache.ts` into its own module so `session-cache.ts` and `flow.ts` can share it. Re-export from `calendar-cache.ts` so existing imports keep working.

**Files:**
- Create: `src/cache-store.ts`
- Modify: `src/calendar-cache.ts` (remove local interface, import + re-export from `./cache-store`)

**Interfaces:**
- Produces: `export interface CacheStore { read: (key: string) => Promise<string | null>; write: (key: string, contents: string) => Promise<void>; }` in `src/cache-store.ts`; still re-exported from `src/calendar-cache.ts`.

- [ ] **Step 1: Create `src/cache-store.ts`**

```ts
// The storage boundary shared by the calendar cache and the session cache.
// fs-backed for the CLI (scripts/cache-fs.ts); a future Worker injects KV.
export interface CacheStore {
  read: (key: string) => Promise<string | null>; // null when absent
  write: (key: string, contents: string) => Promise<void>;
}
```

- [ ] **Step 2: Point `calendar-cache.ts` at it**

In `src/calendar-cache.ts`, delete the local block:
```ts
/** The storage boundary. fs-backed for the CLI; KV-backed for a future Worker. */
export interface CacheStore {
  read: (key: string) => Promise<string | null>; // null when absent
  write: (key: string, contents: string) => Promise<void>;
}
```
and add, next to the other imports at the top (after `import type { Session } from "./auth";`):
```ts
import type { CacheStore } from "./cache-store";
export type { CacheStore }; // re-export for existing importers (cache-fs, tests)
```

- [ ] **Step 3: Run the full suite — nothing should change behaviorally**

Run: `npm test`
Expected: all currently-passing tests still pass (calendar-cache tests import `CacheStore` from `../src/calendar-cache`, which now re-exports it).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cache-store.ts src/calendar-cache.ts
git commit -m "refactor: extract CacheStore into src/cache-store.ts (re-exported)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add `calendarCheck` / `sessionCache` to `Config`

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts` (append)

**Interfaces:**
- Produces: `Config.calendarCheck: boolean` and `Config.sessionCache: boolean` (both default `true`).

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:
```ts
describe("caching toggles", () => {
  const base = { MAYO_USERNAME: "u", MAYO_PASSWORD: "p", RESEND_API_KEY: "r", NOTIFY_TO: "a@b", NOTIFY_FROM: "c@d" };
  it("calendarCheck and sessionCache default to true", () => {
    const cfg = loadConfig(base as never);
    expect(cfg.calendarCheck).toBe(true);
    expect(cfg.sessionCache).toBe(true);
  });
  it("respects CALENDAR_CHECK/SESSION_CACHE = false", () => {
    const cfg = loadConfig({ ...base, CALENDAR_CHECK: "false", SESSION_CACHE: "false" } as never);
    expect(cfg.calendarCheck).toBe(false);
    expect(cfg.sessionCache).toBe(false);
  });
});
```
(If `loadConfig` is not already imported at the top of `test/config.test.ts`, add `import { loadConfig } from "../src/config";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts -t "caching toggles"`
Expected: FAIL — `cfg.calendarCheck` is `undefined`.

- [ ] **Step 3: Add the fields**

In `src/config.ts`, add to the `Config` interface (after `dryRun: boolean;`):
```ts
  calendarCheck: boolean; // CLI: check today's shift before punching
  sessionCache: boolean; // CLI: reuse the cached session cookie
```
and to the `loadConfig` return object (after `dryRun: bool(env, "DRY_RUN", false),`):
```ts
    calendarCheck: bool(env, "CALENDAR_CHECK", true),
    sessionCache: bool(env, "SESSION_CACHE", true),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. (Note: `src/scheduler.ts` does not read these fields; no change needed there.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add calendarCheck/sessionCache toggles (default true)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Session cookie cache — `src/session-cache.ts`

**Files:**
- Create: `src/session-cache.ts`
- Test: `test/session-cache.test.ts`

**Interfaces:**
- Consumes: `Session` + `login` from `./auth`; `Config` from `./config`; `CacheStore` from `./cache-store`.
- Produces:
  ```ts
  export const SESSION_KEY = "session-cache.json";
  export interface SessionFile { cookie: string; savedAt: string; }
  export interface SessionOpts { now?: () => Date; login?: (cfg: Config) => Promise<Session>; validate?: (session: Session) => Promise<boolean>; ttlMs?: number; }
  export function readCachedCookie(raw: string | null, now: Date, ttlMs?: number): string | null
  export async function getSession(cfg: Config, store: CacheStore, opts?: SessionOpts): Promise<{ session: Session; source: "cache" | "fresh" }>
  export async function saveSession(store: CacheStore, session: Session, now?: () => Date): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/session-cache.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { readCachedCookie, getSession, saveSession, SESSION_KEY, type SessionOpts } from "../src/session-cache";

const cfg: any = { userName: "u" };
const SESSION = { cookie: "__ModuleSessionCookie=LIVE" };
const NOW = new Date("2026-07-29T12:00:00Z");

function memStore(initial: string | null) {
  const state = { cur: initial, written: [] as Array<[string, string]> };
  const store = {
    read: async (_k: string) => state.cur,
    write: async (k: string, c: string) => { state.cur = c; state.written.push([k, c]); },
  };
  return { store, state };
}

describe("readCachedCookie", () => {
  const file = (cookie: unknown, savedAt: unknown) => JSON.stringify({ cookie, savedAt });
  it("returns the cookie when present and within the 9-day TTL", () => {
    expect(readCachedCookie(file("C", "2026-07-27T12:00:00Z"), NOW)).toBe("C");
  });
  it("null when older than the TTL", () => {
    expect(readCachedCookie(file("C", "2026-07-19T11:00:00Z"), NOW)).toBeNull();
  });
  it("null on missing raw / corrupt JSON / missing fields / bad date", () => {
    expect(readCachedCookie(null, NOW)).toBeNull();
    expect(readCachedCookie("{ not json", NOW)).toBeNull();
    expect(readCachedCookie(file(undefined, "2026-07-29T00:00:00Z"), NOW)).toBeNull();
    expect(readCachedCookie(file("C", "nope"), NOW)).toBeNull();
  });
});

const opts = (over: Partial<SessionOpts> = {}): SessionOpts => ({ now: () => NOW, login: vi.fn(async () => SESSION), ...over });

describe("getSession", () => {
  it("no cache → logs in, saves, source fresh", async () => {
    const { store, state } = memStore(null);
    const o = opts();
    const r = await getSession(cfg, store, o);
    expect(r).toEqual({ session: SESSION, source: "fresh" });
    expect(o.login).toHaveBeenCalledTimes(1);
    expect(state.written).toHaveLength(1);
    expect(state.written[0][0]).toBe(SESSION_KEY);
    expect(JSON.parse(state.written[0][1]).cookie).toBe(SESSION.cookie);
  });
  it("cached + validate true → reuse, no login, source cache", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "CACHED", savedAt: "2026-07-28T12:00:00Z" }));
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate: async () => true }));
    expect(r).toEqual({ session: { cookie: "CACHED" }, source: "cache" });
    expect(login).not.toHaveBeenCalled();
  });
  it("cached + validate false → re-login + save, source fresh", async () => {
    const { store, state } = memStore(JSON.stringify({ cookie: "DEAD", savedAt: "2026-07-28T12:00:00Z" }));
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate: async () => false }));
    expect(r.source).toBe("fresh");
    expect(login).toHaveBeenCalledTimes(1);
    expect(state.written).toHaveLength(1);
  });
  it("expired cache → re-login without validating", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "OLD", savedAt: "2026-07-01T12:00:00Z" }));
    const validate = vi.fn(async () => true);
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate }));
    expect(r.source).toBe("fresh");
    expect(validate).not.toHaveBeenCalled();
  });
  it("no validate provided + cached → reuse without a check", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "CACHED", savedAt: "2026-07-28T12:00:00Z" }));
    const r = await getSession(cfg, store, opts());
    expect(r).toEqual({ session: { cookie: "CACHED" }, source: "cache" });
  });
  it("write failure is non-fatal", async () => {
    const store = { read: async () => null, write: async () => { throw new Error("EACCES"); } };
    const r = await getSession(cfg, store, opts());
    expect(r).toEqual({ session: SESSION, source: "fresh" });
  });
});

describe("saveSession", () => {
  it("writes {cookie, savedAt} JSON via the store", async () => {
    const { store, state } = memStore(null);
    await saveSession(store, SESSION, () => NOW);
    expect(state.written[0][0]).toBe(SESSION_KEY);
    expect(JSON.parse(state.written[0][1])).toEqual({ cookie: SESSION.cookie, savedAt: NOW.toISOString() });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-cache.test.ts`
Expected: FAIL — cannot resolve `../src/session-cache`.

- [ ] **Step 3: Create `src/session-cache.ts`**

```ts
// Storage-agnostic session cookie cache. No node: import — only the injected
// CacheStore. Reuses a cached cookie only after validate-before-use.
import type { Session } from "./auth";
import { login as realLogin } from "./auth";
import type { Config } from "./config";
import type { CacheStore } from "./cache-store";

export const SESSION_KEY = "session-cache.json";
const TTL_MS = 9 * 24 * 60 * 60 * 1000;

export interface SessionFile {
  cookie: string;
  savedAt: string; // ISO-8601, read for staleness
}

export interface SessionOpts {
  now?: () => Date;
  login?: (cfg: Config) => Promise<Session>;
  validate?: (session: Session) => Promise<boolean>;
  ttlMs?: number;
}

/** Pure: the cached cookie iff present and savedAt within TTL; else null. */
export function readCachedCookie(raw: string | null, now: Date, ttlMs: number = TTL_MS): string | null {
  if (!raw) return null;
  let f: SessionFile;
  try {
    f = JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
  if (!f || typeof f.cookie !== "string" || !f.cookie || typeof f.savedAt !== "string") return null;
  const saved = Date.parse(f.savedAt);
  if (Number.isNaN(saved)) return null;
  if (now.getTime() - saved > ttlMs) return null;
  return f.cookie;
}

/** Force-write the current cookie to the cache. */
export async function saveSession(
  store: CacheStore,
  session: Session,
  now: () => Date = () => new Date(),
): Promise<void> {
  const file: SessionFile = { cookie: session.cookie, savedAt: now().toISOString() };
  await store.write(SESSION_KEY, JSON.stringify(file, null, 2) + "\n");
}

/**
 * Cached-or-fresh session. Reuses a cached cookie only if it validates (when a
 * `validate` is given); otherwise logs in fresh and saves. Write is non-fatal.
 */
export async function getSession(
  cfg: Config,
  store: CacheStore,
  opts: SessionOpts = {},
): Promise<{ session: Session; source: "cache" | "fresh" }> {
  const now = opts.now ?? (() => new Date());
  const login = opts.login ?? realLogin;
  const ttlMs = opts.ttlMs ?? TTL_MS;

  let raw: string | null = null;
  try {
    raw = await store.read(SESSION_KEY);
  } catch {
    raw = null;
  }
  const cookie = readCachedCookie(raw, now(), ttlMs);
  if (cookie) {
    const session: Session = { cookie };
    if (!opts.validate || (await opts.validate(session))) {
      return { session, source: "cache" };
    }
  }

  const session = await login(cfg);
  try {
    await saveSession(store, session, now);
  } catch (e) {
    console.error(`session-cache: write failed (${(e as Error).message}); continuing`);
  }
  return { session, source: "fresh" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/session-cache.ts test/session-cache.test.ts
git commit -m "feat(session-cache): validate-before-use cookie cache (9-day TTL)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Reusable flow — `src/flow.ts` (`acquireSession` + `runPunch`)

**Files:**
- Create: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `Session`+`login` (`./auth`), `Config` (`./config`), `CacheStore` (`./cache-store`), `DayInfo`+`getDayInfo` (`./calendar`), `cachedDayInfo` (`./calendar-cache`), `getSession` (`./session-cache`), `getLocations` (`./locations`), `punch`+`PunchOutcome` (`./punch`), `nowParts` (`./time`).
- Produces:
  ```ts
  export async function acquireSession(cfg: Config, store: CacheStore | null, deps?: AcquireDeps): Promise<{ session: Session; source: "cache" | "fresh" }>
  export interface RunPunchOpts { direction: "in" | "out"; force?: boolean; }
  export interface RunPunchResult { step: "punched" | "skipped"; reason?: string; outcome?: PunchOutcome; sessionSource: "cache" | "fresh"; calendarSource?: "cache" | "fresh"; dayInfo?: DayInfo; }
  export async function runPunch(cfg: Config, store: CacheStore | null, opts: RunPunchOpts, deps?: RunPunchDeps): Promise<RunPunchResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/flow.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { acquireSession, runPunch } from "../src/flow";

const SESSION = { cookie: "C" };
const WORK = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const OFF = { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null };
const SUCCESS = { outcome: "success", attendanceHistoryId: "AH", punchDate: "d", locationName: "L" };

describe("acquireSession", () => {
  it("logs in fresh when store is null", async () => {
    const login = vi.fn(async () => SESSION);
    const r = await acquireSession({ sessionCache: true } as any, null, { login });
    expect(r).toEqual({ session: SESSION, source: "fresh" });
    expect(login).toHaveBeenCalledTimes(1);
  });
  it("logs in fresh when sessionCache is off, even with a store", async () => {
    const login = vi.fn(async () => SESSION);
    const getSession = vi.fn();
    const r = await acquireSession({ sessionCache: false } as any, {} as any, { login, getSession: getSession as any });
    expect(r.source).toBe("fresh");
    expect(getSession).not.toHaveBeenCalled();
  });
  it("delegates to getSession with a locations-based validator when on", async () => {
    const cfg: any = { sessionCache: true };
    const getSession = vi.fn(async (_c: any, _s: any, o: any) => ({ session: SESSION, source: (await o.validate(SESSION)) ? "cache" : "fresh" }));
    const getLocations = vi.fn(async () => [{}]);
    const r = await acquireSession(cfg, {} as any, { getSession: getSession as any, getLocations: getLocations as any });
    expect(getLocations).toHaveBeenCalledWith(SESSION, cfg);
    expect(r.source).toBe("cache");
  });
});

describe("runPunch", () => {
  const cfg: any = { calendarCheck: true, timezone: "Asia/Taipei" };
  const acquire = async () => ({ session: SESSION, source: "cache" as const });

  it("workday → punches, returns outcome + both sources", async () => {
    const cachedDayInfo = vi.fn(async () => ({ info: WORK, source: "cache" }));
    const punch = vi.fn(async () => SUCCESS);
    const r = await runPunch(cfg, {} as any, { direction: "in" }, { acquireSession: acquire as any, cachedDayInfo: cachedDayInfo as any, punch: punch as any });
    expect(r.step).toBe("punched");
    expect(r.outcome).toEqual(SUCCESS);
    expect(r.sessionSource).toBe("cache");
    expect(r.calendarSource).toBe("cache");
    expect(punch).toHaveBeenCalledWith(SESSION, cfg, "in");
  });
  it("not a workday → skipped, no punch", async () => {
    const cachedDayInfo = vi.fn(async () => ({ info: OFF, source: "cache" }));
    const punch = vi.fn();
    const r = await runPunch(cfg, {} as any, { direction: "in" }, { acquireSession: acquire as any, cachedDayInfo: cachedDayInfo as any, punch: punch as any });
    expect(r.step).toBe("skipped");
    expect(r.reason).toMatch(/not a workday/);
    expect(punch).not.toHaveBeenCalled();
  });
  it("--force skips the calendar check entirely", async () => {
    const cachedDayInfo = vi.fn();
    const punch = vi.fn(async () => SUCCESS);
    const r = await runPunch(cfg, {} as any, { direction: "out", force: true }, { acquireSession: acquire as any, cachedDayInfo: cachedDayInfo as any, punch: punch as any });
    expect(cachedDayInfo).not.toHaveBeenCalled();
    expect(r.step).toBe("punched");
  });
  it("calendarCheck off skips the check", async () => {
    const cachedDayInfo = vi.fn();
    const punch = vi.fn(async () => SUCCESS);
    const r = await runPunch({ ...cfg, calendarCheck: false }, {} as any, { direction: "in" }, { acquireSession: acquire as any, cachedDayInfo: cachedDayInfo as any, punch: punch as any });
    expect(cachedDayInfo).not.toHaveBeenCalled();
    expect(r.step).toBe("punched");
  });
  it("null store uses live getDayInfo (no calendar cache)", async () => {
    const getDayInfo = vi.fn(async () => WORK);
    const cachedDayInfo = vi.fn();
    const punch = vi.fn(async () => SUCCESS);
    const r = await runPunch(cfg, null, { direction: "in" }, { acquireSession: acquire as any, getDayInfo: getDayInfo as any, cachedDayInfo: cachedDayInfo as any, punch: punch as any });
    expect(getDayInfo).toHaveBeenCalled();
    expect(cachedDayInfo).not.toHaveBeenCalled();
    expect(r.calendarSource).toBeUndefined();
    expect(r.step).toBe("punched");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — cannot resolve `../src/flow`.

- [ ] **Step 3: Create `src/flow.ts`**

```ts
// The reusable punch flow: session acquisition (respecting cfg.sessionCache) and
// the punch orchestration (respecting cfg.calendarCheck + a per-call force). The
// CLI and a future Agent both call this; Part 2's Worker will too. Every boundary
// is injectable for testing.
import type { Session } from "./auth";
import { login as realLogin } from "./auth";
import type { Config } from "./config";
import type { CacheStore } from "./cache-store";
import type { DayInfo } from "./calendar";
import { getDayInfo as realGetDayInfo } from "./calendar";
import { cachedDayInfo as realCachedDayInfo } from "./calendar-cache";
import { getSession as realGetSession } from "./session-cache";
import { getLocations as realGetLocations } from "./locations";
import { punch as realPunch, type PunchOutcome } from "./punch";
import { nowParts } from "./time";

export interface AcquireDeps {
  login?: (cfg: Config) => Promise<Session>;
  getSession?: typeof realGetSession;
  getLocations?: typeof realGetLocations;
}

/**
 * A session for the caller. `store === null` or `cfg.sessionCache === false` →
 * fresh login. Otherwise the cached cookie, validated by a cheap locations GET.
 */
export async function acquireSession(
  cfg: Config,
  store: CacheStore | null,
  deps: AcquireDeps = {},
): Promise<{ session: Session; source: "cache" | "fresh" }> {
  const login = deps.login ?? realLogin;
  if (!store || !cfg.sessionCache) {
    return { session: await login(cfg), source: "fresh" };
  }
  const getSession = deps.getSession ?? realGetSession;
  const getLocations = deps.getLocations ?? realGetLocations;
  return getSession(cfg, store, {
    login,
    validate: (s) => getLocations(s, cfg).then(() => true).catch(() => false),
  });
}

export interface RunPunchOpts {
  direction: "in" | "out";
  force?: boolean; // skip the calendar check for this run
}

export interface RunPunchResult {
  step: "punched" | "skipped";
  reason?: string; // when skipped
  outcome?: PunchOutcome; // when punched
  sessionSource: "cache" | "fresh";
  calendarSource?: "cache" | "fresh"; // present only when the cache was consulted
  dayInfo?: DayInfo; // present when the calendar was checked
}

export interface RunPunchDeps {
  acquireSession?: typeof acquireSession;
  cachedDayInfo?: typeof realCachedDayInfo;
  getDayInfo?: typeof realGetDayInfo;
  punch?: typeof realPunch;
  now?: () => Date;
}

/**
 * One punch: session → (optional workday check) → punch. Effective calendar
 * check = `cfg.calendarCheck && !opts.force`. With a store, the calendar read is
 * cached; without one (a stateless Worker) it is live.
 */
export async function runPunch(
  cfg: Config,
  store: CacheStore | null,
  opts: RunPunchOpts,
  deps: RunPunchDeps = {},
): Promise<RunPunchResult> {
  const acquire = deps.acquireSession ?? acquireSession;
  const punch = deps.punch ?? realPunch;
  const now = deps.now ?? (() => new Date());

  const { session, source: sessionSource } = await acquire(cfg, store);

  if (cfg.calendarCheck && !opts.force) {
    const { dateKey } = nowParts(cfg.timezone, now());
    let dayInfo: DayInfo;
    let calendarSource: "cache" | "fresh" | undefined;
    if (store) {
      const r = await (deps.cachedDayInfo ?? realCachedDayInfo)(session, cfg, dateKey, store);
      dayInfo = r.info;
      calendarSource = r.source;
    } else {
      dayInfo = await (deps.getDayInfo ?? realGetDayInfo)(session, cfg, dateKey);
    }
    if (!dayInfo.isWorkday) {
      return { step: "skipped", reason: "not a workday", sessionSource, calendarSource, dayInfo };
    }
    const outcome = await punch(session, cfg, opts.direction);
    return { step: "punched", outcome, sessionSource, calendarSource, dayInfo };
  }

  const outcome = await punch(session, cfg, opts.direction);
  return { step: "punched", outcome, sessionSource };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): reusable runPunch + acquireSession core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire `punch-now` to `runPunch` + `--force` + secure the store file

**Files:**
- Modify: `scripts/punch-now.ts` (full rewrite)
- Modify: `scripts/cache-fs.ts` (write mode `0600`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `runPunch` (`../src/flow`), `localConfig` (`./_env`), `fileStore` (`./cache-fs`).

- [ ] **Step 1: Rewrite `scripts/punch-now.ts`**

```ts
// Manual punch, via the shared src/flow.runPunch — the same core an Agent (and
// later the Worker) uses. Makes a REAL punch unless DRY_RUN=true.
//
//   npm run punch in            # clock in  (real)
//   npm run punch out           # clock out (real)
//   npm run punch in --force    # skip the calendar check for this run (-f works too)
//   DRY_RUN=true npm run punch in   # dry run — no real punch
//
// Credentials: env (export MAYO_USERNAME/MAYO_PASSWORD) or .dev.vars.
// Location/coords/toggles: config (env > .dev.vars > defaults).
import { runPunch } from "../src/flow";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const args = process.argv.slice(2);
const dir = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
const force = args.includes("--force") || args.includes("-f");
if (dir !== "in" && dir !== "out") {
  console.error("Usage: npm run punch in|out [--force|-f]   (add DRY_RUN=true for a no-op test)");
  process.exit(1);
}

const { cfg, credsFrom } = localConfig();

const nowStr = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
console.log("\x1b[1mApollo punch-now\x1b[0m (via src/flow.runPunch)");
console.log(`  direction : clock-${dir.toUpperCase()}${force ? "  \x1b[33m[--force: skip calendar]\x1b[0m" : ""}${cfg.dryRun ? "  \x1b[33m[DRY_RUN]\x1b[0m" : ""}`);
console.log(`  now       : ${nowStr} (${cfg.timezone})`);
console.log(`  account   : ${cfg.userName}  (creds from ${credsFrom})`);
console.log(`  location  : ${cfg.punchesLocationId}`);
console.log(`  coords    : ${cfg.latitude}, ${cfg.longitude}  (± ${cfg.gpsJitterMeters} m jitter)`);
console.log(`  toggles   : calendar=${cfg.calendarCheck ? "on" : "off"}  session=${cfg.sessionCache ? "on" : "off"}`);

const r = await runPunch(cfg, fileStore, { direction: dir as "in" | "out", force });

console.log(`\n  session   : ${r.sessionSource}${r.calendarSource ? `   calendar : ${r.calendarSource}` : ""}`);
if (r.dayInfo) {
  console.log(`  shift     : ${r.dayInfo.shiftStart ?? "--"}–${r.dayInfo.shiftEnd ?? "--"}  workday=${r.dayInfo.isWorkday}  onLeave=${r.dayInfo.onLeave}`);
}
if (r.step === "skipped") {
  console.log(`\n\x1b[33m⤼ Skipped: ${r.reason}. Not punching.\x1b[0m`);
  process.exit(0);
}
const o = r.outcome!;
console.log("");
if (o.outcome === "success") console.log(`\x1b[32m✅ SUCCESS — Mayo recorded clock-${dir} at ${o.punchDate} @ ${o.locationName}\x1b[0m`);
else if (o.outcome === "already_done") console.log(`\x1b[33m✅ Already clocked ${dir} today (${o.detail}) — nothing to do.\x1b[0m`);
else console.log(`\x1b[31m❌ FAILED: ${o.detail}\x1b[0m`); // cooldown or failure — honest feedback to a human
```

- [ ] **Step 2: Secure the store file in `scripts/cache-fs.ts`**

Change the import line to include `chmod`:
```ts
import { readFile, writeFile, chmod } from "node:fs/promises";
```
and replace the `write` method with:
```ts
  async write(key, contents) {
    await writeFile(key, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(key, 0o600); // enforce even if the file pre-existed with looser perms
  },
```

- [ ] **Step 3: Gitignore the session cache file**

Append to `.gitignore`:
```
session-cache.json
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (the Worker's `test/scheduler.test.ts` unchanged and green).

- [ ] **Step 5: Live verification (real API; DRY_RUN, no real punch)**

```bash
DRY_RUN=true npm run punch out
```
Expected: prints `toggles calendar=on session=on`; first run logs in (`session : fresh`), reads the calendar (`calendar : cache|fresh`), dry-punches; creates `session-cache.json`. Run it again — expect `session : cache`. Then:
```bash
DRY_RUN=true npm run punch out --force
```
Expected: no calendar line/`shift` line (check skipped), dry-punches. Confirm perms + ignore:
```bash
stat -c '%a' session-cache.json          # 600
git status --porcelain --ignored session-cache.json   # !! session-cache.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/punch-now.ts scripts/cache-fs.ts .gitignore
git commit -m "feat(punch): route through runPunch; add --force; store cookie 0600 + gitignore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Route the other entrypoints through `acquireSession`

**Files:**
- Modify: `scripts/list-locations.ts`
- Modify: `scripts/config-cli.ts` (no-id `set location` path)
- Modify: `scripts/sync-calendar.ts`

**Interfaces:**
- Consumes: `acquireSession` (`../src/flow`), `saveSession` (`../src/session-cache`), `fileStore` (`./cache-fs`).

- [ ] **Step 1: `scripts/list-locations.ts` — use the cached session**

Replace the imports:
```ts
import { login } from "../src/auth";
import { getLocations, formatLocations } from "../src/locations";
import { localConfig } from "./_env";
```
with:
```ts
import { acquireSession } from "../src/flow";
import { getLocations, formatLocations } from "../src/locations";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";
```
and replace `const session = await login(cfg);` with:
```ts
const { session } = await acquireSession(cfg, fileStore);
```

- [ ] **Step 2: `scripts/config-cli.ts` — cached session for the no-id listing**

In `config-cli.ts`, replace the import `import { login } from "../src/auth";` with:
```ts
import { acquireSession } from "../src/flow";
import { fileStore } from "./cache-fs";
```
(`config-cli.ts` does not import `fileStore` yet.) Then in the `set location`
no-id branch, replace `const session = await login(cfg);` with:
```ts
const { session } = await acquireSession(cfg, fileStore);
```

- [ ] **Step 3: `scripts/sync-calendar.ts` — also warm the cookie**

Add imports:
```ts
import { saveSession } from "../src/session-cache";
import { fileStore } from "./cache-fs";
```
After the existing `const session = await login(cfg);`, add:
```ts
if (cfg.sessionCache) await saveSession(fileStore, session);
```
(`calendar:sync` deliberately does a fresh login to refresh, then warms both caches.)

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 5: Live verification**

```bash
npm run calendar:sync     # logs in, writes session-cache.json + calendar-cache.json
npm run locations         # second run should reuse the cookie (fast; no re-login round trips)
```
Expected: both succeed; `session-cache.json` present.

- [ ] **Step 6: Commit**

```bash
git add scripts/list-locations.ts scripts/config-cli.ts scripts/sync-calendar.ts
git commit -m "feat: route locations/config/calendar:sync through the session cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `config` toggles — `config set calendar|session` + `config list`

**Files:**
- Modify: `scripts/dev-vars.ts` (FIELDS + `normalizeBool`)
- Modify: `scripts/config-cli.ts` (usage, boolean normalization, list lines)
- Test: `test/dev-vars.test.ts` (append)

**Interfaces:**
- Produces: `FIELDS.calendar = ["CALENDAR_CHECK"]`, `FIELDS.session = ["SESSION_CACHE"]`; `export const BOOLEAN_FIELDS: Set<string>`; `export function normalizeBool(v: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `test/dev-vars.test.ts`:
```ts
import { normalizeBool, BOOLEAN_FIELDS } from "../scripts/dev-vars";

describe("boolean toggle fields", () => {
  it("maps calendar/session to their env keys", () => {
    expect(buildEntries("calendar", ["true"])).toEqual({ CALENDAR_CHECK: "true" });
    expect(buildEntries("session", ["false"])).toEqual({ SESSION_CACHE: "false" });
  });
  it("BOOLEAN_FIELDS lists them", () => {
    expect(BOOLEAN_FIELDS.has("calendar")).toBe(true);
    expect(BOOLEAN_FIELDS.has("session")).toBe(true);
    expect(BOOLEAN_FIELDS.has("location")).toBe(false);
  });
  it("normalizeBool accepts on/off/true/false, rejects garbage", () => {
    expect(normalizeBool("on")).toBe("true");
    expect(normalizeBool("OFF")).toBe("false");
    expect(normalizeBool("true")).toBe("true");
    expect(() => normalizeBool("maybe")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dev-vars.test.ts -t "boolean toggle"`
Expected: FAIL — `normalizeBool`/`BOOLEAN_FIELDS` not exported; `calendar` unknown field.

- [ ] **Step 3: Extend `scripts/dev-vars.ts`**

Add the two fields to `FIELDS`:
```ts
  calendar: ["CALENDAR_CHECK"],
  session: ["SESSION_CACHE"],
```
and append:
```ts
/** Fields whose value is an on/off boolean (normalized before writing). */
export const BOOLEAN_FIELDS = new Set(["calendar", "session"]);

/** Normalize an on/off token to "true"/"false"; throws on anything else. */
export function normalizeBool(v: string): string {
  const t = v.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return "true";
  if (["off", "false", "0", "no"].includes(t)) return "false";
  throw new Error(`expected on/off (got "${v}")`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dev-vars.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the toggles into `scripts/config-cli.ts`**

Update the import from `./dev-vars` to include the new exports:
```ts
import { buildEntries, upsertEnvVars, FIELDS, BOOLEAN_FIELDS, normalizeBool } from "./dev-vars";
```
In `usage()`, add these two lines to the usage string (after the `pos` line):
```ts
      "  npm run config set calendar on|off     # check today's shift before punching\n" +
      "  npm run config set session on|off      # reuse the cached login cookie\n" +
```
In `cmdSet`, immediately before the `buildEntries` call, normalize boolean values:
```ts
  if (BOOLEAN_FIELDS.has(field) && values.length === 1) {
    try {
      values = [normalizeBool(values[0])];
    } catch (e) {
      console.error((e as Error).message);
      usage();
    }
  }
```
In `cmdList`, after the `timezone` line, add:
```ts
  console.log(`  calendar : ${cfg.calendarCheck ? "on" : "off"}`);
  console.log(`  session  : ${cfg.sessionCache ? "on" : "off"}`);
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 7: Live verification (throwaway file — real creds untouched)**

```bash
S=/tmp/apollo-test.dev.vars; rm -f "$S"
APOLLO_DEV_VARS="$S" npm run config set calendar off
APOLLO_DEV_VARS="$S" npm run config set session on
grep -E "CALENDAR_CHECK|SESSION_CACHE" "$S"   # CALENDAR_CHECK=false / SESSION_CACHE=true
APOLLO_DEV_VARS="$S" npm run config list      # shows calendar : off, session : on
rm -f "$S"
```
Expected: values normalized to true/false; `config list` shows `calendar : off` and `session : on`.

- [ ] **Step 8: Commit**

```bash
git add scripts/dev-vars.ts scripts/config-cli.ts test/dev-vars.test.ts
git commit -m "feat(config): config set calendar|session toggles + config list rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs — README + api-facts

**Files:**
- Modify: `README.md`
- Modify: `docs/api-facts.md`

- [ ] **Step 1: Update `README.md` Setup step 1 (credentials)**

Replace the current step-1 block with:
```markdown
1. **Credentials** — via env (`export`) or the config CLI (writes gitignored `.dev.vars`):
   ```bash
   export MAYO_USERNAME=you@company.com MAYO_PASSWORD=…    # or:
   npm run config set username you@company.com
   npm run config set password            # prompted, hidden — never argv/history
   ```
   Precedence is **env > `.dev.vars` > defaults**, so `export` overrides the file.
   The password is never taken as a CLI argument (it would leak to shell history / `ps`).
```

- [ ] **Step 2: Add a caching/toggles subsection to `README.md`**

After Setup step 4's calendar-cache paragraph, add:
```markdown
### Caching & toggles

`punch` runs the shared `src/flow.runPunch` core (also callable by an Agent). Two
independent toggles, both **on** by default, set via `config` (or env
`CALENDAR_CHECK` / `SESSION_CACHE`):

- `npm run config set calendar on|off` — check today's shift (workday guard) before punching, or skip it.
- `npm run config set session on|off` — reuse the ~10-day login cookie (validated before use), or log in fresh each run.
- `npm run punch in --force` (`-f`) — skip the calendar check for that one run.
- `npm run config list` shows the effective config, both toggles, password masked.

The session cookie lives in gitignored `session-cache.json` (mode 600); it's
reused across runs and re-validated by a cheap request, so a revoked cookie
never breaks a punch.
```

- [ ] **Step 3: Update the `README.md` Layout `src/` bullet**

Add `flow` and `session-cache` to the `src/` list:
```markdown
- `src/` — `config`, `auth`, `calendar`, `punch`, `locations`, `notify`, `time`,
  `calendar-cache`, `session-cache` (validate-before-use cookie cache),
  `cache-store` (shared `CacheStore`), `flow` (`runPunch`/`acquireSession` — the
  reusable core), `scheduler` + `index` (the Worker, unchanged).
```

- [ ] **Step 4: Update `docs/api-facts.md`**

Under the auth section, add:
```markdown
The CLI reuses the `__ModuleSessionCookie` across runs via `src/session-cache.ts`
(gitignored `session-cache.json`, 9-day TTL). **Validate-before-use:** a cached
cookie is trusted only after a cheap authenticated GET (locations/EnableList)
succeeds; otherwise it re-logs-in. Toggle with `SESSION_CACHE` (default on). The
Worker does not cache sessions (stateless).
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/api-facts.md
git commit -m "docs: session cache, calendar/session toggles, --force, runPunch core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Do not touch `src/scheduler.ts` or `src/index.ts`.** The Worker keeps its own inline flow in Part 1; `test/scheduler.test.ts` must stay green untouched.
- **`src/` stays `node:`-free.** Only `scripts/cache-fs.ts` imports `node:fs`. `session-cache.ts` and `flow.ts` touch storage only through the injected `CacheStore`.
- **Two different "source"s** in a `RunPunchResult`: `sessionSource` (cookie cache/fresh) and `calendarSource` (calendar cache/fresh). Keep them distinct.
- **npm arg forwarding:** `npm run punch in --force` forwards `--force` to the script (verified pattern in this repo: `npm run punch out` already forwards positional args). The live step confirms it; if a future npm swallows it, `npm run punch in -- --force` always works.
- **`config set password` is unchanged** (still a hidden prompt). This plan does not add a `--pass` flag by design.
