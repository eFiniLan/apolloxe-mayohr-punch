import { describe, it, expect, vi } from "vitest";
import {
  dayLabel, infoToCacheDay, cacheDayToInfo, isFresh,
  targetMonths, monthLabel, buildCache, cachedDayInfo, syncCalendar, CACHE_KEY,
  type CacheFile, type CacheOpts, type CacheStore,
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
  it("is not fresh (does not throw) when days is missing/wrong shape", () => {
    expect(isFresh({ generatedAt: "2026-07-27T09:00:00Z" } as any, "2026-07-27", now)).toBe(false);
    expect(isFresh({ generatedAt: "2026-07-27T09:00:00Z", days: null } as any, "2026-07-27", now)).toBe(false);
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

  it("treats a valid-JSON wrong-shape cache file as absent and refreshes (no throw)", async () => {
    const store = memStore("{}");
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
