import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // The test pool needs AsyncLocalStorage to start, which requires the
        // Node compat flag. Scope it to the test runtime only (via this
        // miniflare override) so production wrangler.toml never enables
        // Node compat on the deployed Worker.
        miniflare: {
          compatibilityDate: "2024-12-30",
          // @cloudflare/vitest-pool-workers (0.5.x) hard-asserts the test
          // runner worker has "nodejs_compat" or "nodejs_compat_v2" — it
          // rejects the narrower "nodejs_als" flag outright (see
          // buildProjectWorkerOptions in the pool's dist bundle). Scoping it
          // here, not in wrangler.toml, keeps it out of the production Worker.
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
