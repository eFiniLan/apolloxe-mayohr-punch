import { describe, it, expect, vi } from "vitest";
import { runScheduler, type Deps } from "../src/scheduler";
import type { PunchOutcome } from "../src/punch";

// Config the loader requires.
const baseEnv = {
  MAYO_USERNAME: "e@x.com",
  MAYO_PASSWORD: "p",
} as any;

// A Date whose Asia/Taipei wall-clock is hh:mm on 2026-07-24 (TW = UTC+8).
const tw = (hh: number, mm: number) => new Date(Date.UTC(2026, 6, 24, hh - 8, mm));

const WORKDAY = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
// With rand=()=>0 and defaults (reactionBufferMin 10, earlyIn.min 1, lateOut.min 1):
//   targetIn  = 09:30 − (10 + 1) = 09:19 ;  targetOut = 18:30 + 1 = 18:31

function deps(over: Partial<Deps> & { punchOutcome?: PunchOutcome; dayInfo?: any } = {}): Deps {
  const punchOutcome: PunchOutcome =
    over.punchOutcome ?? { outcome: "success", attendanceHistoryId: "AH", punchDate: "09:20", locationName: "HQ" };
  return {
    acquireSession: over.acquireSession ?? (vi.fn(async () => ({ session: { cookie: "c" }, source: "fresh" })) as any),
    getDay: vi.fn(async () => ({ info: over.dayInfo ?? WORKDAY })) as any,
    punch: vi.fn(async () => punchOutcome) as any,
    store: over.store,
    rand: () => 0,
    now: over.now ?? tw(9, 20),
  };
}

describe("runScheduler (stateless)", () => {
  it("does nothing on a non-workday", async () => {
    const d = deps({ dayInfo: { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null } });
    await runScheduler(baseEnv, d);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("skips full-day leave when RESPECT_LEAVE=true", async () => {
    const d = deps({ dayInfo: { ...WORKDAY, onLeave: true } });
    await runScheduler({ ...baseEnv, RESPECT_LEAVE: "true" }, d);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("still punches on a leave day when RESPECT_LEAVE=false (default)", async () => {
    const d = deps({ dayInfo: { ...WORKDAY, onLeave: true } });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("throws (fails the run) when a workday is missing its shift time", async () => {
    const d = deps({ dayInfo: { isWorkday: true, onLeave: false, shiftStart: null, shiftEnd: "18:30" } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/no scheduled/);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("does not punch before the target time", async () => {
    const d = deps({ now: tw(9, 10) });
    await runScheduler(baseEnv, d);
    expect(d.getDay).toHaveBeenCalledOnce();
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("clocks in past the target (resolves, no throw)", async () => {
    const d = deps({ now: tw(9, 20) });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
  });

  it("stays quiet (no throw) on already_done", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "already_done", detail: "exists" } });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("stays quiet (no throw) on cooldown", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "cooldown", detail: "wait 8 minutes" } });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("throws on a genuine failure", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "failure", detail: "boom" } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/boom/);
  });

  it("clocks OUT in the evening (direction from time of day)", async () => {
    const d = deps({ now: tw(18, 40) });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "out");
  });

  it("rethrows when acquiring the session throws", async () => {
    const acquireSession = vi.fn(async () => { throw new Error("login down"); });
    const d = deps({ now: tw(9, 20), acquireSession: acquireSession as any });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow("login down");
  });

  it("forwards the store to acquireSession and getDay", async () => {
    const store = { read: vi.fn(), write: vi.fn() } as any;
    const d = deps({ now: tw(9, 20), store });
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).toHaveBeenCalledWith(expect.anything(), store);
    expect(d.getDay).toHaveBeenCalledWith(expect.anything(), expect.anything(), store, expect.anything());
  });
});
