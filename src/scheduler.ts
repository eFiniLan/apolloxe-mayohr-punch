import type { Env } from "./index";
import { loadConfig } from "./config";
import { login as realLogin, type Session } from "./auth";
import { getDayInfo as realGetDayInfo } from "./calendar";
import { punch as realPunch } from "./punch";
import { notify as realNotify } from "./notify";
import { getPlan, savePlan, type DayPlan } from "./state";
import { nowParts, addMinutes, randInt } from "./time";

export interface Deps {
  login: typeof realLogin;
  getDayInfo: typeof realGetDayInfo;
  punch: typeof realPunch;
  notify: typeof realNotify;
  now?: Date; // default new Date()
  rand?: () => number; // default Math.random (jitter)
}

/**
 * Per-cron-fire orchestration: build (or load) today's DayPlan, then attempt
 * whichever punches are due, escalating a "punch manually" alert once if
 * clock-in is still outstanding past the reaction buffer.
 * See .superpowers/sdd/task-9-brief.md "Per-fire flow" for the exact steps
 * this implements.
 */
export async function runScheduler(env: Env, deps?: Partial<Deps>): Promise<void> {
  const login = deps?.login ?? realLogin;
  const getDayInfo = deps?.getDayInfo ?? realGetDayInfo;
  const punch = deps?.punch ?? realPunch;
  const notify = deps?.notify ?? realNotify;
  const now = deps?.now ?? new Date();
  const rand = deps?.rand ?? Math.random;

  const cfg = loadConfig(env);
  const { dateKey, hhmm } = nowParts(cfg.timezone, now);

  // Lazy, per-fire-cached session: at most one login per fire, shared by
  // calendar + punch calls.
  let session: Session | null = null;
  async function getSession(): Promise<Session> {
    if (!session) session = await login(cfg);
    return session;
  }

  try {
    let plan = await getPlan(env.STATE, dateKey);

    if (!plan) {
      const s = await getSession();
      const info = await getDayInfo(s, cfg, dateKey);

      if (!info.isWorkday) {
        await savePlan(env.STATE, dateKey, { kind: "skip", reason: "not a workday" });
        return;
      }
      if (cfg.respectLeave && info.onLeave) {
        await savePlan(env.STATE, dateKey, { kind: "skip", reason: "on leave" });
        return;
      }
      if (!info.shiftStart || !info.shiftEnd) {
        throw new Error(`scheduler: workday ${dateKey} missing shiftStart/shiftEnd`);
      }

      const escalateInAt = addMinutes(info.shiftStart, -cfg.reactionBufferMin);
      const targetIn = addMinutes(
        info.shiftStart,
        -(cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand)),
      );
      const targetOut = addMinutes(info.shiftEnd, randInt(cfg.lateOut.min, cfg.lateOut.max, rand));

      plan = {
        kind: "active",
        targetIn,
        targetOut,
        escalateInAt,
        inDone: false,
        outDone: false,
        escalatedIn: false,
      };
      await savePlan(env.STATE, dateKey, plan);
      // Continue with this fresh active plan — a punch may already be due.
    }

    if (plan.kind === "skip") return;

    // --- Clock-in ---------------------------------------------------------
    if (!plan.inDone && hhmm >= plan.targetIn) {
      const s = await getSession();
      const r = await punch(s, cfg, "in");
      if (r.outcome === "success" || r.outcome === "already_done") {
        plan.inDone = true;
        await savePlan(env.STATE, dateKey, plan);
        const body =
          r.outcome === "success"
            ? `Clocked in at ${r.punchDate} (${r.locationName}).`
            : `Already clocked in (${r.detail}).`;
        await notify(cfg, { level: "success", subject: "✅ Apollo clock-in", body });
      } else {
        await notify(cfg, { level: "failure", subject: "⚠️ clock-in FAILED", body: r.detail });
        // leave inDone=false — retried next fire
      }
    }

    // --- Clock-in escalation (after the attempt) --------------------------
    if (!plan.inDone && !plan.escalatedIn && hhmm >= plan.escalateInAt) {
      await notify(cfg, {
        level: "urgent",
        subject: "🚨 Apollo clock-in NOT done — punch manually",
        body: `Not clocked in by ${plan.escalateInAt}; punch manually now. Worker still retrying.`,
      });
      plan.escalatedIn = true;
      await savePlan(env.STATE, dateKey, plan);
    }

    // --- Clock-out (no escalation — not time-critical) ---------------------
    if (!plan.outDone && hhmm >= plan.targetOut) {
      const s = await getSession();
      const r = await punch(s, cfg, "out");
      if (r.outcome === "success" || r.outcome === "already_done") {
        plan.outDone = true;
        await savePlan(env.STATE, dateKey, plan);
        const body =
          r.outcome === "success"
            ? `Clocked out at ${r.punchDate} (${r.locationName}).`
            : `Already clocked out (${r.detail}).`;
        await notify(cfg, { level: "success", subject: "✅ Apollo clock-out", body });
      } else {
        await notify(cfg, { level: "failure", subject: "⚠️ clock-out FAILED", body: r.detail });
        // leave outDone=false — retried next fire
      }
    }
  } catch (err) {
    await notify(cfg, { level: "failure", subject: "⚠️ Apollo scheduler error", body: String(err) });
    throw err;
  }
}
