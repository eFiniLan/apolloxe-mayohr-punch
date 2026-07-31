import { describe, it, expect, vi } from "vitest";
import { runScheduler, type Deps } from "../src/scheduler";
import { savePlan, type Plan } from "../src/plan";
import type { PunchOutcome } from "../src/punch";

const baseEnv = { MAYO_USERNAME: "e@x.com", MAYO_PASSWORD: "p" } as any;

// A Date whose Asia/Taipei wall-clock is hh:mm on 2026-07-24 (TW = UTC+8).
const tw = (hh: number, mm: number) => new Date(Date.UTC(2026, 6, 24, hh - 8, mm));
const DATEKEY = "2026-07-24";

const WORKDAY = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
// With rand=()=>0 and defaults (buffer 10, earlyIn.min 1, lateOut.min 1):
//   inTarget = 09:30 − max(10, 11) = 09:19 ;  outTarget = 18:30 + 1 = 18:31
const SUCCESS: PunchOutcome = { outcome: "success", attendanceHistoryId: "AH", punchDate: "09:20", locationName: "HQ" };

function memStore() {
  const m = new Map<string, string>();
  return { read: async (k: string) => m.get(k) ?? null, write: async (k: string, v: string) => void m.set(k, v), _m: m };
}

function deps(store: any, over: Partial<Deps> & { punchOutcome?: PunchOutcome; dayInfo?: any } = {}): Deps {
  return {
    acquireSession: over.acquireSession ?? (vi.fn(async () => ({ session: { cookie: "c" }, source: "fresh" })) as any),
    getDay: over.getDay ?? (vi.fn(async () => ({ info: over.dayInfo ?? WORKDAY })) as any),
    punch: (over.punch as any) ?? (vi.fn(async () => over.punchOutcome ?? SUCCESS) as any),
    store,
    rand: () => 0,
    now: over.now ?? tw(9, 20),
  };
}

describe("runScheduler — plan-driven", () => {
  it("throws when no KV store is bound", async () => {
    await expect(runScheduler(baseEnv, { now: tw(9, 20) })).rejects.toThrow(/APOLLO_KV is required/);
  });

  it("non-workday → builds a workday:false plan, never punches, logs the reason", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = memStore();
    const d = deps(store, { dayInfo: { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null } });
    await runScheduler(baseEnv, d);
    expect(d.punch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not a workday/));
    expect(JSON.parse(store._m.get(`plan:${DATEKEY}`)!).workday).toBe(false);
    log.mockRestore();
  });

  it("full-day leave skipped only when RESPECT_LEAVE=true", async () => {
    const d1 = deps(memStore(), { dayInfo: { ...WORKDAY, onLeave: true } });
    await runScheduler({ ...baseEnv, RESPECT_LEAVE: "true" }, d1);
    expect(d1.punch).not.toHaveBeenCalled();

    const d2 = deps(memStore(), { dayInfo: { ...WORKDAY, onLeave: true } }); // default: still punch
    await runScheduler(baseEnv, d2);
    expect(d2.punch).toHaveBeenCalledOnce();
  });

  it("throws when a workday is missing its shift time", async () => {
    const d = deps(memStore(), { dayInfo: { ...WORKDAY, shiftStart: null } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/no scheduled shift/);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("before the clock-in target → waits, no punch", async () => {
    const d = deps(memStore(), { now: tw(9, 10) }); // 09:10 < inTarget 09:19
    await runScheduler(baseEnv, d);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("at/after the clock-in target → clocks in and marks inDone", async () => {
    const store = memStore();
    const d = deps(store, { now: tw(9, 20) });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
    expect(JSON.parse(store._m.get(`plan:${DATEKEY}`)!).inDone).toBe(true);
  });

  it("evening → clocks out (direction from the plan, not noon)", async () => {
    const d = deps(memStore(), { now: tw(18, 40) });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "out");
  });

  it("already_done and cooldown resolve without throwing", async () => {
    for (const outcome of [{ outcome: "already_done", detail: "x" }, { outcome: "cooldown", detail: "wait" }] as PunchOutcome[]) {
      const d = deps(memStore(), { now: tw(9, 20), punchOutcome: outcome });
      await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    }
  });

  it("a genuine punch failure throws (with the verbose detail)", async () => {
    const d = deps(memStore(), { now: tw(9, 20), punchOutcome: { outcome: "failure", detail: "boom" } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/boom/);
  });

  it("done-flag prevents a second clock-in later the same day, and reuses the plan", async () => {
    const store = memStore();
    await runScheduler(baseEnv, deps(store, { now: tw(9, 20) })); // clocks in
    const second = deps(store, { now: tw(12, 0) }); // mid-day, plan says inDone
    await runScheduler(baseEnv, second);
    expect(second.punch).not.toHaveBeenCalled();
    expect(second.getDay).not.toHaveBeenCalled(); // plan reused, no calendar re-read
  });

  it("a waiting fire with an existing plan never logs in or reads the calendar", async () => {
    const store = memStore();
    const seeded: Plan = { workday: true, shift: "09:30-18:30", inTarget: "09:19", outTarget: "18:31", inDone: false, outDone: false };
    await savePlan(store, DATEKEY, seeded);
    const d = deps(store, { now: tw(9, 10) }); // before inTarget
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).not.toHaveBeenCalled();
    expect(d.getDay).not.toHaveBeenCalled();
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("forwards the KV store to acquireSession and getDay when building + punching", async () => {
    const store = memStore();
    const d = deps(store, { now: tw(9, 20) });
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).toHaveBeenCalledWith(expect.anything(), store);
    expect(d.getDay).toHaveBeenCalledWith(expect.anything(), expect.anything(), store, DATEKEY);
  });
});
