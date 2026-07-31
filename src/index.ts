import { PunchDay } from "./punch-day";

// A single Durable Object ("PunchDay") owns the schedule: its SQLite storage holds
// the cookie / calendar / today's plan, and its alarm() is a precise timer. The
// cron here is only a daily BACKSTOP that pokes the DO to make sure today is
// planned + armed (the DO otherwise re-arms itself). No KV needed.
export interface Env {
  PUNCH_DAY: DurableObjectNamespace<PunchDay>;
  [key: string]: unknown;
}

export { PunchDay };

export default {
  // Awaited (not waitUntil) so a thrown failure marks the invocation failed —
  // visible in `wrangler tail` / the dashboard instead of looking green.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    if (!env.PUNCH_DAY) {
      throw new Error("PUNCH_DAY is not bound — add the durable_objects binding + migration in wrangler.toml");
    }
    const stub = env.PUNCH_DAY.get(env.PUNCH_DAY.idFromName("singleton"));
    await stub.ensure();
  },
};
