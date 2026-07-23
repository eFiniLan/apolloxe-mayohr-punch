import { describe, it, expect, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { runScheduler } from "../src/scheduler";
import type { Session } from "../src/auth";
import type { DayInfo } from "../src/calendar";
import type { PunchOutcome } from "../src/punch";
import { getPlan, savePlan, type DayPlan } from "../src/state";

// ---- fixtures ---------------------------------------------------------

const SESSION: Session = { cookie: "__ModuleSessionCookie=ABC" };

const WORKDAY: DayInfo = { isWorkday: true, onLeave: false, shiftStart: "09:30", shiftEnd: "18:30" };
const NON_WORKDAY: DayInfo = { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null };
const ON_LEAVE: DayInfo = { isWorkday: true, onLeave: true, shiftStart: "09:30", shiftEnd: "18:30" };

// With PUNCH_EARLY_IN_MIN=MAX=5, REACTION_BUFFER_MIN=10, shiftStart "09:30":
//   escalateInAt = "09:20", targetIn = "09:15"
// With PUNCH_LATE_OUT_MIN=MAX=5, shiftEnd "18:30":
//   targetOut = "18:35"
const TARGET_IN = "09:15";
const ESCALATE_IN_AT = "09:20";
const TARGET_OUT = "18:35";

function baseEnv(extra: Record<string, string> = {}) {
  return {
    ...testEnv,
    MAYO_USERNAME: "user@example.com",
    MAYO_PASSWORD: "secret",
    RESEND_API_KEY: "re_x",
    NOTIFY_TO: "me@example.com",
    NOTIFY_FROM: "bot@example.com",
    PUNCH_EARLY_IN_MIN: "5",
    PUNCH_EARLY_IN_MAX: "5",
    PUNCH_LATE_OUT_MIN: "5",
    PUNCH_LATE_OUT_MAX: "5",
    REACTION_BUFFER_MIN: "10",
    ...extra,
  } as any;
}

// Asia/Taipei = UTC+8, no DST. All test times here are >= 08:00 local so the
// UTC date always matches `dateKey`.
function taipeiNow(dateKey: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = h - 8;
  return new Date(`${dateKey}T${String(utcH).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
}

function fakeLogin(impl: () => Promise<Session> = async () => SESSION) {
  return vi.fn(impl) as any;
}
function fakeGetDayInfo(info: DayInfo) {
  return vi.fn(async () => info) as any;
}
function successPunch(punchDate = "2026-07-01T01:16:00Z", locationName = "Office") {
  return vi.fn(
    async (): Promise<PunchOutcome> => ({
      outcome: "success",
      attendanceHistoryId: "AH",
      punchDate,
      locationName,
    }),
  ) as any;
}
function alreadyDonePunch() {
  return vi.fn(async (): Promise<PunchOutcome> => ({ outcome: "already_done", detail: "already clocked in" })) as any;
}
function failurePunch() {
  return vi.fn(async (): Promise<PunchOutcome> => ({ outcome: "failure", detail: "boom" })) as any;
}
function fakeNotify() {
  return vi.fn(async () => {}) as any;
}

// ---- tests --------------------------------------------------------------

describe("runScheduler", () => {
  it("1. non-workday: saves a skip plan, never punches", async () => {
    const dateKey = "2026-07-01";
    const env = baseEnv();
    const login = fakeLogin();
    const getDayInfo = fakeGetDayInfo(NON_WORKDAY);
    const punch = failurePunch();
    const notify = fakeNotify();

    await runScheduler(env, {
      login,
      getDayInfo,
      punch,
      notify,
      now: taipeiNow(dateKey, "09:00"),
      rand: () => 0,
    });

    expect(punch).not.toHaveBeenCalled();
    const plan = await getPlan(env.STATE, dateKey);
    expect(plan).toEqual({ kind: "skip", reason: "not a workday" });
  });

  it("2a. on leave + respectLeave true: saves a skip plan, never punches", async () => {
    const dateKey = "2026-07-02";
    const env = baseEnv({ RESPECT_LEAVE: "true" });
    const punch = failurePunch();

    await runScheduler(env, {
      login: fakeLogin(),
      getDayInfo: fakeGetDayInfo(ON_LEAVE),
      punch,
      notify: fakeNotify(),
      now: taipeiNow(dateKey, "09:00"),
      rand: () => 0,
    });

    expect(punch).not.toHaveBeenCalled();
    const plan = await getPlan(env.STATE, dateKey);
    expect(plan).toEqual({ kind: "skip", reason: "on leave" });
  });

  it("2b. on leave + respectLeave false: builds an active plan and punches", async () => {
    const dateKey = "2026-07-03";
    const env = baseEnv({ RESPECT_LEAVE: "false" });
    const punch = successPunch();

    await runScheduler(env, {
      login: fakeLogin(),
      getDayInfo: fakeGetDayInfo(ON_LEAVE),
      punch,
      notify: fakeNotify(),
      now: taipeiNow(dateKey, "09:16"), // past targetIn
      rand: () => 0,
    });

    expect(punch).toHaveBeenCalledTimes(1);
    const plan = await getPlan(env.STATE, dateKey);
    expect(plan?.kind).toBe("active");
    expect((plan as any).inDone).toBe(true);
  });

  it("3. workday, before targetIn: saves active plan, does not punch yet", async () => {
    const dateKey = "2026-07-04";
    const env = baseEnv();
    const punch = failurePunch();

    await runScheduler(env, {
      login: fakeLogin(),
      getDayInfo: fakeGetDayInfo(WORKDAY),
      punch,
      notify: fakeNotify(),
      now: taipeiNow(dateKey, "09:00"), // before targetIn "09:15"
      rand: () => 0,
    });

    expect(punch).not.toHaveBeenCalled();
    const plan = await getPlan(env.STATE, dateKey);
    expect(plan).toEqual({
      kind: "active",
      targetIn: TARGET_IN,
      targetOut: TARGET_OUT,
      escalateInAt: ESCALATE_IN_AT,
      inDone: false,
      outDone: false,
      escalatedIn: false,
    });
  });

  it("4. workday, past targetIn: punches once; a second run same day is idempotent", async () => {
    const dateKey = "2026-07-05";
    const env = baseEnv();
    const getDayInfo = fakeGetDayInfo(WORKDAY);
    const punch = successPunch();
    const now = taipeiNow(dateKey, "09:16");

    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify: fakeNotify(), now, rand: () => 0 });
    expect(punch).toHaveBeenCalledTimes(1);

    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify: fakeNotify(), now, rand: () => 0 });
    expect(punch).toHaveBeenCalledTimes(1); // not called again

    const plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).inDone).toBe(true);
  });

  it("5. punch failure: notifies failure, inDone stays false, next fire retries", async () => {
    const dateKey = "2026-07-06";
    const env = baseEnv();
    const getDayInfo = fakeGetDayInfo(WORKDAY);
    const punch = failurePunch();
    const notify = fakeNotify();
    const now = taipeiNow(dateKey, "09:16"); // past targetIn, before escalateInAt

    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify, now, rand: () => 0 });
    expect(punch).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "failure", subject: "⚠️ clock-in FAILED", body: "boom" }),
    );
    let plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).inDone).toBe(false);

    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify, now, rand: () => 0 });
    expect(punch).toHaveBeenCalledTimes(2); // retried

    plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).inDone).toBe(false);
  });

  it("6. already_done outcome is treated as success: inDone set, no failure notify", async () => {
    const dateKey = "2026-07-07";
    const env = baseEnv();
    const punch = alreadyDonePunch();
    const notify = fakeNotify();

    await runScheduler(env, {
      login: fakeLogin(),
      getDayInfo: fakeGetDayInfo(WORKDAY),
      punch,
      notify,
      now: taipeiNow(dateKey, "09:16"),
      rand: () => 0,
    });

    const plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).inDone).toBe(true);
    for (const call of notify.mock.calls) {
      expect((call[1] as any).level).not.toBe("failure");
    }
  });

  it("7. escalation fires exactly once across two fires while still not clocked in", async () => {
    const dateKey = "2026-07-08";
    const env = baseEnv();
    const getDayInfo = fakeGetDayInfo(WORKDAY);
    const punch = failurePunch();
    const notify = fakeNotify();
    const now = taipeiNow(dateKey, "09:25"); // >= escalateInAt "09:20"

    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify, now, rand: () => 0 });
    await runScheduler(env, { login: fakeLogin(), getDayInfo, punch, notify, now, rand: () => 0 });

    const escalationCalls = notify.mock.calls.filter(
      (c: any[]) => (c[1] as any).subject === "🚨 Apollo clock-in NOT done — punch manually",
    );
    expect(escalationCalls).toHaveLength(1);

    const plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).escalatedIn).toBe(true);
    expect((plan as any).inDone).toBe(false);
  });

  it("8. clock-out past targetOut: punches out, sets outDone", async () => {
    const dateKey = "2026-07-09";
    const env = baseEnv();
    const seeded: DayPlan = {
      kind: "active",
      targetIn: TARGET_IN,
      targetOut: TARGET_OUT,
      escalateInAt: ESCALATE_IN_AT,
      inDone: true,
      outDone: false,
      escalatedIn: true,
    };
    await savePlan(env.STATE, dateKey, seeded);
    const punch = successPunch();

    await runScheduler(env, {
      login: fakeLogin(),
      getDayInfo: fakeGetDayInfo(WORKDAY),
      punch,
      notify: fakeNotify(),
      now: taipeiNow(dateKey, "18:40"), // past targetOut "18:35"
      rand: () => 0,
    });

    expect(punch).toHaveBeenCalledTimes(1);
    expect(punch.mock.calls[0][2]).toBe("out");
    const plan = await getPlan(env.STATE, dateKey);
    expect((plan as any).outDone).toBe(true);
  });

  it("9. login throws: notifies failure, rejects, no plan saved", async () => {
    const dateKey = "2026-07-10";
    const env = baseEnv();
    const notify = fakeNotify();
    const login = fakeLogin(async () => {
      throw new Error("login exploded");
    });

    await expect(
      runScheduler(env, {
        login,
        getDayInfo: fakeGetDayInfo(WORKDAY),
        punch: failurePunch(),
        notify,
        now: taipeiNow(dateKey, "09:16"),
        rand: () => 0,
      }),
    ).rejects.toThrow("login exploded");

    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "failure", subject: "⚠️ Apollo scheduler error" }),
    );
    const plan = await getPlan(env.STATE, dateKey);
    expect(plan).toBeNull();
  });
});
