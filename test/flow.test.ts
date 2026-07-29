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
