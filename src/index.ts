export interface Env {
  STATE: KVNamespace;
  [key: string]: unknown;
}

export default {
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // wired up in Task 9
  },
};
