# Calendar Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run punch` skip the ~350ms live calendar read by serving the workday guard and shift times from a local, human-readable `calendar-cache.json`, auto-refreshed when stale.

**Architecture:** Extract a month-level `getMonthInfo` from `src/calendar.ts` (the single source of truth for calendar parsing). Add a CLI-only `scripts/calendar-cache.ts` that reads/writes the JSON file with all impure boundaries (file I/O, clock, month fetch) injected — so it unit-tests in the Workers pool without touching `node:fs`. `scripts/punch-now.ts` reads through the cache; a new `scripts/sync-calendar.ts` (`npm run calendar:sync`) forces a refresh.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), `tsx` for CLI scripts, Node `fs/promises` (CLI only, via lazy dynamic import).

## Global Constraints

- **CLI-only.** The cache lives in `scripts/` and is used only by `scripts/punch-now.ts` / `scripts/sync-calendar.ts`. The deployed Worker (`src/index.ts`, `src/scheduler.ts`) is unchanged and stays stateless.
- **Tests run in the Workers pool (miniflare).** No test file, nor any module it imports at top level, may statically import `node:fs`. The cache module's real file I/O must be reached only via lazy `await import("node:fs/promises")` inside a default that tests never invoke (they inject fakes).
- **Impure-boundary injection convention:** every side effect (file read/write, `now`, month fetch) is an injectable parameter with a real default, exactly like `fetchImpl = fetch` and `rand = Math.random` elsewhere.
- **`src/` stays the only calendar parser.** The cache reuses `getMonthInfo`; it must not re-derive `DayInfo`.
- **Field contract in the JSON:** the program reads only `workday`, `onLeave`, `shiftStart`, `shiftEnd` (per day) and `generatedAt` (ISO-8601). `label`, `timezone`, `months` are human-only and never parsed back.
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extract `getMonthInfo` from `src/calendar.ts`

Pure refactor: expose a month-level parser and make `getDayInfo` a thin wrapper over it. External behavior of `getDayInfo` is unchanged, so its existing tests must stay green.

**Files:**
- Modify: `src/calendar.ts`
- Test: `test/calendar.test.ts` (add cases; keep existing ones passing)

**Interfaces:**
- Consumes: existing `DayInfo`, `CALENDAR_URL`, `REFERER_URL`, `toLocalHHMM`, `coversWholeShift`, `CalendarDay`, `CalendarResponse` in `src/calendar.ts`.
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

### Task 2: Pure cache helpers in `scripts/calendar-cache.ts`

The data model and all pure functions — no I/O, no orchestration. Fully deterministic and testable.

**Files:**
- Create: `scripts/calendar-cache.ts`
- Test: `test/calendar-cache.test.ts`

**Interfaces:**
- Consumes: `DayInfo` and `getMonthInfo` from `../src/calendar`; `Config` from `../src/config`; `Session` from `../src/auth`.
- Produces:
  ```ts
  export const CACHE_PATH = "calendar-cache.json";
  export interface CacheDay { workday: boolean; onLeave: boolean; shiftStart: string | null; shiftEnd: string | null; label: string; }
  export interface CacheFile { generatedAt: string; timezone: string; months: string[]; days: Record<string, CacheDay>; }
  export interface CacheDeps {
    readCache: (path: string) => Promise<string | null>;
    writeCache: (path: string, contents: string) => Promise<void>;
    now: () => Date;
    getMonthInfo: typeof getMonthInfo;
  }
  export function dayLabel(dateKey: string, info: DayInfo): string
  export function infoToCacheDay(dateKey: string, info: DayInfo): CacheDay
  export function cacheDayToInfo(d: CacheDay): DayInfo
  export function isFresh(file: CacheFile, dateKey: string, now: Date): boolean
  export function targetMonths(dateKey: string): Array<{ year: number; month: number }>
  export function monthLabel(year: number, month: number): string
  export async function buildCache(session: Session, cfg: Config, dateKey: string, deps: CacheDeps): Promise<CacheFile>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/calendar-cache.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  dayLabel, infoToCacheDay, cacheDayToInfo, isFresh,
  targetMonths, monthLabel, buildCache,
  type CacheFile, type CacheDeps,
} from "../scripts/calendar-cache";
import type { DayInfo } from "../src/calendar";

const WORK: DayInfo = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const OFF: DayInfo = { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null };
const cfg: any = { timezone: "Asia/Taipei" };
const session: any = { cookie: "c" };

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const deps: CacheDeps = {
      readCache: async () => null,
      writeCache: async () => {},
      now: () => new Date("2026-07-27T12:00:00Z"),
      getMonthInfo: getMonthInfo as any,
    };

    const file = await buildCache(session, cfg, "2026-07-27", deps);

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
Expected: FAIL — cannot resolve `../scripts/calendar-cache`.

- [ ] **Step 3: Create `scripts/calendar-cache.ts` (pure parts only)**

```ts
// CLI-only calendar cache. Impure boundaries (file I/O, clock, month fetch) are
// injected (CacheDeps) so this whole module unit-tests in the Workers pool
// without touching node:fs. Real fs is reached only via lazy dynamic import in
// the default deps (see Task 3), which tests never invoke.
import type { DayInfo } from "../src/calendar";
import { getMonthInfo } from "../src/calendar";
import type { Config } from "../src/config";
import type { Session } from "../src/auth";

