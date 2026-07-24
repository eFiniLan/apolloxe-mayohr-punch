import type { Env } from "./index";
import { loadConfig } from "./config";
import { nowParts, addMinutes, randInt } from "./time";
import { login as realLogin } from "./auth";
import { getDayInfo as realGetDayInfo } from "./calendar";
import { punch as realPunch } from "./punch";
import { notify as realNotify } from "./notify";

export interface Deps {
  login: typeof realLogin;
  getDayInfo: typeof realGetDayInfo;
  punch: typeof realPunch;
  notify: typeof realNotify;
  now?: Date;
  rand?: () => number;
}

/**
 * One cron fire. Stateless — no KV. The server is the source of truth:
 *   login → read today's calendar → (if it's time) punch in/out.
 * Direction is decided by time of day (morning = in, evening = out). The punch
 * is attempted a randomized amount before/after the scheduled boundary, always
 * early-in / late-out. Idempotency comes from the server: `already_done` and
 * `cooldown` both mean "a punch already happened", so we stay quiet. Only a
 * genuine failure emails — and because we attempt early, that email arrives with
 * time to spare to punch manually.
 */
export async function runScheduler(env: Env, deps: Partial<Deps> = {}): Promise<void> {
  const d = {
    login: realLogin,
    getDayInfo: realGetDayInfo,
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
    const session = await d.login(cfg);
    const info = await d.getDayInfo(session, cfg, dateKey);

    if (!info.isWorkday) return; // weekend / holiday
    if (cfg.respectLeave && info.onLeave) return;
    if (!info.shiftStart || !info.shiftEnd) return;

    // Randomized target, always early-in (≥ reactionBufferMin before shift so a
    // failure alert lands with buffer) / late-out. Fresh randomness per fire is
    // fine: the punch lands at the first fire past the target, and the target's
    // upper bound guarantees it fires before the shift boundary.
    const target =
      direction === "in"
        ? addMinutes(info.shiftStart, -(cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand)))
        : addMinutes(info.shiftEnd, randInt(cfg.lateOut.min, cfg.lateOut.max, rand));

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
