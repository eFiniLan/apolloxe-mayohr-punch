import type { Env } from "./index";
import { loadConfig } from "./config";
import { nowParts } from "./time";
import { acquireSession as realAcquireSession, getDay as realGetDay } from "./flow";
import type { CacheStore } from "./cache-store";
import { punch as realPunch, summarize } from "./punch";
import { peekDay } from "./calendar-cache";
import { buildPlan, decide, readPlan, savePlan } from "./plan";

export interface Deps {
  acquireSession: typeof realAcquireSession;
  getDay: typeof realGetDay;
  punch: typeof realPunch;
  store?: CacheStore | null;
  now?: Date;
  rand?: () => number;
}

/**
 * One cron fire, plan-driven. Requires a KV `store`. The first fire of the day
 * reads that day's calendar and writes a "plan" (randomized clock-in/out targets,
 * done-flags) to KV; every later fire just reads the plan — no MayoHR call — and
 * punches only when a target time arrives. Direction and timing come from the
 * plan (the actual shift), so any single-day schedule works. Login is deferred:
 * a "waiting" fire never authenticates. Idempotency still comes from the server
 * (already_done / cooldown both count as done); a genuine failure throws, marking
 * the invocation failed (visible in `wrangler tail` / the dashboard).
 */
export async function runScheduler(env: Env, deps: Partial<Deps> = {}): Promise<void> {
  const d = { acquireSession: realAcquireSession, getDay: realGetDay, punch: realPunch, ...deps };
  const cfg = loadConfig(env);
  const now = deps.now ?? new Date();
  const rand = deps.rand ?? Math.random;
  const store = deps.store ?? null;
  if (!store) {
    throw new Error("APOLLO_KV is required: bind a KV namespace in wrangler.toml (the scheduler stores its daily plan there)");
  }
  const { dateKey, hhmm } = nowParts(cfg.timezone, now);

  // Log in at most once, and only when actually needed (plan build or punch).
  let session: Awaited<ReturnType<typeof d.acquireSession>>["session"] | null = null;
  const getSession = async () => (session ??= (await d.acquireSession(cfg, store)).session);

  // First fire of the day builds the plan from the calendar; later fires reuse it.
  let plan = await readPlan(store, dateKey);
  if (!plan) {
    // Prefer the warm calendar cache — no login. Authenticate (and refresh the
    // month) only on a cache miss, so building the plan is network-free most days.
    let info = await peekDay(store, dateKey, { now: () => now });
    if (!info) ({ info } = await d.getDay(await getSession(), cfg, store, dateKey));
    plan = buildPlan(info, cfg, rand); // throws on a workday with no shift time
    await savePlan(store, dateKey, plan);
  }

  const action = decide(plan, hhmm);
  if (action === "skip") {
    if (!plan.workday) {
      console.log(`apollo: ${dateKey} — skipped, ${plan.skipReason}`);
    } else {
      const inS = `in ${plan.inTarget}${plan.inDone ? " done" : ""}`;
      const outS = `out ${plan.outTarget}${plan.outDone ? " done" : ""}`;
      console.log(`apollo: ${dateKey} ${hhmm} — waiting (${inS}, ${outS})`);
    }
    return;
  }

  const r = await d.punch(await getSession(), cfg, action);
  const { ok, reason } = summarize(action, r);
  if (!ok) throw new Error(`${reason} (${dateKey})`); // fails the invocation; retries next fire
  if (action === "in") plan.inDone = true;
  else plan.outDone = true;
  await savePlan(store, dateKey, plan);
  console.log(`apollo: clock-${action} ${dateKey} — ${reason}${cfg.dryRun ? " (DRY_RUN)" : ""}`);
}
