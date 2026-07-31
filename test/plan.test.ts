import { describe, it, expect } from "vitest";
import { buildPlan, decide, readPlan, savePlan, CRON_STEP_MIN, type Plan } from "../src/plan";

const cfg: any = {
  reactionBufferMin: 10,
  earlyIn: { min: 1, max: 15 },
  lateOut: { min: 1, max: 15 },
  respectLeave: false,
};
const WORKDAY = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };

function memStore() {
  const m = new Map<string, string>();
  return { read: async (k: string) => m.get(k) ?? null, write: async (k: string, v: string) => void m.set(k, v), _m: m };
}

describe("buildPlan", () => {
  it("non-workday → workday:false with reason, no targets", () => {
    const p = buildPlan({ isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null }, cfg);
    expect(p).toEqual({ workday: false, skipReason: "not a workday", inDone: false, outDone: false });
  });

  it("full-day leave → workday:false when RESPECT_LEAVE, punchable otherwise", () => {
    const leave = { ...WORKDAY, onLeave: true };
    expect(buildPlan(leave, { ...cfg, respectLeave: true }).workday).toBe(false);
    expect(buildPlan(leave, { ...cfg, respectLeave: true }).skipReason).toBe("on approved leave");
    expect(buildPlan(leave, cfg).workday).toBe(true); // default: still punch
  });

  it("workday missing a shift boundary → throws (fail loudly)", () => {
    expect(() => buildPlan({ ...WORKDAY, shiftStart: null }, cfg)).toThrow(/no scheduled shift/);
    expect(() => buildPlan({ ...WORKDAY, shiftEnd: null }, cfg)).toThrow(/no scheduled shift/);
  });

  it("workday → in before the shift, out after, rolled once (rand=0 → min offsets)", () => {
    const p = buildPlan(WORKDAY, cfg, () => 0);
    // in = 09:30 − max(10, 10+1) = 09:19 ; out = 18:30 + 1 = 18:31
    expect(p).toMatchObject({ workday: true, shift: "09:30-18:30", inTarget: "09:19", outTarget: "18:31", inDone: false, outDone: false });
  });

  it("clamps clock-in to at least CRON_STEP_MIN before the shift", () => {
    // buffer 0 + earlyIn 1 = 1 min < CRON_STEP_MIN(10) → clamp to 10 → 09:20
    const p = buildPlan(WORKDAY, { ...cfg, reactionBufferMin: 0 }, () => 0);
    expect(p.inTarget).toBe(addMin("09:30", -CRON_STEP_MIN));
  });

  it("random offsets stay within the configured band", () => {
    for (const r of [0, 0.5, 0.999]) {
      const p = buildPlan(WORKDAY, cfg, () => r);
      // in between 09:30−(10+15)=09:05 and 09:30−(10+1)=09:19 ; out between 18:31 and 18:45
      expect(p.inTarget! >= "09:05" && p.inTarget! <= "09:19").toBe(true);
      expect(p.outTarget! >= "18:31" && p.outTarget! <= "18:45").toBe(true);
    }
  });
});

describe("decide", () => {
  const plan: Plan = { workday: true, shift: "09:30-18:30", inTarget: "09:19", outTarget: "18:31", inDone: false, outDone: false };

  it("non-workday → skip", () => {
    expect(decide({ workday: false, inDone: false, outDone: false }, "09:30")).toBe("skip");
  });
  it("before inTarget → skip", () => expect(decide(plan, "09:10")).toBe("skip"));
  it("at/after inTarget and not done → in", () => {
    expect(decide(plan, "09:19")).toBe("in");
    expect(decide(plan, "12:00")).toBe("in"); // still clock-in mid-day if it never happened
  });
  it("clock-in already done → skip (no redundant mid-shift punch)", () => {
    expect(decide({ ...plan, inDone: true }, "12:00")).toBe("skip");
  });
  it("at/after outTarget and not done → out", () => {
    expect(decide({ ...plan, inDone: true }, "18:31")).toBe("out");
    expect(decide({ ...plan, inDone: true }, "23:00")).toBe("out");
  });
  it("clock-out already done → skip", () => {
    expect(decide({ ...plan, inDone: true, outDone: true }, "23:00")).toBe("skip");
  });
});

describe("readPlan / savePlan", () => {
  it("round-trips a plan through the store", async () => {
    const store = memStore();
    const p = buildPlan(WORKDAY, cfg, () => 0);
    await savePlan(store, "2026-07-31", p);
    expect(await readPlan(store, "2026-07-31")).toEqual(p);
    expect(store._m.has("plan:2026-07-31")).toBe(true);
  });
  it("returns null when absent or corrupt", async () => {
    const store = memStore();
    expect(await readPlan(store, "2026-07-31")).toBeNull();
    await store.write("plan:2026-07-31", "not json");
    expect(await readPlan(store, "2026-07-31")).toBeNull();
  });
});

// local mirror of time.addMinutes to keep this test self-contained
function addMin(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
