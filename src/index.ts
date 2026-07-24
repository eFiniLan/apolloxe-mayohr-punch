import { runScheduler } from "./scheduler";

// No bindings needed — the Worker is stateless (server-side idempotency).
// Config comes from [vars] + secrets, read via the string index signature.
export interface Env {
  [key: string]: unknown;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env));
  },
};
