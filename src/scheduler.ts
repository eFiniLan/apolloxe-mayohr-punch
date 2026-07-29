import type { Env } from "./index";
import { loadConfig } from "./config";
import { nowParts, addMinutes, randInt } from "./time";
import { acquireSession as realAcquireSession, getDay as realGetDay } from "./flow";
import type { CacheStore } from "./cache-store";
import { punch as realPunch } from "./punch";
import { notify as realNotify } from "./notify";

export interface Deps {
  acquireSession: typeof realAcquireSession;
  getDay: typeof realGetDay;
  punch: typeof realPunch;
  notify: typeof realNotify;
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
 * `cooldown` both mean "a punch already happened", so we stay quiet. Only a
 * genuine failure emails — and because we attempt early, that email arrives with
 * time to spare to punch manually.
 */
export async function runScheduler(env: Env, deps: Partial<Deps> = {}): Promise<void> {
  const d = {
    acquireSession: realAcquireSession,
    getDay: realGetDay,
    punch: realPunch,
    notify: realNotify,
    ...deps,
  };
  const cfg = loadConfig(env);
  const now = deps.now ?? new Date();
  const rand = deps.rand ?? Math.random;
  const { dateKey, hhmm } = nowParts(cfg.timezone, now);
  const direction: "in" | "out" = hhmm < "12:00" ? "in" : "out";

  try {
    const { session } = await d.acquireSession(cfg, d.store ?? null);
    const { info } = await d.getDay(session, cfg, d.store ?? null, dateKey);

    if (!info.isWorkday) return; // weekend / holiday
    if (cfg.respectLeave && info.onLeave) return;

    // Clock-in needs the shift START; clock-out needs the shift END. A workday
    // missing the relevant time is an anomaly — alert rather than skip silently.
    const boundary = direction === "in" ? info.shiftStart : info.shiftEnd;
    if (!boundary) {
      await d.notify(cfg, {
        level: "failure",
        subject: `⚠️ Apollo clock-${direction} ${dateKey}: no scheduled time`,
        body: `It's a workday but the shift ${direction === "in" ? "start" : "end"} time is missing from the calendar — punch manually.`,
      });
      return;
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

    if (r.outcome === "success") {
      await d.notify(cfg, {
        level: "success",
        subject: `✅ Apollo clock-${direction} ${dateKey}`,
        body: `Clock-${direction} recorded. Mayo shows ${r.punchDate} @ ${r.locationName}${cfg.dryRun ? " (DRY_RUN)" : ""}.`,
      });
    } else if (r.outcome === "already_done" || r.outcome === "cooldown") {
      return; // a punch already happened — nothing to do, stay quiet
    } else {
      await d.notify(cfg, {
        level: "failure",
        subject: `⚠️ Apollo clock-${direction} FAILED ${dateKey}`,
        body: `${r.detail}. Punch manually if needed — the Worker retries on the next run.`,
      });
    }
  } catch (err) {
    await d.notify(cfg, { level: "failure", subject: "⚠️ Apollo auto-punch error", body: String(err) });
    throw err;
  }
}
