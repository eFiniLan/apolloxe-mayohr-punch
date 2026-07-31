// Pure logic for the alarm-driven Worker (src/punch-day.ts). A day's plan is
// built ONCE from that day's shift, with the random early-in/late-out offsets —
// down to the second — rolled once and baked into absolute epoch-ms targets. An
// exact-time alarm then fires at inAt/outAt, so the punch time is genuinely random
// (no poll-grid quantization). No I/O here — trivially unit-testable.
import type { DayInfo } from "./calendar";
import type { Config } from "./config";
import { randInt, zonedTimeToEpoch } from "./time";

export interface DayPlan {
  dateKey: string; // "YYYY-MM-DD" this plan is for (in cfg.timezone)
  workday: boolean;
  skipReason?: string; // when !workday: "not a workday" | "on approved leave"
  shift?: string; // "09:30-18:30" the targets were built from
  inAt: number | null; // absolute epoch-ms to clock in (random seconds baked in)
  outAt: number | null; // absolute epoch-ms to clock out
  inDone: boolean;
  outDone: boolean;
}

function skip(dateKey: string, reason: string): DayPlan {
  return { dateKey, workday: false, skipReason: reason, inAt: null, outAt: null, inDone: false, outDone: false };
}

/**
 * Build today's plan from its DayInfo. Non-workdays (and full-day leave when
 * RESPECT_LEAVE) become a cheap skip record. A workday missing its shift times is
 * an anomaly — throw (fail loudly, punch manually). Offsets rolled once:
 *   inAt  = shiftStart − (reactionBufferMin + rand(earlyIn)) minutes − rand(0..59)s
 *   outAt = shiftEnd   +  rand(lateOut) minutes + rand(0..59)s
 * No CRON_STEP floor — the alarm fires at the exact instant, there is no poll grid.
 */
export function buildDayPlan(dateKey: string, info: DayInfo, cfg: Config, rand: () => number = Math.random): DayPlan {
  if (!info.isWorkday) return skip(dateKey, "not a workday");
  if (cfg.respectLeave && info.onLeave) return skip(dateKey, "on approved leave");
  if (!info.shiftStart || !info.shiftEnd) {
    throw new Error(`workday but no scheduled shift time — punch manually`);
  }
  const earlyMin = cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand);
  const lateMin = randInt(cfg.lateOut.min, cfg.lateOut.max, rand);
  const inSec = randInt(0, 59, rand);
  const outSec = randInt(0, 59, rand);
  const startMs = zonedTimeToEpoch(dateKey, info.shiftStart, cfg.timezone);
  const endMs = zonedTimeToEpoch(dateKey, info.shiftEnd, cfg.timezone);
  return {
    dateKey,
    workday: true,
    shift: `${info.shiftStart}-${info.shiftEnd}`,
    inAt: startMs - (earlyMin * 60 + inSec) * 1000,
    outAt: endMs + (lateMin * 60 + outSec) * 1000,
    inDone: false,
    outDone: false,
  };
}

/**
 * Which punch is due right now, if any. Clock-in is checked first so that after a
 * long outage the DO catches up in order (in, then out). null = nothing due.
 */
export function dueAction(plan: DayPlan, nowMs: number): "in" | "out" | null {
  if (!plan.workday) return null;
  if (!plan.inDone && plan.inAt != null && nowMs >= plan.inAt) return "in";
  if (!plan.outDone && plan.outAt != null && nowMs >= plan.outAt) return "out";
  return null;
}

/**
 * The next instant the DO should wake: the next pending target, else the given
 * "tomorrow" bootstrap time (nothing left to do today). Callers clamp a past
 * result to ~now so an overdue step fires immediately (catch-up).
 */
export function nextAlarm(plan: DayPlan, tomorrowMs: number): number {
  if (plan.workday && !plan.inDone && plan.inAt != null) return plan.inAt;
  if (plan.workday && !plan.outDone && plan.outAt != null) return plan.outAt;
  return tomorrowMs;
}
