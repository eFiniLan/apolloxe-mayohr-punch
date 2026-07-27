# Calendar Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run punch` skip the ~350ms live calendar read by serving the workday guard and shift times from a local, human-readable `calendar-cache.json`, auto-refreshed when stale — with a `npm run calendar:sync` command to pre-warm/refresh it without punching.

**Architecture:** Extract a month-level `getMonthInfo` from `src/calendar.ts` (the single source of truth for calendar parsing). Add a **storage-agnostic** cache core in `src/calendar-cache.ts` whose only I/O boundary is an injected `CacheStore` (`read`/`write`) — no `fs`, no KV, so `src/` stays filesystem-free and stateless and a future Worker can reuse it with a KV-backed store. A file-backed store lives in `scripts/cache-fs.ts` (the only place that touches `node:fs`); the CLI entrypoints inject it. `scripts/punch-now.ts` reads through the cache; `scripts/sync-calendar.ts` (`npm run calendar:sync`) force-refreshes it.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), `tsx` for CLI scripts, Node `fs/promises` (only in `scripts/cache-fs.ts`).

## Global Constraints

- **CLI-only behavior; Worker-ready design.** The cache is used only by `scripts/punch-now.ts` / `scripts/sync-calendar.ts` now. The deployed Worker (`src/index.ts`, `src/scheduler.ts`) is unchanged and stays stateless. No KV is added. The cache core lives in `src/` purely so a future Worker *could* inject a KV store — nothing wires that yet.
- **`src/calendar-cache.ts` imports no `node:` module.** Its only storage boundary is the injected `CacheStore`. The sole `node:fs` import in the whole feature is in `scripts/cache-fs.ts`, which no test and no `src/` file imports. This keeps `src/` Workers-safe and the cache tests runnable in the Workers pool.
- **Impure-boundary injection convention:** every side effect (`CacheStore.read`/`write`, `now`, month fetch `getMonthInfo`) is injectable with a real default where one exists, exactly like `fetchImpl = fetch` and `rand = Math.random` elsewhere. `CacheStore` has no default in the core (storage is caller-chosen); `now`/`getMonthInfo` default inline.
- **`src/calendar.ts` stays the only calendar parser.** The cache reuses `getMonthInfo`; it must not re-derive `DayInfo`.
- **JSON field contract:** the program reads only `workday`, `onLeave`, `shiftStart`, `shiftEnd` (per day) and `generatedAt` (ISO-8601). `label`, `timezone`, `months` are human-only and never parsed back.
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extract `getMonthInfo` from `src/calendar.ts`

Pure refactor: expose a month-level parser and make `getDayInfo` a thin wrapper over it. External behavior of `getDayInfo` is unchanged, so its existing tests must stay green.

**Files:**
- Modify: `src/calendar.ts`
- Test: `test/calendar.test.ts` (add cases; keep existing ones passing)

**Interfaces:**
- Consumes: existing `DayInfo`, `CALENDAR_URL`, `REFERER_URL`, `toLocalHHMM`, `coversWholeShift`, `CalendarDay`, `CalendarResponse`, `Session`, `Config` in `src/calendar.ts`.
- Produces:
  ```ts
  export async function getMonthInfo(
    session: Session, cfg: Config, year: number, month: number,
    fetchImpl?: typeof fetch,
  ): Promise<Record<string, DayInfo>>  // keyed "YYYY-MM-DD"
  // getDayInfo(session, cfg, dateKey, fetchImpl?) : Promise<DayInfo> — signature unchanged
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/calendar.test.ts` (after the existing `describe("getDayInfo", ...)` block):

```ts
import { getMonthInfo } from "../src/calendar";

describe("getMonthInfo", () => {
  it("returns a DayInfo map for the whole month keyed by YYYY-MM-DD", async () => {
    const f = mockFetch();
    const month = await getMonthInfo(session, cfg, 2026, 7, f as any);

    expect(Object.keys(month).sort()).toEqual([
      "2026-07-03", "2026-07-04", "2026-07-23", "2026-07-24",
    ]);
    expect(month["2026-07-23"]).toEqual({
      isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30",
    });
    expect(month["2026-07-04"]).toEqual({
      isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null,
    });
  });

  it("hits the URL with the given year/month and sends the session cookie + accept-language", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(fixture), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    await getMonthInfo(session, cfg, 2026, 7, f as any);
    expect(calls[0].url).toBe(`${CAL_URL_PREFIX}?year=2026&month=7`);
    expect(calls[0].init.headers.cookie).toBe(session.cookie);
    expect(calls[0].init.headers["accept-language"]).toBe("en-us");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/calendar.test.ts -t "getMonthInfo"`
