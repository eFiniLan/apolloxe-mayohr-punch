import type { Env } from "./index";
import { loadConfig } from "./config";
import { nowParts, addMinutes, randInt } from "./time";
import { acquireSession as realAcquireSession, getDay as realGetDay } from "./flow";
import type { CacheStore } from "./cache-store";
import { punch as realPunch, summarize } from "./punch";

export interface Deps {
  acquireSession: typeof realAcquireSession;
  getDay: typeof realGetDay;
  punch: typeof realPunch;
  store?: CacheStore | null;
  now?: Date;
  rand?: () => number;
}

// The cron cadence (minutes). Clock-in's latest target is kept at least this far
// before the shift so a fire is guaranteed to land in [target, shiftStart).
// Keep in sync with wrangler.toml `crons` (*/5).
const CRON_STEP_MIN = 5;

/**
 * One cron fire. Stateless when `store` is null (the default); with a KV
 * `store` bound it reuses the cached cookie/calendar. The server is still the
 * source of truth: login → read today's calendar → (if it's time) punch in/out.
 * Direction is decided by time of day (morning = in, evening = out). The punch
 * is attempted a randomized amount before/after the scheduled boundary, always
 * early-in / late-out. Idempotency comes from the server: `already_done` and
 * `cooldown` both mean "a punch already happened", so we stay quiet. A genuine
 * failure throws — marking the cron invocation failed (visible in the dashboard
 * / `wrangler tail`); success / already_done / cooldown return quietly.
 */
export async function runScheduler(env: Env, deps: Partial<Deps> = {}): Promise<void> {
  const d = {
    acquireSession: realAcquireSession,
    getDay: realGetDay,
    punch: realPunch,
    ...deps,
  };
  const cfg = loadConfig(env);
  const now = deps.now ?? new Date();
  const rand = deps.rand ?? Math.random;
  const { dateKey, hhmm } = nowParts(cfg.timezone, now);
  const direction: "in" | "out" = hhmm < "12:00" ? "in" : "out";

  const { session } = await d.acquireSession(cfg, d.store ?? null);
  const { info } = await d.getDay(session, cfg, d.store ?? null, dateKey);

  if (!info.isWorkday) return; // weekend / holiday
  if (cfg.respectLeave && info.onLeave) return;

  // Clock-in needs the shift START; clock-out needs the shift END. A workday
  // missing the relevant time is an anomaly — fail the run rather than skip silently.
  const boundary = direction === "in" ? info.shiftStart : info.shiftEnd;
  if (!boundary) {
    throw new Error(
      `clock-${direction} ${dateKey}: workday but no scheduled ${direction === "in" ? "start" : "end"} time — punch manually`,
    );
  }

  // Randomized target. Clock-in is ALWAYS early: at least `reactionBufferMin`
  // before the shift (so a failure alert has buffer) AND at least CRON_STEP_MIN
  // before it — the latter guarantees a 5-min cron tick lands in
  // [target, shiftStart), so the punch can never slip past the shift even if
  // reactionBufferMin/earlyIn are configured small. Clock-out is simply after
  // shiftEnd (no upper bound to guarantee).
  const target =
    direction === "in"
      ? addMinutes(boundary, -Math.max(CRON_STEP_MIN, cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand)))
      : addMinutes(boundary, randInt(cfg.lateOut.min, cfg.lateOut.max, rand));

  if (hhmm < target) return; // not time yet

  const r = await d.punch(session, cfg, direction);
  const { ok, reason } = summarize(direction, r);
  if (!ok) throw new Error(`${reason} (${dateKey})`); // fails the invocation; retries next cron fire
  console.log(`apollo: clock-${direction} ${dateKey} — ${reason}${cfg.dryRun ? " (DRY_RUN)" : ""}`);
}
