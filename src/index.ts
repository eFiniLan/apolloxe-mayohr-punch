import { runScheduler } from "./scheduler";

// No bindings needed — the Worker is stateless (server-side idempotency).
// Config comes from [vars] + secrets, read via the string index signature.
export interface Env {
  [key: string]: unknown;
}

export default {
  // Awaited (not waitUntil) so a thrown failure marks the cron invocation failed
  // — it shows up in `wrangler tail` and the dashboard instead of looking green.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runScheduler(env);
  },
};