Expected: FAIL — `getMonthInfo is not a function` / import has no such export.

- [ ] **Step 3: Refactor `src/calendar.ts`**

Add a private `deriveDayInfo`, add `getMonthInfo`, and rewrite `getDayInfo` to delegate. Replace the current body of `getDayInfo` (lines ~90–145) with:

```ts
function deriveDayInfo(entry: CalendarDay, tz: string): DayInfo {
  const ss = entry.shiftSchedule;
  const isWorkday = ss?.workOnTime != null;
  const schedOn = ss ? (ss.originalWorkOnTime ?? ss.workOnTime) : null;
  const schedOff = ss ? (ss.originalWorkOffTime ?? ss.workOffTime) : null;
  const shiftStart = isWorkday && schedOn ? toLocalHHMM(schedOn, tz) : null;
  const shiftEnd = isWorkday && schedOff ? toLocalHHMM(schedOff, tz) : null;
  const onLeave =
    isWorkday &&
    (coversWholeShift(entry.leaveSheets, schedOn, schedOff) ||
      coversWholeShift(entry.tripSheets, schedOn, schedOff));
  return { isWorkday, onLeave, shiftStart, shiftEnd };
}

/**
 * Read the scheduling calendar for one month and map every day to a DayInfo,
 * keyed "YYYY-MM-DD". See docs/api-facts.md "Calendar / shift schedule".
 */
export async function getMonthInfo(
  session: Session,
  cfg: Config,
  year: number,
  month: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, DayInfo>> {
  const url = `${CALENDAR_URL}?year=${year}&month=${month}`;

  const res = await fetchImpl(url, {
    headers: {
      cookie: session.cookie,
      "user-agent": cfg.userAgent,
      accept: "*/*",
      // REQUIRED: without accept-language the API returns a different
      // (numeric-indexed) shape with no `data.calendars`.
      "accept-language": "en-us",
      "content-type": "application/json",
      referer: REFERER_URL,
    },
  });

  if (!res.ok) {
    throw new Error(`calendar: HTTP ${res.status} fetching ${url}`);
  }

  let json: CalendarResponse;
  try {
    json = (await res.json()) as CalendarResponse;
  } catch (e) {
    throw new Error(`calendar: response was not JSON (${(e as Error).message})`);
  }

  const out: Record<string, DayInfo> = {};
  for (const entry of json.data?.calendars ?? []) {
    const dateKey = String(entry.date).slice(0, 10); // "YYYY-MM-DDT..." -> "YYYY-MM-DD"
    out[dateKey] = deriveDayInfo(entry, cfg.timezone);
  }
  return out;
}

/**
 * DayInfo for a single day. Thin wrapper over getMonthInfo.
 */
export async function getDayInfo(
  session: Session,
  cfg: Config,
  dateKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DayInfo> {
  const [yearStr, monthStr] = dateKey.split("-");
  const month = await getMonthInfo(session, cfg, Number(yearStr), Number(monthStr), fetchImpl);
  const info = month[dateKey];
  if (!info) {
    throw new Error(`No calendar entry for ${dateKey}`);
  }
  return info;
}
```

Leave `toLocalHHMM`, `coversWholeShift`, `sheetRange`, the interfaces, and the constants as they are.

- [ ] **Step 4: Run the full calendar test file to verify everything passes**

