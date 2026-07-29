import { runScheduler } from "./scheduler";
import { kvStore } from "./kv-store";

// Bind APOLLO_KV (a KV namespace) to cache the login cookie + calendar across
// fires; leave it unbound to run stateless (server-side idempotency). Config
// comes from [vars] + secrets, read via the string index signature.
export interface Env {
  APOLLO_KV?: KVNamespace;
  [key: string]: unknown;
}

export default {
  // Awaited (not waitUntil) so a thrown failure marks the cron invocation failed
  // — it shows up in `wrangler tail` and the dashboard instead of looking green.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const store = env.APOLLO_KV ? kvStore(env.APOLLO_KV) : null;
    await runScheduler(env, { store });
  },
};
