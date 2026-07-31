import { describe, it, expect, vi } from "vitest";
import { runTick } from "../src/punch-day";
import type { PunchOutcome } from "../src/punch";

const baseEnv = { MAYO_USERNAME: "e@x.com", MAYO_PASSWORD: "p" } as any;
const WORKDAY = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const SUCCESS: PunchOutcome = { outcome: "success", attendanceHistoryId: "AH", punchDate: "x", locationName: "HQ" };
const DATEKEY = "2026-07-24";
const tw = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 6, 24, hh - 8, mm, ss);
// rand=0 targets: in 09:19:00, out 18:31:00 (TW). Tomorrow's backstop = 07-25 00:05 TW.
const IN_AT = tw(9, 19, 0);
const OUT_AT = tw(18, 31, 0);
const TOMORROW = Date.UTC(2026, 6, 24, 16, 5, 0); // 2026-07-25 00:05 Taipei

function fakeStorage() {
  const m = new Map<string, unknown>();
  const s = { alarm: null as number | null };
  return {
    get: async <T = unknown>(k: string): Promise<T | undefined> => m.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void m.set(k, v),
    setAlarm: async (t: number) => void (s.alarm = t),
    _m: m,
    _s: s,
  };
}

function deps(over: any = {}) {
  return {
    acquireSession: over.acquireSession ?? vi.fn(async () => ({ session: { cookie: "c" }, source: "fresh" })),
    getDay: over.getDay ?? vi.fn(async () => ({ info: over.dayInfo ?? WORKDAY })),
    peekDay: over.peekDay ?? vi.fn(async () => null), // default: cache miss → getDay
    punch: over.punch ?? vi.fn(async () => over.outcome ?? SUCCESS),
    rand: () => 0,
    now: over.now,
  };
}
const plan = (store: ReturnType<typeof fakeStorage>) => store._m.get("day-plan") as any;

describe("runTick — alarm machine", () => {
  it("before inAt: builds the plan, arms the alarm at inAt, no punch", async () => {
    const store = fakeStorage();
    const d = deps({ now: tw(9, 10) });
    await runTick(baseEnv, store, d as any);
    expect(d.punch).not.toHaveBeenCalled();
    expect(store._s.alarm).toBe(IN_AT);
    expect(plan(store).dateKey).toBe(DATEKEY);
  });

  it("at inAt: clocks in, marks inDone, arms outAt", async () => {
    const store = fakeStorage();
    const d = deps({ now: tw(9, 20) });
    await runTick(baseEnv, store, d as any);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
    expect(plan(store).inDone).toBe(true);
    expect(store._s.alarm).toBe(OUT_AT);
  });

  it("reuses the stored plan; mid-day does nothing and re-arms outAt", async () => {
    const store = fakeStorage();
    await runTick(baseEnv, store, deps({ now: tw(9, 20) }) as any); // clock in
    const d2 = deps({ now: tw(12, 0) });
    await runTick(baseEnv, store, d2 as any);
    expect(d2.getDay).not.toHaveBeenCalled(); // plan reused, no calendar re-read
    expect(d2.punch).not.toHaveBeenCalled();
    expect(store._s.alarm).toBe(OUT_AT);
  });

  it("evening: clocks out and arms tomorrow's plan time", async () => {
    const store = fakeStorage();
    await runTick(baseEnv, store, deps({ now: tw(9, 20) }) as any); // in
    const d2 = deps({ now: tw(18, 40) });
    await runTick(baseEnv, store, d2 as any);
    expect(d2.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "out");
    expect(plan(store).outDone).toBe(true);
    expect(store._s.alarm).toBe(TOMORROW);
  });

  it("non-workday: no punch, arms tomorrow", async () => {
    const store = fakeStorage();
    const d = deps({ now: tw(9, 20), dayInfo: { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null } });
    await runTick(baseEnv, store, d as any);
    expect(d.punch).not.toHaveBeenCalled();
    expect(plan(store).workday).toBe(false);
    expect(store._s.alarm).toBe(TOMORROW);
  });

  it("a failed punch throws (fails the alarm → retried)", async () => {
    const store = fakeStorage();
    const d = deps({ now: tw(9, 20), outcome: { outcome: "failure", detail: "boom" } });
    await expect(runTick(baseEnv, store, d as any)).rejects.toThrow(/boom/);
  });

  it("warm calendar cache → builds the plan without logging in", async () => {
    const store = fakeStorage();
    const d = deps({ now: tw(9, 10), peekDay: vi.fn(async () => WORKDAY) });
    await runTick(baseEnv, store, d as any);
    expect(d.getDay).not.toHaveBeenCalled();
    expect(d.acquireSession).not.toHaveBeenCalled();
    expect(d.punch).not.toHaveBeenCalled();
    expect(store._s.alarm).toBe(IN_AT);
  });

  it("catch-up after an outage: clocks in first and re-arms almost immediately", async () => {
    const store = fakeStorage();
    const now = tw(20, 0); // past both targets, nothing done
    const d = deps({ now });
    await runTick(baseEnv, store, d as any);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
    expect(store._s.alarm).toBe(now + 1000); // outAt is in the past → clamped to now+1s
  });
});
