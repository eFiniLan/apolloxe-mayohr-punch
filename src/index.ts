import { runScheduler } from "./scheduler";
import { kvStore } from "./kv-store";

// APOLLO_KV (a KV namespace) is REQUIRED: the scheduler stores its per-day plan
// (randomized punch targets + done-flags) and caches the login cookie + calendar
// there. Config comes from [vars] + secrets, read via the string index signature.
export interface Env {
  APOLLO_KV?: KVNamespace;
  [key: string]: unknown;
}

export default {
  // Awaited (not waitUntil) so a thrown failure marks the cron invocation failed
  // — it shows up in `wrangler tail` and the dashboard instead of looking green.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    if (!env.APOLLO_KV) {
      throw new Error("APOLLO_KV is not bound — create a KV namespace and bind it in wrangler.toml");
    }
    await runScheduler(env, { store: kvStore(env.APOLLO_KV) });
  },
};
