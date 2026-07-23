import { runScheduler } from "./scheduler";

export interface Env {
  STATE: KVNamespace;
  [key: string]: unknown;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env));
  },
};