Run: `npx vitest run test/calendar.test.ts`
Expected: PASS — all pre-existing `getDayInfo` tests plus the two new `getMonthInfo` tests. (The `2026-08-15` missing-day test and the `500` test still pass because `getDayInfo` delegates.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calendar.ts test/calendar.test.ts
git commit -m "refactor(calendar): extract getMonthInfo; getDayInfo wraps it

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Storage-agnostic cache core — pure helpers in `src/calendar-cache.ts`

The data model, the `CacheStore` boundary, and all pure functions — no I/O, no orchestration. Fully deterministic and testable in the Workers pool (no `node:` imports).

**Files:**
- Create: `src/calendar-cache.ts`
- Test: `test/calendar-cache.test.ts`

**Interfaces:**
- Consumes: `DayInfo`, `getMonthInfo` from `./calendar`; `Config` from `./config`; `Session` from `./auth`.
- Produces:
  ```ts
  export const CACHE_KEY = "calendar-cache.json"; // filename for the file store; key for a future KV store
  export interface CacheDay { workday: boolean; onLeave: boolean; shiftStart: string | null; shiftEnd: string | null; label: string; }
  export interface CacheFile { generatedAt: string; timezone: string; months: string[]; days: Record<string, CacheDay>; }
  export interface CacheStore { read: (key: string) => Promise<string | null>; write: (key: string, contents: string) => Promise<void>; }
  export interface CacheOpts { now?: () => Date; getMonthInfo?: typeof getMonthInfo; }
  export function dayLabel(dateKey: string, info: DayInfo): string
  export function infoToCacheDay(dateKey: string, info: DayInfo): CacheDay
  export function cacheDayToInfo(d: CacheDay): DayInfo
  export function isFresh(file: CacheFile, dateKey: string, now: Date): boolean
  export function targetMonths(dateKey: string): Array<{ year: number; month: number }>
  export function monthLabel(year: number, month: number): string
  export async function buildCache(session: Session, cfg: Config, dateKey: string, opts?: CacheOpts): Promise<CacheFile>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/calendar-cache.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  dayLabel, infoToCacheDay, cacheDayToInfo, isFresh,
  targetMonths, monthLabel, buildCache,
  type CacheFile, type CacheOpts,
} from "../src/calendar-cache";
import type { DayInfo } from "../src/calendar";

const WORK: DayInfo = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const OFF: DayInfo = { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null };
const cfg: any = { timezone: "Asia/Taipei" };
const session: any = { cookie: "c" };

describe("dayLabel", () => {
  it("workday shows weekday + shift range", () => {
    expect(dayLabel("2026-07-23", WORK)).toMatch(/^\w{3} · work · 09:30-18:30$/);
  });
  it("marks leave", () => {
    expect(dayLabel("2026-07-23", { ...WORK, onLeave: true })).toMatch(/^\w{3} · work · 09:30-18:30 · leave$/);
  });
  it("non-workday shows off", () => {
    expect(dayLabel("2026-07-04", OFF)).toMatch(/^\w{3} · off$/);
  });
});

describe("infoToCacheDay / cacheDayToInfo round-trip", () => {
  it("preserves the structured DayInfo fields", () => {
    const cd = infoToCacheDay("2026-07-23", WORK);
    expect(cd).toEqual({ workday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30", label: cd.label });
    expect(cacheDayToInfo(cd)).toEqual(WORK);
  });
});

describe("targetMonths / monthLabel", () => {
  it("current + next month, mid-year", () => {
    expect(targetMonths("2026-07-23")).toEqual([{ year: 2026, month: 7 }, { year: 2026, month: 8 }]);
  });
  it("rolls over the year in December", () => {
    expect(targetMonths("2026-12-15")).toEqual([{ year: 2026, month: 12 }, { year: 2027, month: 1 }]);
  });
  it("monthLabel zero-pads", () => {
    expect(monthLabel(2026, 8)).toBe("2026-08");
  });
});

describe("isFresh", () => {
  const now = new Date("2026-07-27T12:00:00Z");
  const file = (genIso: string, days: Record<string, unknown>): CacheFile =>
    ({ generatedAt: genIso, timezone: "Asia/Taipei", months: [], days: days as any });

  it("fresh when generated <7d ago and today present", () => {
    expect(isFresh(file("2026-07-25T12:00:00Z", { "2026-07-27": {} }), "2026-07-27", now)).toBe(true);
  });
  it("stale when generated >7d ago", () => {
    expect(isFresh(file("2026-07-19T11:00:00Z", { "2026-07-27": {} }), "2026-07-27", now)).toBe(false);
  });
  it("stale when today absent even if recent", () => {
    expect(isFresh(file("2026-07-27T09:00:00Z", { "2026-07-26": {} }), "2026-07-27", now)).toBe(false);
  });
  it("stale when generatedAt is unparseable", () => {
    expect(isFresh(file("not-a-date", { "2026-07-27": {} }), "2026-07-27", now)).toBe(false);
  });
});

describe("buildCache", () => {
  it("fetches current + next month and assembles a CacheFile", async () => {
    const getMonthInfo = vi.fn(async (_s: any, _c: any, year: number, month: number) => {
      if (year === 2026 && month === 7) return { "2026-07-23": WORK, "2026-07-04": OFF };
      if (year === 2026 && month === 8) return { "2026-08-01": OFF };
      return {};
    });
    const opts: CacheOpts = { now: () => new Date("2026-07-27T12:00:00Z"), getMonthInfo: getMonthInfo as any };

    const file = await buildCache(session, cfg, "2026-07-27", opts);

    expect(getMonthInfo).toHaveBeenCalledTimes(2);
    expect(file.generatedAt).toBe("2026-07-27T12:00:00.000Z");
    expect(file.timezone).toBe("Asia/Taipei");
    expect(file.months).toEqual(["2026-07", "2026-08"]);
    expect(Object.keys(file.days).sort()).toEqual(["2026-07-04", "2026-07-23", "2026-08-01"]);
    expect(cacheDayToInfo(file.days["2026-07-23"])).toEqual(WORK);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/calendar-cache.test.ts`
Expected: FAIL — cannot resolve `../src/calendar-cache`.

- [ ] **Step 3: Create `src/calendar-cache.ts` (pure parts only)**

```ts
// Storage-agnostic calendar cache. The ONLY I/O boundary is the injected
// CacheStore (read/write) — no node:fs, no KV — so this stays Workers-safe and
// unit-tests without touching the filesystem. The CLI injects a file-backed
// store (scripts/cache-fs.ts); a future Worker could inject a KV-backed store.
import type { DayInfo } from "./calendar";
import { getMonthInfo } from "./calendar";
import type { Config } from "./config";
import type { Session } from "./auth";

export const CACHE_KEY = "calendar-cache.json";
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheDay {
  workday: boolean;
  onLeave: boolean;
  shiftStart: string | null;
  shiftEnd: string | null;
  label: string; // human-only; never parsed back
}

export interface CacheFile {
  generatedAt: string; // ISO-8601 (read for staleness)
  timezone: string; // human-only
  months: string[]; // human-only, e.g. ["2026-07","2026-08"]
  days: Record<string, CacheDay>; // keyed "YYYY-MM-DD"
}

/** The storage boundary. fs-backed for the CLI; KV-backed for a future Worker. */
export interface CacheStore {
  read: (key: string) => Promise<string | null>; // null when absent
  write: (key: string, contents: string) => Promise<void>;
}

/** Injectable non-storage boundaries (clock, month fetch). Both default inline. */
export interface CacheOpts {
  now?: () => Date;
  getMonthInfo?: typeof getMonthInfo;
}

/** Human-readable one-liner for a day. Code never reads this back. */
export function dayLabel(dateKey: string, info: DayInfo): string {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${dateKey}T00:00:00Z`));
  if (!info.isWorkday) return `${weekday} · off`;
  const leave = info.onLeave ? " · leave" : "";
  return `${weekday} · work · ${info.shiftStart}-${info.shiftEnd}${leave}`;
}

