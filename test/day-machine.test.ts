import { describe, it, expect } from "vitest";
import { buildDayPlan, dueAction, nextAlarm, type DayPlan } from "../src/day-machine";

const cfg: any = {
  timezone: "Asia/Taipei",
  reactionBufferMin: 10,
  earlyIn: { min: 1, max: 15 },
  lateOut: { min: 1, max: 15 },
  respectLeave: false,
};
const WORKDAY = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const DATEKEY = "2026-07-24";
// Taipei wall-clock → epoch ms (TW = UTC+8).
const tw = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 6, 24, hh - 8, mm, ss);

describe("buildDayPlan", () => {
  it("non-workday → skip record, no targets", () => {
    const p = buildDayPlan(DATEKEY, { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null }, cfg);
    expect(p).toEqual({ dateKey: DATEKEY, workday: false, skipReason: "not a workday", inAt: null, outAt: null, inDone: false, outDone: false });
  });

  it("full-day leave → skip only when RESPECT_LEAVE", () => {
    const leave = { ...WORKDAY, onLeave: true };
    expect(buildDayPlan(DATEKEY, leave, { ...cfg, respectLeave: true }).skipReason).toBe("on approved leave");
    expect(buildDayPlan(DATEKEY, leave, cfg).workday).toBe(true);
  });

  it("workday missing a shift boundary → throws", () => {
    expect(() => buildDayPlan(DATEKEY, { ...WORKDAY, shiftStart: null }, cfg)).toThrow(/no scheduled shift/);
    expect(() => buildDayPlan(DATEKEY, { ...WORKDAY, shiftEnd: null }, cfg)).toThrow(/no scheduled shift/);
  });

  it("workday, rand=0 → in 11 min before start, out 1 min after end (exact epochs)", () => {
    const p = buildDayPlan(DATEKEY, WORKDAY, cfg, () => 0);
    expect(p).toMatchObject({ dateKey: DATEKEY, workday: true, shift: "09:30-18:30", inDone: false, outDone: false });
    expect(p.inAt).toBe(tw(9, 19, 0)); // 09:30 − (10+1)min − 0s
    expect(p.outAt).toBe(tw(18, 31, 0)); // 18:30 + 1min + 0s
  });

  it("bakes in random seconds (targets are not minute-aligned)", () => {
    const p = buildDayPlan(DATEKEY, WORKDAY, cfg, () => 0.5); // inSec = floor(0.5*60) = 30
    expect(p.inAt! % 60000).not.toBe(0);
    expect(p.outAt! % 60000).not.toBe(0);
  });

  it("keeps targets within the configured bands", () => {
    for (const r of [0, 0.5, 0.999]) {
      const p = buildDayPlan(DATEKEY, WORKDAY, cfg, () => r);
      expect(p.inAt!).toBeGreaterThanOrEqual(tw(9, 5, 0) - 59000); // 09:30 − 25min − 59s
      expect(p.inAt!).toBeLessThanOrEqual(tw(9, 19, 0)); // 09:30 − 11min
      expect(p.outAt!).toBeGreaterThanOrEqual(tw(18, 31, 0)); // 18:30 + 1min
      expect(p.outAt!).toBeLessThanOrEqual(tw(18, 45, 0) + 59000); // 18:30 + 15min + 59s
    }
  });
});

describe("dueAction", () => {
  const plan: DayPlan = { dateKey: DATEKEY, workday: true, inAt: tw(9, 19), outAt: tw(18, 31), inDone: false, outDone: false };

  it("non-workday → null", () => {
    expect(dueAction({ ...plan, workday: false, inAt: null, outAt: null }, tw(9, 30))).toBeNull();
  });
  it("before inAt → null; at/after inAt (not done) → in", () => {
    expect(dueAction(plan, tw(9, 10))).toBeNull();
    expect(dueAction(plan, tw(9, 19))).toBe("in");
  });
  it("in done, before outAt → null; at/after outAt → out", () => {
    expect(dueAction({ ...plan, inDone: true }, tw(12, 0))).toBeNull();
    expect(dueAction({ ...plan, inDone: true }, tw(18, 31))).toBe("out");
  });
  it("both done → null", () => {
    expect(dueAction({ ...plan, inDone: true, outDone: true }, tw(23, 0))).toBeNull();
  });
  it("both overdue and neither done → in first (catch up in order)", () => {
    expect(dueAction(plan, tw(20, 0))).toBe("in");
  });
});

describe("nextAlarm", () => {
  const tomorrow = tw(24 + 0, 5); // arbitrary "tomorrow" sentinel
  const plan: DayPlan = { dateKey: DATEKEY, workday: true, inAt: tw(9, 19), outAt: tw(18, 31), inDone: false, outDone: false };

  it("fresh workday → inAt", () => expect(nextAlarm(plan, tomorrow)).toBe(tw(9, 19)));
  it("in done → outAt", () => expect(nextAlarm({ ...plan, inDone: true }, tomorrow)).toBe(tw(18, 31)));
  it("both done → tomorrow", () => expect(nextAlarm({ ...plan, inDone: true, outDone: true }, tomorrow)).toBe(tomorrow));
  it("non-workday → tomorrow", () => expect(nextAlarm({ ...plan, workday: false }, tomorrow)).toBe(tomorrow));
});
