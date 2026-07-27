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