export const CACHE_PATH = "calendar-cache.json";
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

export interface CacheDeps {
  readCache: (path: string) => Promise<string | null>; // null when absent
  writeCache: (path: string, contents: string) => Promise<void>;
  now: () => Date;
  getMonthInfo: typeof getMonthInfo;
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
  deps: CacheDeps,
): Promise<CacheFile> {
  const months = targetMonths(dateKey);
  const days: Record<string, CacheDay> = {};
  for (const { year, month } of months) {
    const monthInfo = await deps.getMonthInfo(session, cfg, year, month);
    for (const [dk, info] of Object.entries(monthInfo)) {
      days[dk] = infoToCacheDay(dk, info);
    }
  }
  return {
    generatedAt: deps.now().toISOString(),
    timezone: cfg.timezone,
    months: months.map(({ year, month }) => monthLabel(year, month)),
    days,
  };
}
```

Note: `generatedAt` is stored as UTC ISO (`toISOString()`) rather than the spec's local-offset example — it is unambiguous, parseable for the staleness check, and avoids hand-rolling a timezone offset. Local context is still visible via each day's `label` and the top-level `timezone`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/calendar-cache.test.ts`
Expected: PASS (all `dayLabel` / round-trip / `targetMonths` / `isFresh` / `buildCache` cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/calendar-cache.ts test/calendar-cache.test.ts
git commit -m "feat(cache): pure calendar-cache helpers (model, staleness, build)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Orchestration — `cachedDayInfo`, `syncCalendar`, and default fs deps

Adds the read-or-refresh entrypoint and the manual-sync entrypoint, plus the lazy-`fs` default deps. Write failures are non-fatal (never block a punch); a successful refresh with today genuinely absent throws the same clear error as `getDayInfo` does today.

**Files:**
- Modify: `scripts/calendar-cache.ts`
- Test: `test/calendar-cache.test.ts` (add cases)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  ```ts
  export async function cachedDayInfo(
    session: Session, cfg: Config, dateKey: string, deps?: Partial<CacheDeps>,
  ): Promise<{ info: DayInfo; source: "cache" | "fresh" }>
  export async function syncCalendar(
    session: Session, cfg: Config, dateKey: string, deps?: Partial<CacheDeps>,
  ): Promise<CacheFile>
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/calendar-cache.test.ts`:

```ts
import { cachedDayInfo, syncCalendar, CACHE_PATH } from "../scripts/calendar-cache";

function freshFileJson(now = "2026-07-27T12:00:00Z"): string {
  return JSON.stringify({
    generatedAt: now,
    timezone: "Asia/Taipei",
    months: ["2026-07", "2026-08"],
    days: { "2026-07-27": { workday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30", label: "x" } },
  });
}

function makeDeps(over: Partial<CacheDeps> = {}): CacheDeps {
  return {
    readCache: async () => null,
    writeCache: async () => {},
    now: () => new Date("2026-07-27T12:00:00Z"),
    getMonthInfo: vi.fn(async (_s: any, _c: any, _y: number, m: number) =>
      m === 7 ? { "2026-07-27": WORK } : { "2026-08-01": OFF }) as any,
    ...over,
  };
}

describe("cachedDayInfo", () => {
  it("returns the cached day without fetching when fresh", async () => {
    const getMonthInfo = vi.fn();
    const deps = makeDeps({ readCache: async () => freshFileJson(), getMonthInfo: getMonthInfo as any });
    const r = await cachedDayInfo(session, cfg, "2026-07-27", deps);
    expect(r).toEqual({ info: WORK, source: "cache" });
    expect(getMonthInfo).not.toHaveBeenCalled();
  });

  it("refreshes and writes when the file is missing", async () => {
    const writeCache = vi.fn(async () => {});
    const deps = makeDeps({ readCache: async () => null, writeCache });
    const r = await cachedDayInfo(session, cfg, "2026-07-27", deps);
    expect(r.source).toBe("fresh");
    expect(r.info).toEqual(WORK);
    expect(writeCache).toHaveBeenCalledTimes(1);
    const [path, contents] = writeCache.mock.calls[0];
    expect(path).toBe(CACHE_PATH);
    expect(contents).toContain('"2026-07-27"');
    expect(contents.endsWith("\n")).toBe(true); // pretty-printed + trailing newline
  });

  it("refreshes when the cached file is stale (>7d)", async () => {
    const deps = makeDeps({ readCache: async () => freshFileJson("2026-07-01T12:00:00Z") });
    const r = await cachedDayInfo(session, cfg, "2026-07-27", deps);
    expect(r.source).toBe("fresh");
  });

  it("treats a corrupt cache file as absent and refreshes (no throw)", async () => {
    const deps = makeDeps({ readCache: async () => "{ not json" });
    const r = await cachedDayInfo(session, cfg, "2026-07-27", deps);
    expect(r.source).toBe("fresh");
    expect(r.info).toEqual(WORK);
  });

  it("does not fail the punch if writing the cache throws", async () => {
    const deps = makeDeps({ writeCache: async () => { throw new Error("EACCES"); } });
    const r = await cachedDayInfo(session, cfg, "2026-07-27", deps);
    expect(r).toEqual({ info: WORK, source: "fresh" });
  });

  it("throws a clear error when the day is genuinely absent after refresh", async () => {
    const deps = makeDeps({ getMonthInfo: (async () => ({})) as any });
    await expect(cachedDayInfo(session, cfg, "2026-07-27", deps)).rejects.toThrow(/2026-07-27/);
  });
});

describe("syncCalendar", () => {
  it("always builds and writes, returning the file", async () => {
    const writeCache = vi.fn(async () => {});
    const deps = makeDeps({ readCache: async () => freshFileJson(), writeCache });
    const file = await syncCalendar(session, cfg, "2026-07-27", deps);
    expect(writeCache).toHaveBeenCalledTimes(1); // ignores the fresh cache; forces a refresh
    expect(file.months).toEqual(["2026-07", "2026-08"]);
    expect(Object.keys(file.days)).toContain("2026-07-27");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/calendar-cache.test.ts -t "cachedDayInfo"`
Expected: FAIL — `cachedDayInfo is not a function`.

- [ ] **Step 3: Add orchestration + default deps to `scripts/calendar-cache.ts`**

Append to `scripts/calendar-cache.ts`:

```ts
// --- default (real) deps: fs reached lazily so importing this module never
// pulls in node:fs (keeps it Workers-pool-safe; tests inject fakes) ----------
async function defaultReadCache(path: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    return null; // absent → treat as no cache
  }
}

async function defaultWriteCache(path: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, contents, "utf8");
}

function resolveDeps(deps: Partial<CacheDeps>): CacheDeps {
  return {
    readCache: deps.readCache ?? defaultReadCache,
    writeCache: deps.writeCache ?? defaultWriteCache,
    now: deps.now ?? (() => new Date()),
    getMonthInfo: deps.getMonthInfo ?? getMonthInfo,
  };
}

function serialize(file: CacheFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Read today's DayInfo from the cache, refreshing (fetch current + next month,
 * rewrite the file) when the cache is missing, corrupt, stale (>7d), or lacks
 * today. A failed write is logged but non-fatal — a cache problem must never
 * block a punch.
 */
export async function cachedDayInfo(
  session: Session,
  cfg: Config,
  dateKey: string,
  deps: Partial<CacheDeps> = {},
): Promise<{ info: DayInfo; source: "cache" | "fresh" }> {
  const d = resolveDeps(deps);

  let cached: CacheFile | null = null;
  try {
    const raw = await d.readCache(CACHE_PATH);
    if (raw) cached = JSON.parse(raw) as CacheFile;
  } catch {
    cached = null; // unreadable or corrupt → refresh
  }
  if (cached && isFresh(cached, dateKey, d.now())) {
    return { info: cacheDayToInfo(cached.days[dateKey]), source: "cache" };
  }

  const file = await buildCache(session, cfg, dateKey, d);
  try {
    await d.writeCache(CACHE_PATH, serialize(file));
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
  deps: Partial<CacheDeps> = {},
): Promise<CacheFile> {
  const d = resolveDeps(deps);
  const file = await buildCache(session, cfg, dateKey, d);
  await d.writeCache(CACHE_PATH, serialize(file));
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
git add scripts/calendar-cache.ts test/calendar-cache.test.ts
git commit -m "feat(cache): cachedDayInfo + syncCalendar with lazy-fs defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire the CLI — `punch-now`, `sync-calendar`, `package.json`, `.gitignore`

Entrypoints (no unit tests; verified by typecheck and a live dry run). `punch-now` reads through the cache; a new command force-syncs; the cache file is gitignored.

**Files:**
- Modify: `scripts/punch-now.ts`
- Create: `scripts/sync-calendar.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `cachedDayInfo`, `syncCalendar`, `CACHE_PATH` from `./calendar-cache`; `login` from `../src/auth`; `nowParts` from `../src/time`; `localConfig` from `./_env`.

- [ ] **Step 1: Swap `punch-now.ts` to read through the cache**

In `scripts/punch-now.ts`, change the calendar import and the read block.

Replace `import { getDayInfo } from "../src/calendar";` with:
```ts
import { cachedDayInfo } from "./calendar-cache";
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
const { info, source } = await cachedDayInfo(session, cfg, dateKey);
console.log(`  workday=${info.isWorkday}  shift=${info.shiftStart ?? "--"}–${info.shiftEnd ?? "--"}  onLeave=${info.onLeave}  \x1b[2m(${source})\x1b[0m`);
```

- [ ] **Step 2: Create `scripts/sync-calendar.ts`**

```ts
// Force-refresh the local calendar cache (calendar-cache.json). Reuses the same
// login + getMonthInfo the punch command uses, so it can't drift.
//
//   npm run calendar:sync
//
// Credentials: .dev.vars (or MAYO_USERNAME / MAYO_PASSWORD env vars).
import { login } from "../src/auth";
import { nowParts } from "../src/time";
import { localConfig } from "./_env";
import { syncCalendar, CACHE_PATH } from "./calendar-cache";

const { cfg, credsFrom } = localConfig();

console.log("\x1b[1mCalendar sync\x1b[0m (force-refresh the local cache)");
console.log(`  account : ${cfg.userName}  (creds from ${credsFrom})`);

console.log("\n\x1b[36m▶ login\x1b[0m");
const session = await login(cfg);
console.log("  \x1b[32m✓\x1b[0m session established");

const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ fetch + write ${CACHE_PATH}\x1b[0m`);
const file = await syncCalendar(session, cfg, dateKey);
console.log(`  \x1b[32m✓\x1b[0m cached ${file.months.join(" + ")} (${Object.keys(file.days).length} days) → ${CACHE_PATH}`);
console.log(`  generated ${file.generatedAt}`);
```

- [ ] **Step 3: Add the npm script**

In `package.json`, add to `"scripts"` (after the `"locations"` line):
```json
    "calendar:sync": "tsx scripts/sync-calendar.ts"
```
(Ensure the preceding line keeps its trailing comma and valid JSON.)

- [ ] **Step 4: Gitignore the cache file**

Append to `.gitignore`:
```
calendar-cache.json
```

- [ ] **Step 5: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (the pre-existing suite plus the new `getMonthInfo` and `calendar-cache` tests).

- [ ] **Step 6: Live verification (manual, DRY — hits the real API)**

Run: `npm run calendar:sync`
Expected: logs in, prints `cached 2026-07 + 2026-08 (N days)`, and creates `calendar-cache.json`. Open the file and confirm it's readable: `generatedAt`, `months`, and per-day entries with `label` lines.

Run: `DRY_RUN=true npm run punch out`
Expected: on this second run the calendar line ends with `(cache)` (served from the file, no calendar fetch), `workday`/`shift` match the synced data, and the dry punch completes.

Confirm the cache file is untracked:
Run: `git status --porcelain calendar-cache.json`
Expected: shows `!!` under `--ignored`, or nothing under a normal `git status` (i.e. not staged/tracked).

- [ ] **Step 7: Commit**

```bash
git add scripts/punch-now.ts scripts/sync-calendar.ts package.json .gitignore
git commit -m "feat(cache): punch reads through cache; add calendar:sync command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs — README + api-facts

Document the new command and the cache behavior so the setup instructions stay accurate.

**Files:**
- Modify: `README.md`
- Modify: `docs/api-facts.md`

- [ ] **Step 1: Update `README.md`**

In the `## Configuration` prose or the CLI section, add a short paragraph (place it near the `npm run punch` mention in Setup step 4):
```markdown
`npm run punch` reads your shift from a local `calendar-cache.json` instead of
hitting the calendar API every time. It auto-refreshes when the file is missing,
older than 7 days, or doesn't cover today (caching the current + next month).
Run `npm run calendar:sync` to force a refresh right after a schedule change.
The file is gitignored (it's your personal schedule) and human-readable — open
it to verify your upcoming shifts.
```

In the `## Layout` section, extend the `scripts/` bullet to mention the new files:
```markdown
  `list-locations.ts` (pick your `PUNCHES_LOCATION_ID`),
  `calendar-cache.ts` (local shift cache for `punch`), `sync-calendar.ts`
  (`npm run calendar:sync`), `_env.ts` (shared `.dev.vars` + config bootstrap).
```

- [ ] **Step 2: Update `docs/api-facts.md`**

Under the `## Calendar / shift schedule — CONFIRMED` section, add a note after the endpoint description:
```markdown
The CLI `punch` command reads this through a local `calendar-cache.json`
(current + next month, refreshed when missing / >7 days old / missing today) via
`scripts/calendar-cache.ts`; `src/calendar.ts getMonthInfo` is the shared parser.
The deployed Worker does NOT cache — it stays stateless and reads live each fire.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/api-facts.md
git commit -m "docs: describe the punch calendar cache and calendar:sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes on design decisions (for the implementer)

- **Why no live-`getDayInfo` fallback** (the spec mentioned one): every "cache problem" is already handled without it — missing/corrupt file → refresh; write failure → warn and use the in-memory fresh data. The only remaining failure is the refresh *fetch* itself throwing, and a live single-day read would use the very same `getMonthInfo`/network and fail identically. So a separate fallback adds an untestable network path with no behavioral benefit; a genuinely missing day throws the same clear error `getDayInfo` throws today.
- **Why `getMonthInfo` and not caching inside `src/calendar.ts`:** the Worker (which imports `src/`) must stay stateless and filesystem-free. Caching is a `scripts/`-only concern layered *on top of* the shared parser.
- **Login is unchanged and still runs every punch** — this plan only removes the calendar round trip. The session-cookie cache is the separate fast-follow.
- **If the Workers-pool bundler chokes on the lazy `import("node:fs/promises")`** in Task 3 (it should not — a `node:`-prefixed dynamic import is normally externalized, and the tests never execute it because they inject fakes): move `defaultReadCache`/`defaultWriteCache` into a new `scripts/cache-fs.ts` that does a static `import { readFile, writeFile } from "node:fs/promises"`, export a `fsCacheDeps` from it, and have the two CLI entrypoints (`punch-now.ts`, `sync-calendar.ts`) pass it in explicitly (`cachedDayInfo(session, cfg, dateKey, fsCacheDeps)`). `calendar-cache.ts` then references no `node:` module at all. Keep `resolveDeps` defaults for `now`/`getMonthInfo` as-is. Verify the change with `npm test` (must stay green — no test imports `cache-fs.ts`).