export function infoToCacheDay(dateKey: string, info: DayInfo): CacheDay {
  return {
    workday: info.isWorkday,
    onLeave: info.onLeave,
    shiftStart: info.shiftStart,
    shiftEnd: info.shiftEnd,
    label: dayLabel(dateKey, info),
  };
}

export function cacheDayToInfo(d: CacheDay): DayInfo {
  return {
    isWorkday: d.workday,
    onLeave: d.onLeave,
    shiftStart: d.shiftStart,
    shiftEnd: d.shiftEnd,
  };
}

export function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Current month + next month (year rolls over in December). */
export function targetMonths(dateKey: string): Array<{ year: number; month: number }> {
  const [y, m] = dateKey.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return [
    { year: y, month: m },
    { year: nextY, month: nextM },
  ];
}

/** Fresh = today is present AND generated within the refresh window. */
export function isFresh(file: CacheFile, dateKey: string, now: Date): boolean {
  if (!file.days[dateKey]) return false;
  const gen = Date.parse(file.generatedAt);
  if (Number.isNaN(gen)) return false;
  return now.getTime() - gen <= REFRESH_AFTER_MS;
}

/** Fetch the target months and assemble a fresh CacheFile (does not write). */
export async function buildCache(
  session: Session,
  cfg: Config,
  dateKey: string,
  opts: CacheOpts = {},
): Promise<CacheFile> {
  const now = opts.now ?? (() => new Date());
  const fetchMonth = opts.getMonthInfo ?? getMonthInfo;
  const months = targetMonths(dateKey);
  const days: Record<string, CacheDay> = {};
  for (const { year, month } of months) {
    const monthInfo = await fetchMonth(session, cfg, year, month);
    for (const [dk, info] of Object.entries(monthInfo)) {
      days[dk] = infoToCacheDay(dk, info);
    }
  }
  return {
    generatedAt: now().toISOString(),
    timezone: cfg.timezone,
    months: months.map(({ year, month }) => monthLabel(year, month)),
    days,
  };
}
```

Note: `generatedAt` is stored as UTC ISO (`toISOString()`) rather than the spec's local-offset example — unambiguous, parseable for the staleness check, and avoids hand-rolling a timezone offset. Local context is still visible via each day's `label` and the top-level `timezone`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/calendar-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calendar-cache.ts test/calendar-cache.test.ts
git commit -m "feat(cache): storage-agnostic calendar-cache core (model, staleness, build)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Orchestration — `cachedDayInfo` + `syncCalendar` over an injected `CacheStore`

Adds the read-or-refresh entrypoint and the force-refresh entrypoint. Both take a `CacheStore`. A write failure is non-fatal (never block a punch); a successful refresh with today genuinely absent throws the same clear error as `getDayInfo` does today.

**Files:**
- Modify: `src/calendar-cache.ts`
- Test: `test/calendar-cache.test.ts` (add cases)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  ```ts
  export async function cachedDayInfo(
    session: Session, cfg: Config, dateKey: string, store: CacheStore, opts?: CacheOpts,
  ): Promise<{ info: DayInfo; source: "cache" | "fresh" }>
  export async function syncCalendar(
    session: Session, cfg: Config, dateKey: string, store: CacheStore, opts?: CacheOpts,
  ): Promise<CacheFile>
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/calendar-cache.test.ts`:

```ts
import { cachedDayInfo, syncCalendar, CACHE_KEY, type CacheStore } from "../src/calendar-cache";

