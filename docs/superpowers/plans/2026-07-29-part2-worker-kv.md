# Part 2 — Worker over shared core + opt-in KV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Worker reuse Part 1's shared building blocks (`acquireSession`, a new `getDay`, `punch`) instead of its own login/calendar copy, and let it optionally cache in Workers KV — enabled by binding a namespace, staying stateless (today's behavior) when unbound.

**Architecture:** Extract `getDay` from `runPunch` into `src/flow.ts` (shared cached-or-live calendar read). Refactor `src/scheduler.ts` to call `acquireSession`/`getDay` with an optional `store`, keeping all timing/notify logic. Add a ~4-line `src/kv-store.ts` KV adapter; `src/index.ts` passes a KV store iff `APOLLO_KV` is bound, else `null`.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), Cloudflare Workers KV, `wrangler`.

## Global Constraints

- **No KV bound → `store === null` → byte-for-byte today's stateless Worker.** This is the safety net; the "no-KV" path must not change behavior.
- `src/` stays free of `node:` imports. `KVNamespace` is a `@cloudflare/workers-types` global (tsconfig already has `"types": ["@cloudflare/workers-types/2023-07-01"]`) — not a `node:` import.
- **`runPunch`'s behavior and tests are unchanged** — it now delegates the calendar read to `getDay`, but the result (`dayInfo`/`calendarSource`) is identical.
- **The scheduler's timing/notify logic is unchanged** — only `login`→`acquireSession`, `getDayInfo`→`getDay`, plus an optional `store`. The early-in/late-out/`CRON_STEP_MIN` guarantees and all notify branches stay exactly as they are.
- The `wrangler.toml` KV binding ships **commented out** (stateless default).
- Every impure boundary stays injectable with a real default.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extract `getDay` in `src/flow.ts`

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export async function getDay(
    session: Session, cfg: Config, store: CacheStore | null, dateKey: string,
    deps?: { cachedDayInfo?: typeof cachedDayInfo; getDayInfo?: typeof getDayInfo },
  ): Promise<{ info: DayInfo; source?: "cache" | "fresh" }>
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/flow.test.ts` (it already imports from `../src/flow` and defines `WORK` and `SESSION`; extend the import to include `getDay`):
```ts
describe("getDay", () => {
  it("uses cachedDayInfo and returns {info, source} when a store is given", async () => {
    const cachedDayInfo = vi.fn(async () => ({ info: WORK, source: "cache" }));
    const getDayInfo = vi.fn();
    const r = await getDay(SESSION as any, {} as any, {} as any, "2026-07-29", {
      cachedDayInfo: cachedDayInfo as any, getDayInfo: getDayInfo as any,
    });
    expect(r).toEqual({ info: WORK, source: "cache" });
    expect(getDayInfo).not.toHaveBeenCalled();
  });
  it("uses live getDayInfo and returns {info} (no source) when store is null", async () => {
    const cachedDayInfo = vi.fn();
    const getDayInfo = vi.fn(async () => WORK);
    const r = await getDay(SESSION as any, {} as any, null, "2026-07-29", {
      cachedDayInfo: cachedDayInfo as any, getDayInfo: getDayInfo as any,
    });
    expect(r).toEqual({ info: WORK });
    expect(cachedDayInfo).not.toHaveBeenCalled();
  });
});
```
Change the top import line `import { acquireSession, runPunch } from "../src/flow";` to `import { acquireSession, runPunch, getDay } from "../src/flow";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "getDay"`
Expected: FAIL — `getDay` is not exported.

- [ ] **Step 3: Add `getDay` and delegate `runPunch` to it**

In `src/flow.ts`, add this exported function (place it right before `runPunch`):
```ts
/**
 * Today's DayInfo — cached when a store is given (auto-refresh on stale/missing),
 * live otherwise. Shared by runPunch and the Worker scheduler.
 */
