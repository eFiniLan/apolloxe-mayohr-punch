// The Worker's "plan for today": computed once (first fire of the day) from that
// day's calendar, persisted in KV, then honored by every later fire. This is what
// lets a fully flexible schedule work — direction and timing come from the plan,
// not from a fixed cron window or a noon split. The random early-in/late-out
// offsets are rolled ONCE here and frozen, so the punch time is human-looking and
// stable across fires (instead of re-rolled every fire).
import type { DayInfo } from "./calendar";
import type { Config } from "./config";
import type { CacheStore } from "./cache-store";
import { addMinutes, randInt } from "./time";

// The cron cadence (minutes). Clock-in's target is kept at least this far before
// the shift so a poll is guaranteed to land in [inTarget, shiftStart) — i.e. the
// clock-in never slips past the shift start. Keep in sync with wrangler.toml
// `crons` (currently */10).
export const CRON_STEP_MIN = 10;

export interface Plan {
  workday: boolean;
  skipReason?: string; // when !workday: why (for the log): "not a workday" | "on approved leave"
  shift?: string; // "09:30-18:30" — the shift these targets were built from
  inTarget?: string; // "HH:MM" randomized clock-in time (always before the shift)
  outTarget?: string; // "HH:MM" randomized clock-out time (always after the shift)
  inDone: boolean; // a clock-in already happened (success/already_done/cooldown)
  outDone: boolean; // a clock-out already happened
}

/**
 * Build today's plan from its DayInfo. Non-workdays (and, when RESPECT_LEAVE,
 * full-day leave) become a cheap `workday:false` record so the rest of the day is
 * pure KV reads. A workday missing its shift times is an anomaly — throw (fail
 * loudly, punch manually) rather than plan a broken day. The random offsets are
 * rolled here, once.
 */
export function buildPlan(info: DayInfo, cfg: Config, rand: () => number = Math.random): Plan {
  if (!info.isWorkday) {
    return { workday: false, skipReason: "not a workday", inDone: false, outDone: false };
  }
  if (cfg.respectLeave && info.onLeave) {
    return { workday: false, skipReason: "on approved leave", inDone: false, outDone: false };
  }
  if (!info.shiftStart || !info.shiftEnd) {
    throw new Error(`workday but no scheduled shift time — punch manually`);
  }
  // Clock-in is ALWAYS early: at least reactionBufferMin before the shift (so a
  // failure alert leaves you time to punch manually) AND at least CRON_STEP_MIN
  // before it (so a poll is guaranteed to fire in [inTarget, shiftStart)).
  // Clock-out is simply a random amount after the shift end.
  const inTarget = addMinutes(
    info.shiftStart,
    -Math.max(CRON_STEP_MIN, cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand)),
  );
  const outTarget = addMinutes(info.shiftEnd, randInt(cfg.lateOut.min, cfg.lateOut.max, rand));
  return {
    workday: true,
    shift: `${info.shiftStart}-${info.shiftEnd}`,
    inTarget,
    outTarget,
    inDone: false,
    outDone: false,
  };
}

export type Action = "in" | "out" | "skip";

/**
 * What to do at wall-clock `hhmm` given the plan. Out is checked first (they never
 * overlap for a real shift). A direction already done is skipped — so mid-shift
 * fires do nothing, no reliance on the server to reject a redundant punch.
 */
export function decide(plan: Plan, hhmm: string): Action {
  if (!plan.workday) return "skip";
  if (plan.outTarget && !plan.outDone && hhmm >= plan.outTarget) return "out";
  if (plan.inTarget && !plan.inDone && hhmm >= plan.inTarget) return "in";
  return "skip";
}

const PLAN_PREFIX = "plan:";

export async function readPlan(store: CacheStore, dateKey: string): Promise<Plan | null> {
  const raw = await store.read(PLAN_PREFIX + dateKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Plan;
  } catch {
    return null; // corrupt record → rebuild
  }
}

export async function savePlan(store: CacheStore, dateKey: string, plan: Plan): Promise<void> {
  await store.write(PLAN_PREFIX + dateKey, JSON.stringify(plan));
}
