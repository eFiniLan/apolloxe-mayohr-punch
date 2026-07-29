# Part 2 — Worker over the shared core + opt-in KV cache — design

**Date:** 2026-07-29
**Status:** approved (decisions settled), ready for spec review → planning

## Goal

Make the deployed Worker reuse Part 1's shared building blocks (no more
CLI-vs-Worker duplication of login/session/calendar logic), and let it optionally
cache the session cookie + calendar in **Workers KV** — enabled just by binding a
KV namespace, with the Worker staying **stateless** (today's behavior) when no
namespace is bound.

## Correction to the Part 1 promise

The Worker does **not** call `runPunch` whole. Its **timing gate** ("is it past
the randomized target?", computed from the shift times) sits *between* the
calendar read and the punch, and `runPunch` bundles session→check→punch as one
call. So the Worker shares `runPunch`'s **building blocks** instead:
`acquireSession`, a new `getDay` helper, and `punch`. The scheduler keeps its own
direction-from-time, target computation, timing gate, and notify.

## Architecture

### `src/flow.ts` — extract `getDay`

Pull the cached-or-live calendar read (currently inline in `runPunch`) into a
shared helper; `runPunch` and the scheduler both use it.

```ts
export async function getDay(
  session: Session, cfg: Config, store: CacheStore | null, dateKey: string,
  deps?: { cachedDayInfo?: typeof cachedDayInfo; getDayInfo?: typeof getDayInfo },
): Promise<{ info: DayInfo; source?: "cache" | "fresh" }>
// store truthy → cachedDayInfo(session, cfg, dateKey, store) → { info, source }
// store null   → getDayInfo(session, cfg, dateKey)          → { info } (no source)
```
`runPunch` calls `getDay(session, cfg, store, dateKey, { cachedDayInfo: deps.cachedDayInfo, getDayInfo: deps.getDayInfo })` and reads `.info` / `.source` from it — its existing behavior and tests are unchanged (`RunPunchDeps` keeps `cachedDayInfo`/`getDayInfo`).

### `src/kv-store.ts` (new) — the KV adapter

```ts
import type { CacheStore } from "./cache-store";
/** A Workers-KV-backed CacheStore for the Worker. */
export function kvStore(ns: KVNamespace): CacheStore {
  return {
    read: (key) => ns.get(key),          // Promise<string | null>
    write: (key, contents) => ns.put(key, contents), // Promise<void>
  };
}
```
`KVNamespace` is a `@cloudflare/workers-types` global (already used via `ScheduledController`/`ExecutionContext`). KV stores the same JSON strings the file store does; KV's ~eventual consistency is fine (validate-before-use + TTL handle staleness).

### `src/scheduler.ts` — reuse the primitives, add a `store`

Swap two calls and add an optional `store`; keep all timing/notify logic and the
early-in/late-out/`CRON_STEP_MIN` guarantees exactly as they are.

- `Deps` changes: replace `login` with `acquireSession`, replace `getDayInfo`
  with `getDay`, add `store?: CacheStore | null`. (Imports shift from
  `./auth`/`./calendar` to `./flow`.)
- Body: `const { session } = await d.acquireSession(cfg, d.store ?? null);`
  replaces `const session = await d.login(cfg);`; and
  `const { info } = await d.getDay(session, cfg, d.store ?? null, dateKey);`
  replaces `const info = await d.getDayInfo(session, cfg, dateKey);`.
- Everything after (`isWorkday`/leave gates, boundary, target math, `hhmm <
  target` gate, `punch`, the success/already_done/cooldown/failure notify
  branches, the catch) is untouched.

### `src/index.ts` — pass a KV store iff bound

```ts
import { runScheduler } from "./scheduler";
import { kvStore } from "./kv-store";

export interface Env {
  APOLLO_KV?: KVNamespace; // bound → cache; absent → stateless
  [key: string]: unknown;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const store = env.APOLLO_KV ? kvStore(env.APOLLO_KV) : null;
    await runScheduler(env, { store });
  },
};
```
`await` (not `waitUntil`) is kept so a failure marks the cron invocation failed.

### `wrangler.toml` — commented, opt-in binding

Leave the Worker stateless by default; document how to enable KV:
```toml
# Optional: cache the login cookie + calendar across fires (≈1 login / 9 days
# instead of ~48/day). Without this the Worker is stateless (today's behavior).
#   npx wrangler kv namespace create APOLLO_KV
# then uncomment and paste the printed id:
# [[kv_namespaces]]
# binding = "APOLLO_KV"
# id = "<id>"
```

## Behavior

- **No KV bound (default):** `store = null` → `acquireSession(cfg, null)` = fresh
  login, `getDay(..., null)` = live calendar. Byte-for-byte today's stateless
  Worker. Zero behavior change.
- **KV bound:** the session cookie is cached in KV (validate-before-use each fire
  — one cheap `getLocations` GET instead of the 3-step login; a fresh login only
  ~1 per 9 days), and the calendar is cached (auto-refresh when stale/missing).
  Idempotency still comes from the server (`already_done`/`cooldown`).

## Testing

- `test/flow.test.ts`: add `getDay` cases — `store` truthy → uses `cachedDayInfo`, returns `{ info, source }`; `store` null → uses `getDayInfo`, returns `{ info }` with no `source`. Existing `runPunch` tests stay green (it now delegates to `getDay` but behavior is identical).
- `test/kv-store.test.ts` (new): a Map-backed fake `KVNamespace` (`get`/`put`); assert `read` returns stored string or null, and `write` persists — round-trip via `kvStore(fake)`.
- `test/scheduler.test.ts`: update existing tests to inject `acquireSession` (returns `{ session, source }`) and `getDay` (returns `{ info }`) instead of `login`/`getDayInfo`; all timing/notify assertions unchanged. Add one test passing a fake `store` and asserting it is forwarded to `acquireSession`/`getDay`.
- Existing suite stays green; `npm run typecheck` clean (KVNamespace type resolves via workers-types).

## Out of scope

- Actually creating/deploying a KV namespace (a user action; the binding ships commented).
- Any change to the CLI, the session-cache/calendar-cache cores, or the cron windows.
- Per-fire micro-optimization (e.g. skipping the session acquire on not-yet-time fires) — the scheduler acquires then gates, same shape as today.