export async function getDay(
  session: Session,
  cfg: Config,
  store: CacheStore | null,
  dateKey: string,
  deps: { cachedDayInfo?: typeof realCachedDayInfo; getDayInfo?: typeof realGetDayInfo } = {},
): Promise<{ info: DayInfo; source?: "cache" | "fresh" }> {
  if (store) {
    const r = await (deps.cachedDayInfo ?? realCachedDayInfo)(session, cfg, dateKey, store);
    return { info: r.info, source: r.source };
  }
  return { info: await (deps.getDayInfo ?? realGetDayInfo)(session, cfg, dateKey) };
}
```
Then in `runPunch`, replace this block:
```ts
    const { dateKey } = nowParts(cfg.timezone, now());
    let dayInfo: DayInfo;
    let calendarSource: "cache" | "fresh" | undefined;
    if (store) {
      const r = await (deps.cachedDayInfo ?? realCachedDayInfo)(session, cfg, dateKey, store);
      dayInfo = r.info;
      calendarSource = r.source;
    } else {
      dayInfo = await (deps.getDayInfo ?? realGetDayInfo)(session, cfg, dateKey);
    }
    if (!dayInfo.isWorkday) {
```
with:
```ts
    const { dateKey } = nowParts(cfg.timezone, now());
    const { info: dayInfo, source: calendarSource } = await getDay(session, cfg, store, dateKey, {
      cachedDayInfo: deps.cachedDayInfo,
      getDayInfo: deps.getDayInfo,
    });
    if (!dayInfo.isWorkday) {
```
Leave the two `return` statements below it (which use `dayInfo`, `calendarSource`, `sessionSource`) unchanged.

- [ ] **Step 4: Run the full flow test file to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS — the 2 new `getDay` tests plus all pre-existing `acquireSession`/`runPunch` tests (behavior unchanged).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "refactor(flow): extract getDay (shared cached-or-live calendar read)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: KV adapter — `src/kv-store.ts`

**Files:**
- Create: `src/kv-store.ts`
- Test: `test/kv-store.test.ts`

**Interfaces:**
- Consumes: `CacheStore` from `./cache-store`.
- Produces: `export function kvStore(ns: KVNamespace): CacheStore`.

- [ ] **Step 1: Write the failing test**

Create `test/kv-store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { kvStore } from "../src/kv-store";

// Map-backed fake of the KVNamespace bits we use.
function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
  } as unknown as KVNamespace;
}

