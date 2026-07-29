import { describe, it, expect, vi } from "vitest";
import { runScheduler, type Deps } from "../src/scheduler";
import type { PunchOutcome } from "../src/punch";

// Config the loader requires (notify secrets unused by most tests).
const baseEnv = {
  MAYO_USERNAME: "e@x.com",
  MAYO_PASSWORD: "p",
  RESEND_API_KEY: "re",
  NOTIFY_TO: "to@x.com",
  NOTIFY_FROM: "fr@x.com",
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
    notify: vi.fn(async () => {}) as any,
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
    expect(d.notify).not.toHaveBeenCalled();
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

  it("emails (not silently skips) when a workday is missing its shift time", async () => {
    const d = deps({ dayInfo: { isWorkday: true, onLeave: false, shiftStart: null, shiftEnd: "18:30" } });
    await runScheduler(baseEnv, d);
    expect(d.punch).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "failure" }));
  });

  it("does not punch before the target time", async () => {
    const d = deps({ now: tw(9, 10) }); // before 09:19
    await runScheduler(baseEnv, d);
    expect(d.getDay).toHaveBeenCalledOnce();
    expect(d.punch).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("clocks in past the target and emails success", async () => {
    const d = deps({ now: tw(9, 20) });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
    expect(d.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "success" }));
  });

  it("stays quiet on already_done", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "already_done", detail: "exists" } });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledOnce();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("stays quiet on cooldown (a punch just happened)", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "cooldown", detail: "wait 8 minutes" } });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledOnce();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("emails a failure on a genuine failure", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "failure", detail: "boom" } });
    await runScheduler(baseEnv, d);
    expect(d.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "failure" }));
  });

  it("clocks OUT in the evening (direction from time of day)", async () => {
    const d = deps({ now: tw(18, 40) }); // past targetOut 18:31
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "out");
  });

  it("emails a failure and rethrows when acquiring the session throws", async () => {
    const acquireSession = vi.fn(async () => { throw new Error("login down"); });
    const d = deps({ now: tw(9, 20), acquireSession: acquireSession as any });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow("login down");
    expect(d.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "failure" }));
  });

  it("forwards the store to acquireSession and getDay", async () => {
    const store = { read: vi.fn(), write: vi.fn() } as any;
    const d = deps({ now: tw(9, 20), store });
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).toHaveBeenCalledWith(expect.anything(), store);
    expect(d.getDay).toHaveBeenCalledWith(expect.anything(), expect.anything(), store, expect.anything());
  });
});
