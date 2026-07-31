// The alarm-driven Worker: a single Durable Object ("PunchDay") that owns the day.
// Its SQLite storage holds the login cookie, the calendar cache, and today's plan;
// its alarm() is a precise timer. Each tick: make sure today is planned, punch if a
// target is due, then re-arm the alarm for the next moment (in → out → tomorrow).
// So MayoHR is touched ~3×/day (calendar + in + out) and the punch time is exact.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { loadConfig } from "./config";
import { nowParts, zonedTimeToEpoch, nextDateKey, hhmmss } from "./time";
import { acquireSession as realAcquireSession, getDay as realGetDay } from "./flow";
import { peekDay as realPeekDay } from "./calendar-cache";
import { punch as realPunch, summarize } from "./punch";
import { buildDayPlan, dueAction, nextAlarm, type DayPlan } from "./day-machine";
import { doStore, type KeyValueStorage } from "./do-store";

const PLAN_KEY = "day-plan";
const BOOTSTRAP_HHMM = "00:05"; // when a new day is (re)planned

/** Storage surface the tick needs: CacheStore keys + the plan + the alarm. */
export interface DayStorage extends KeyValueStorage {
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface TickDeps {
  acquireSession: typeof realAcquireSession;
  getDay: typeof realGetDay;
  peekDay: typeof realPeekDay;
  punch: typeof realPunch;
  now?: number; // epoch-ms; defaults to Date.now()
  rand?: () => number; // defaults to Math.random
}

/**
 * One tick of the machine — pure of the DO shell so it's testable with a fake
 * storage + injected deps. Called by both alarm() and the cron backstop's
 * ensure(). Idempotent: safe to run any number of times a day.
 */
export async function runTick(env: Env, storage: DayStorage, deps: Partial<TickDeps> = {}): Promise<void> {
  const d: TickDeps = {
    acquireSession: realAcquireSession,
    getDay: realGetDay,
    peekDay: realPeekDay,
    punch: realPunch,
    ...deps,
  };
  const cfg = loadConfig(env);
  const nowMs = deps.now ?? Date.now();
  const rand = deps.rand ?? Math.random;
  const { dateKey } = nowParts(cfg.timezone, new Date(nowMs));
  const store = doStore(storage);

  // Log in at most once, only when needed (plan build on a cache miss, or a punch).
  let session: Awaited<ReturnType<typeof d.acquireSession>>["session"] | null = null;
  const getSession = async () => (session ??= (await d.acquireSession(cfg, store)).session);

  // (Re)build the plan when the stored one is missing or for another day.
  let plan = (await storage.get<DayPlan>(PLAN_KEY)) ?? null;
  if (!plan || plan.dateKey !== dateKey) {
    let info = await d.peekDay(store, dateKey, { now: () => new Date(nowMs) }); // warm cache → no login
    if (!info) ({ info } = await d.getDay(await getSession(), cfg, store, dateKey));
    plan = buildDayPlan(dateKey, info, cfg, rand); // throws on a workday with no shift time
    await storage.put(PLAN_KEY, plan);
  }

  // Punch if a target is due.
  const due = dueAction(plan, nowMs);
  if (due) {
    const r = await d.punch(await getSession(), cfg, due);
    const { ok, reason } = summarize(due, r);
    if (!ok) throw new Error(`${reason} (${dateKey})`); // alarm retries with backoff
    if (due === "in") plan.inDone = true;
    else plan.outDone = true;
    await storage.put(PLAN_KEY, plan);
    console.log(`apollo: clock-${due} ${dateKey} — ${reason}${cfg.dryRun ? " (DRY_RUN)" : ""}`);
  } else if (!plan.workday) {
    console.log(`apollo: ${dateKey} — skipped, ${plan.skipReason}`);
  } else {
    const fmt = (at: number | null, done: boolean) => (at == null ? "—" : hhmmss(at, cfg.timezone)) + (done ? " done" : "");
    console.log(`apollo: ${dateKey} — waiting (in ${fmt(plan.inAt, plan.inDone)}, out ${fmt(plan.outAt, plan.outDone)})`);
  }

  // Re-arm: next pending target, else tomorrow's plan time. A past time (catch-up
  // after an outage) fires almost immediately.
  const tomorrow = zonedTimeToEpoch(nextDateKey(dateKey), BOOTSTRAP_HHMM, cfg.timezone);
  const armAt = Math.max(nextAlarm(plan, tomorrow), nowMs + 1000);
  await storage.setAlarm(armAt);
}

/**
 * The Durable Object. `alarm()` is the timer; `ensure()` is the RPC the daily cron
 * backstop calls to guarantee today is planned + armed even if an alarm was lost.
 */
export class PunchDay extends DurableObject<Env> {
  async ensure(): Promise<void> {
    await runTick(this.env, this.ctx.storage as unknown as DayStorage);
  }
  async alarm(): Promise<void> {
    await runTick(this.env, this.ctx.storage as unknown as DayStorage);
  }
}