describe("kvStore", () => {
  it("round-trips read/write and returns null for a missing key", async () => {
    const store = kvStore(fakeKV());
    expect(await store.read("k")).toBeNull();
    await store.write("k", "hello");
    expect(await store.read("k")).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/kv-store.test.ts`
Expected: FAIL — cannot resolve `../src/kv-store`.

- [ ] **Step 3: Create `src/kv-store.ts`**

```ts
import type { CacheStore } from "./cache-store";

/**
 * A Workers-KV-backed CacheStore for the deployed Worker. `ns` is the bound
 * KVNamespace (e.g. env.APOLLO_KV). Stores the same JSON strings the file store
 * does; KV's eventual consistency is fine (validate-before-use + TTL cover it).
 */
export function kvStore(ns: KVNamespace): CacheStore {
  return {
    read: (key) => ns.get(key),
    write: (key, contents) => ns.put(key, contents),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/kv-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (`KVNamespace` resolves via workers-types; `ns.get(key)` is `Promise<string|null>`, `ns.put(key, value)` is `Promise<void>` — both match `CacheStore`).

- [ ] **Step 6: Commit**

```bash
git add src/kv-store.ts test/kv-store.test.ts
git commit -m "feat(kv-store): Workers-KV-backed CacheStore adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Refactor `src/scheduler.ts` onto the shared primitives

**Files:**
- Modify: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `acquireSession`, `getDay` from `./flow`; `CacheStore` from `./cache-store`.
- Produces: `Deps` now has `acquireSession`, `getDay`, `punch`, `notify`, optional `store`, `now`, `rand` (replaces `login`/`getDayInfo`).

- [ ] **Step 1: Update the tests first (they define the new injection shape)**

In `test/scheduler.test.ts`, change the `deps()` helper's two lines:
```ts
    login: over.login ?? (vi.fn(async () => ({ cookie: "c" })) as any),
    getDayInfo: vi.fn(async () => over.dayInfo ?? WORKDAY) as any,
```
to:
```ts
    acquireSession: over.acquireSession ?? (vi.fn(async () => ({ session: { cookie: "c" }, source: "fresh" })) as any),
    getDay: vi.fn(async () => ({ info: over.dayInfo ?? WORKDAY })) as any,
```
Change the assertion in the "does not punch before the target time" test:
```ts
    expect(d.getDayInfo).toHaveBeenCalledOnce();
```
to:
```ts
    expect(d.getDay).toHaveBeenCalledOnce();
```
Replace the "login throws" test with an "acquire throws" version:
```ts
  it("emails a failure and rethrows when acquiring the session throws", async () => {
    const acquireSession = vi.fn(async () => { throw new Error("login down"); });
    const d = deps({ now: tw(9, 20), acquireSession: acquireSession as any });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow("login down");
    expect(d.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "failure" }));
  });
```
And add a new test (inside the same `describe`) asserting the store is forwarded:
```ts
  it("forwards the store to acquireSession and getDay", async () => {
    const store = { read: vi.fn(), write: vi.fn() } as any;
    const d = deps({ now: tw(9, 20), store });
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).toHaveBeenCalledWith(expect.anything(), store);
    expect(d.getDay).toHaveBeenCalledWith(expect.anything(), expect.anything(), store, expect.anything());
  });
```

- [ ] **Step 2: Run the scheduler tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL — `Deps` has no `acquireSession`/`getDay`/`store`; the mocks don't match the still-`login`/`getDayInfo` implementation.

- [ ] **Step 3: Refactor `src/scheduler.ts`**

Replace the top imports:
```ts
import { login as realLogin } from "./auth";
import { getDayInfo as realGetDayInfo } from "./calendar";
```
with:
```ts
import { acquireSession as realAcquireSession, getDay as realGetDay } from "./flow";
import type { CacheStore } from "./cache-store";
```
Replace the `Deps` interface with:
```ts
export interface Deps {
  acquireSession: typeof realAcquireSession;
  getDay: typeof realGetDay;
  punch: typeof realPunch;
  notify: typeof realNotify;
  store?: CacheStore | null;
  now?: Date;
  rand?: () => number;
}
```
Replace the `const d = { ... }` defaults block:
```ts
  const d = {
    login: realLogin,
    getDayInfo: realGetDayInfo,
    punch: realPunch,
    notify: realNotify,
    ...deps,
  };
```
with:
```ts
  const d = {
    acquireSession: realAcquireSession,
    getDay: realGetDay,
    punch: realPunch,
    notify: realNotify,
    ...deps,
  };
```
Inside the `try`, replace:
```ts
    const session = await d.login(cfg);
    const info = await d.getDayInfo(session, cfg, dateKey);
```
with:
```ts
    const { session } = await d.acquireSession(cfg, d.store ?? null);
    const { info } = await d.getDay(session, cfg, d.store ?? null, dateKey);
```
Update the doc comment above `runScheduler`: change the "Stateless — no KV." sentence to "Stateless when `store` is null (the default); with a KV `store` bound it reuses the cached cookie/calendar. The server is still the source of truth". Leave everything else (direction, boundary, target math, `hhmm < target` gate, punch, the success/already_done/cooldown/failure notify branches, the catch) unchanged.

- [ ] **Step 4: Run the scheduler tests to verify they pass**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS — all pre-existing timing/notify tests plus the new store-forward test.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass across the repo.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "refactor(scheduler): reuse acquireSession/getDay; add optional store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire KV into the Worker entry + wrangler binding

**Files:**
- Modify: `src/index.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: `kvStore` (`./kv-store`), `runScheduler` (`./scheduler`).

- [ ] **Step 1: Update `src/index.ts`**

Replace the whole file with:
```ts
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
```

- [ ] **Step 2: Add the commented KV binding to `wrangler.toml`**

Immediately after the `# Stateless — no KV.` line near the top (before the cron comment block), insert:
```toml
# Optional: cache the login cookie + calendar across fires (≈1 login / 9 days
# instead of ~48/day). Without this the Worker is stateless (server idempotency).
#   npx wrangler kv namespace create APOLLO_KV
# then uncomment and paste the printed id:
# [[kv_namespaces]]
# binding = "APOLLO_KV"
# id = "<id>"
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0 (`env.APOLLO_KV` typed `KVNamespace | undefined`; `Env`'s string index signature `unknown` accepts the named optional prop); all tests pass, including `test/smoke.test.ts` (worker still exports a `scheduled` function).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts wrangler.toml
git commit -m "feat(worker): pass a KV store when APOLLO_KV is bound (else stateless)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/api-facts.md`

- [ ] **Step 1: Update `README.md`**

In the `## Go live safely` section, after the stateless "≈ up to ~48 logins/day" blockquote, add:
```markdown
**Optional — cache across fires with KV.** Bind a KV namespace and the Worker
reuses the login cookie (≈1 login / 9 days instead of ~48/day) and the calendar,
via the same `runPunch` building blocks the CLI uses:
```bash
npx wrangler kv namespace create APOLLO_KV
# paste the printed id into the [[kv_namespaces]] block in wrangler.toml (uncomment it)
npx wrangler deploy
```
Unbound, the Worker stays stateless (today's behavior) — server-side idempotency
still prevents double punches either way.
```

In the `## Layout` `src/` bullet, add `kv-store`:
```markdown
  `flow` (`runPunch`/`acquireSession`/`getDay` — the reusable core), `kv-store`
  (KV `CacheStore` for the Worker), `scheduler` + `index` (the Worker).
```

- [ ] **Step 2: Update `docs/api-facts.md`**

Under the scheduling/timing section, add:
```markdown
The Worker shares the CLI's core: `src/scheduler.ts` calls `flow.acquireSession`
+ `flow.getDay` + `punch` (not `runPunch` whole — its timing gate sits between the
calendar read and the punch). It runs stateless unless a KV namespace (`APOLLO_KV`)
is bound, in which case it caches the session cookie (validate-before-use, 9-day
TTL) and calendar in KV via `src/kv-store.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/api-facts.md
git commit -m "docs: optional Worker KV caching over the shared runPunch core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **The "no KV" path must stay identical to today.** With `store` unset/null, `acquireSession(cfg, null)` = fresh login and `getDay(…, null)` = live `getDayInfo` — same calls the old scheduler made. The scheduler's timing/notify code is untouched.
- **Don't change `runPunch`'s observable behavior** in Task 1 — it just delegates the calendar read to `getDay`; `dayInfo`/`calendarSource`/the returned result are identical, so its existing tests stay green.
- **`KVNamespace` is a workers-types global**, not a `node:` import — `src/kv-store.ts` stays Workers-safe.
- No live/deploy step in this plan — KV namespace creation and `wrangler deploy` are the user's actions; the binding ships commented.