function freshFileJson(now = "2026-07-27T12:00:00Z"): string {
  return JSON.stringify({
    generatedAt: now,
    timezone: "Asia/Taipei",
    months: ["2026-07", "2026-08"],
    days: { "2026-07-27": { workday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30", label: "x" } },
  });
}

const OPTS: CacheOpts = {
  now: () => new Date("2026-07-27T12:00:00Z"),
  getMonthInfo: vi.fn(async (_s: any, _c: any, _y: number, m: number) =>
    m === 7 ? { "2026-07-27": WORK } : { "2026-08-01": OFF }) as any,
};

function memStore(initial: string | null): CacheStore & { written: string[] } {
  let cur = initial;
  const written: string[] = [];
  return {
    written,
    read: async () => cur,
    write: async (_k, c) => { cur = c; written.push(c); },
  };
}

describe("cachedDayInfo", () => {
  it("returns the cached day without fetching when fresh", async () => {
    const getMonthInfo = vi.fn();
    const store = memStore(freshFileJson());
    const r = await cachedDayInfo(session, cfg, "2026-07-27", store, { ...OPTS, getMonthInfo: getMonthInfo as any });
    expect(r).toEqual({ info: WORK, source: "cache" });
    expect(getMonthInfo).not.toHaveBeenCalled();
    expect(store.written).toHaveLength(0);
  });

  it("refreshes and writes when the store is empty", async () => {
    const store = memStore(null);
    const r = await cachedDayInfo(session, cfg, "2026-07-27", store, OPTS);
    expect(r.source).toBe("fresh");
    expect(r.info).toEqual(WORK);
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toContain('"2026-07-27"');
    expect(store.written[0].endsWith("\n")).toBe(true); // pretty-printed + trailing newline
  });

  it("refreshes when the cached file is stale (>7d)", async () => {
    const store = memStore(freshFileJson("2026-07-01T12:00:00Z"));
    const r = await cachedDayInfo(session, cfg, "2026-07-27", store, OPTS);
    expect(r.source).toBe("fresh");
  });

  it("treats a corrupt cache file as absent and refreshes (no throw)", async () => {
    const store = memStore("{ not json");
    const r = await cachedDayInfo(session, cfg, "2026-07-27", store, OPTS);
    expect(r.source).toBe("fresh");
    expect(r.info).toEqual(WORK);
  });

  it("does not fail the punch if writing the cache throws", async () => {
    const store: CacheStore = { read: async () => null, write: async () => { throw new Error("EACCES"); } };
    const r = await cachedDayInfo(session, cfg, "2026-07-27", store, OPTS);
    expect(r).toEqual({ info: WORK, source: "fresh" });
  });

  it("throws a clear error when the day is genuinely absent after refresh", async () => {
    const store = memStore(null);
    const r = cachedDayInfo(session, cfg, "2026-07-27", store, { ...OPTS, getMonthInfo: (async () => ({})) as any });
    await expect(r).rejects.toThrow(/2026-07-27/);
  });
});

describe("syncCalendar", () => {
  it("always builds and writes, returning the file", async () => {
    const store = memStore(freshFileJson());
    const file = await syncCalendar(session, cfg, "2026-07-27", store, OPTS);
    expect(store.written).toHaveLength(1); // ignores the fresh cache; forces a refresh
    expect(file.months).toEqual(["2026-07", "2026-08"]);
    expect(Object.keys(file.days)).toContain("2026-07-27");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/calendar-cache.test.ts -t "cachedDayInfo"`
Expected: FAIL — `cachedDayInfo is not a function`.

- [ ] **Step 3: Add orchestration to `src/calendar-cache.ts`**

Append to `src/calendar-cache.ts`:

```ts
function serialize(file: CacheFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Read today's DayInfo from the store, refreshing (fetch current + next month,
 * rewrite) when the cache is missing, corrupt, stale (>7d), or lacks today. A
 * failed write is logged but non-fatal — a cache problem must never block a punch.
 */
export async function cachedDayInfo(
  session: Session,
  cfg: Config,
  dateKey: string,
  store: CacheStore,
  opts: CacheOpts = {},
): Promise<{ info: DayInfo; source: "cache" | "fresh" }> {
  const now = opts.now ?? (() => new Date());

  let cached: CacheFile | null = null;
  try {
    const raw = await store.read(CACHE_KEY);
    if (raw) cached = JSON.parse(raw) as CacheFile;
  } catch {
    cached = null; // unreadable or corrupt → refresh
  }
  if (cached && isFresh(cached, dateKey, now())) {
    return { info: cacheDayToInfo(cached.days[dateKey]), source: "cache" };
  }

  const file = await buildCache(session, cfg, dateKey, opts);
  try {
    await store.write(CACHE_KEY, serialize(file));
  } catch (e) {
    console.error(`calendar-cache: write failed (${(e as Error).message}); continuing`);
  }

  const day = file.days[dateKey];
  if (!day) throw new Error(`No calendar entry for ${dateKey}`);
  return { info: cacheDayToInfo(day), source: "fresh" };
}

/** Force a refresh regardless of freshness. Used by `npm run calendar:sync`. */
export async function syncCalendar(
  session: Session,
  cfg: Config,
  dateKey: string,
  store: CacheStore,
  opts: CacheOpts = {},
): Promise<CacheFile> {
  const file = await buildCache(session, cfg, dateKey, opts);
  await store.write(CACHE_KEY, serialize(file));
  return file;
}
```

- [ ] **Step 4: Run the full cache test file to verify it passes**

Run: `npx vitest run test/calendar-cache.test.ts`
Expected: PASS (Task 2 cases + all new `cachedDayInfo` / `syncCalendar` cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calendar-cache.ts test/calendar-cache.test.ts
git commit -m "feat(cache): cachedDayInfo + syncCalendar over an injected CacheStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: File-backed store + CLI wiring

The file store (the only `node:fs` in the feature), the `punch` swap, the pre-cache command, and config. Entrypoints have no unit tests; verified by typecheck and a live run.

**Files:**
- Create: `scripts/cache-fs.ts`
- Create: `scripts/sync-calendar.ts`
- Modify: `scripts/punch-now.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `CacheStore` from `../src/calendar-cache`; `cachedDayInfo`, `syncCalendar`, `CACHE_KEY` from `../src/calendar-cache`; `login` from `../src/auth`; `nowParts` from `../src/time`; `localConfig` from `./_env`.
- Produces: `export const fileStore: CacheStore` in `scripts/cache-fs.ts`.

- [ ] **Step 1: Create the file-backed store `scripts/cache-fs.ts`**

```ts
// The file-backed CacheStore for the CLI. This is the ONLY place in the feature
// that imports node:fs — no test and no src/ file imports it, so src/ stays
// Workers-safe. A future Worker would provide a KV-backed CacheStore instead.
import { readFile, writeFile } from "node:fs/promises";
import type { CacheStore } from "../src/calendar-cache";

export const fileStore: CacheStore = {
  async read(key) {
    try {
      return await readFile(key, "utf8");
    } catch {
      return null; // absent → treat as no cache
    }
  },
  async write(key, contents) {
    await writeFile(key, contents, "utf8");
  },
};
```

- [ ] **Step 2: Swap `punch-now.ts` to read through the cache**

In `scripts/punch-now.ts`, change the calendar import and the read block.

Replace `import { getDayInfo } from "../src/calendar";` with:
```ts
import { cachedDayInfo } from "../src/calendar-cache";
import { fileStore } from "./cache-fs";
```

Replace these lines (currently ~38–41):
```ts
const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ read calendar (calendar.getDayInfo) for ${dateKey}\x1b[0m`);
const info = await getDayInfo(session, cfg, dateKey);
console.log(`  workday=${info.isWorkday}  shift=${info.shiftStart ?? "--"}–${info.shiftEnd ?? "--"}  onLeave=${info.onLeave}`);
```
with:
```ts
const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ read calendar (cached) for ${dateKey}\x1b[0m`);
const { info, source } = await cachedDayInfo(session, cfg, dateKey, fileStore);
console.log(`  workday=${info.isWorkday}  shift=${info.shiftStart ?? "--"}–${info.shiftEnd ?? "--"}  onLeave=${info.onLeave}  \x1b[2m(${source})\x1b[0m`);
```

- [ ] **Step 3: Create the pre-cache command `scripts/sync-calendar.ts`**

```ts
// Pre-warm / force-refresh the local calendar cache (calendar-cache.json)
// WITHOUT punching. Reuses the same login + getMonthInfo the punch command uses,
// so it can't drift.
//
//   npm run calendar:sync
//
// Credentials: .dev.vars (or MAYO_USERNAME / MAYO_PASSWORD env vars).
import { login } from "../src/auth";
import { nowParts } from "../src/time";
import { localConfig } from "./_env";
import { syncCalendar, CACHE_KEY } from "../src/calendar-cache";
import { fileStore } from "./cache-fs";

const { cfg, credsFrom } = localConfig();

console.log("\x1b[1mCalendar sync\x1b[0m (force-refresh the local cache)");
console.log(`  account : ${cfg.userName}  (creds from ${credsFrom})`);

console.log("\n\x1b[36m▶ login\x1b[0m");
const session = await login(cfg);
console.log("  \x1b[32m✓\x1b[0m session established");

const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ fetch + write ${CACHE_KEY}\x1b[0m`);
const file = await syncCalendar(session, cfg, dateKey, fileStore);
console.log(`  \x1b[32m✓\x1b[0m cached ${file.months.join(" + ")} (${Object.keys(file.days).length} days) → ${CACHE_KEY}`);
console.log(`  generated ${file.generatedAt}`);
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `"scripts"` (after the `"locations"` line):
```json
    "calendar:sync": "tsx scripts/sync-calendar.ts"
```
(Ensure the preceding line keeps its trailing comma and the JSON stays valid.)

- [ ] **Step 5: Gitignore the cache file**

Append to `.gitignore`:
```
calendar-cache.json
```

- [ ] **Step 6: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (pre-existing suite + new `getMonthInfo` and `calendar-cache` tests).

- [ ] **Step 7: Live verification (manual — hits the real API)**

Pre-cache first (no punch):
Run: `npm run calendar:sync`
Expected: logs in, prints `cached 2026-07 + 2026-08 (N days)`, creates `calendar-cache.json`. Open the file: confirm `generatedAt`, `months`, and per-day entries with `label` lines are readable.

Then a cached, dry punch:
Run: `DRY_RUN=true npm run punch out`
Expected: the calendar line ends with `(cache)` (served from the file, no calendar fetch), `workday`/`shift` match the synced data, and the dry punch completes.

Confirm the cache file is untracked:
Run: `git status --porcelain --ignored calendar-cache.json`
Expected: shows `!! calendar-cache.json` (ignored, not tracked).

- [ ] **Step 8: Commit**

```bash
git add scripts/cache-fs.ts scripts/sync-calendar.ts scripts/punch-now.ts package.json .gitignore
git commit -m "feat(cache): file store, punch reads through cache, calendar:sync pre-cache command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs — README + api-facts

Document the new command and cache behavior, including the Worker-ready (deferred-KV) design so the intent is recorded.

**Files:**
- Modify: `README.md`
- Modify: `docs/api-facts.md`

- [ ] **Step 1: Update `README.md`**

In Setup, near the `npm run punch` mention (step 4), add:
```markdown
`npm run punch` reads your shift from a local `calendar-cache.json` instead of
hitting the calendar API every time. It auto-refreshes when the file is missing,
older than 7 days, or doesn't cover today (caching the current + next month).
Run `npm run calendar:sync` to pre-warm or force a refresh WITHOUT punching —
handy right after a schedule change. The file is gitignored (your personal
schedule) and human-readable — open it to verify your upcoming shifts.
```

In the `## Layout` section, extend the `scripts/` bullet:
```markdown
  `list-locations.ts` (pick your `PUNCHES_LOCATION_ID`), `sync-calendar.ts`
  (`npm run calendar:sync`), `cache-fs.ts` (file-backed cache store),
  `_env.ts` (shared `.dev.vars` + config bootstrap).
```

And add a line to the `src/` bullet:
```markdown
  `calendar-cache` (storage-agnostic shift cache used by the CLI; a future Worker
  could reuse it with a KV store),
```

- [ ] **Step 2: Update `docs/api-facts.md`**

Under `## Calendar / shift schedule — CONFIRMED`, add after the endpoint description:
```markdown
The CLI `punch` command reads this through a local `calendar-cache.json`
(current + next month, refreshed when missing / >7 days old / missing today) via
`src/calendar-cache.ts`, a storage-agnostic core (`getMonthInfo` is the shared
parser) whose only I/O is an injected `CacheStore` — the CLI injects a file store
(`scripts/cache-fs.ts`). The deployed Worker does NOT cache — it stays stateless
and reads live each fire. If a Worker cache is ever wanted, inject a KV-backed
`CacheStore` and refresh in `ctx.waitUntil` (non-blocking); no core changes.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/api-facts.md
git commit -m "docs: describe the punch calendar cache, calendar:sync, and Worker-ready design

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes on design decisions (for the implementer)

- **Storage-agnostic core in `src/` (Worker-ready, KV deferred):** the cache logic touches storage only through the injected `CacheStore`, and lives in `src/` with no `node:` import, so the deployed Worker could later reuse it by injecting a KV-backed store and refreshing in `ctx.waitUntil` (best-effort, non-blocking). Nothing wires KV now — the Worker is untouched and stays stateless.
- **`npm run calendar:sync` is the pre-cache command** — it warms/refreshes the file without punching (Task 4).
- **Why no live-`getDayInfo` fallback** (the spec mentioned one): every "cache problem" is already handled — missing/corrupt store → refresh; write failure → warn and use the in-memory fresh data. The only remaining failure is the refresh *fetch* itself throwing, and a live single-day read uses the very same `getMonthInfo`/network and fails identically. So a separate fallback adds an untestable network path with no behavioral benefit; a genuinely missing day throws the same clear error `getDayInfo` throws today.
- **Login is unchanged and still runs every punch** — this plan only removes the calendar round trip. The session-cookie cache is the separate fast-follow.
