# Apollo/MayoHR Auto-Punch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that reads Mayo/Apollo's own calendar to decide when to clock in/out on real workdays, punches via Apollo's API, verifies via read-back, and emails on success/failure — fully config-driven.

**Architecture:** One Worker with a `scheduled()` (cron) handler backed by one KV namespace for per-day state. Each fire loads/creates the day's plan from Mayo's calendar, then punches in/out once the jittered target time passes. Idempotent via KV flags; retries transparently on the next fire.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, KV, Vitest (`@cloudflare/vitest-pool-workers`), Resend (transactional email).

## Global Constraints

- Runtime: Cloudflare Workers (V8 isolate) — no Node APIs; use Web `fetch`, `crypto`, `Intl`.
- Timezone default `Asia/Taipei`; all "today"/time math via `Intl`, never the raw UTC clock.
- Nothing operationally significant is hardcoded — every value in the spec's Configuration section is an env var or Secret (see Task 2). Defaults live in code; overrides via env.
- Punch coordinates default `25.0781415` / `121.5703676`.
- User-Agent default `Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)`.
- Secrets never committed; use `.dev.vars` (gitignored) locally and `wrangler secret put` in prod.
- TDD: every module lands with tests before it's wired in. Commit after each task.
- `DRY_RUN=true` must short-circuit every real punch POST.

---

## Phase 0 — Discovery (manual, produces fixtures)

### Task 0: Capture Apollo's real API shapes

This task is done **by the user in a browser**, not by a coding agent. Its deliverables (fixtures + api-facts) are consumed by Tasks 5–8. No code is written here.

**Files:**
- Create: `fixtures/auth-token.json` (login response, secrets redacted)
- Create: `fixtures/auth-request.md` (login request: URL, method, headers, body field names)
- Create: `fixtures/calendar.json` (raw response of the day/shift calendar query)
- Create: `fixtures/attendance-record.json` (raw response of the day's punch record)
- Create: `fixtures/punch-request.md` (the `punch/locate` request: full body + headers)
- Create: `docs/api-facts.md` (distilled facts filling the spec's "Open items")

- [ ] **Step 1: Open DevTools with logging preserved**

In Chrome on `https://apolloxe.mayohr.com`: DevTools → Network → enable **Preserve log** → filter **Fetch/XHR**.

- [ ] **Step 2: Capture login**

Log out, then log in. Find the `auth.mayohr.com/token` request. Copy request (method, headers, form/JSON body field names — redact the password) into `fixtures/auth-request.md`; copy the JSON response into `fixtures/auth-token.json` (redact `access_token`/`refresh_token` values, keep the *keys* and `expires_in`).

- [ ] **Step 3: Capture a manual punch**

Punch once manually. Find `pt.mayohr.com/api/checkin/punch/locate`. Copy the full request body (`AttendanceType`, `Latitude`, `Longitude`, `PunchesLocationId`, `IdentifyCode`, `LocationDetails`) and headers into `fixtures/punch-request.md`. **Record your real `PunchesLocationId` and `IdentifyCode`** — these become config values.

- [ ] **Step 4: Capture the calendar / shift schedule**

Open the attendance/calendar view for the current week. Find the request that returns per-day workday + shift info (look for `WorkOnTime`/`WorkOffTime`, leave/holiday flags). Save its URL to `docs/api-facts.md` and its full JSON to `fixtures/calendar.json`.

- [ ] **Step 5: Capture the attendance read-back**

Find the request returning today's punch records (the list showing your just-made punch). Save URL to `docs/api-facts.md`, JSON to `fixtures/attendance-record.json`.

- [ ] **Step 6: Fill in `docs/api-facts.md`**

Record, concretely: auth request body field names + grant type; token response field path for the bearer token; calendar endpoint URL + the exact JSON paths for `isWorkday`/leave/`shiftStart`/`shiftEnd`; punch endpoint confirmation of `AttendanceType` 1=in / 2=out; read-back endpoint URL + JSON path to the list of punches with their types + times.

- [ ] **Step 7: Commit fixtures**

```bash
git add fixtures docs/api-facts.md
git commit -m "chore: capture Apollo API fixtures from discovery session"
```

**STOP after Task 0.** The remaining tasks reference `docs/api-facts.md` for exact field names. If a captured field name differs from the assumed name in a later task, use the captured one — the fixture is ground truth.

---

## Phase 1 — Scaffold & Mayo-independent modules

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces: a deployable Worker whose `scheduled()` handler exists and a passing test harness.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "apollo-auto-punch",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.80.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `wrangler.toml`** (cron finalized in Task 10)

```toml
name = "apollo-auto-punch"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "STATE"
id = "REPLACE_WITH_KV_ID"

[vars]
TIMEZONE = "Asia/Taipei"
PUNCH_LATITUDE = "25.0781415"
PUNCH_LONGITUDE = "121.5703676"
USER_AGENT = "Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)"
DRY_RUN = "true"
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.toml" } } } },
});
```

- [ ] **Step 5: Write `src/index.ts` stub**

```ts
export interface Env {
  STATE: KVNamespace;
  [key: string]: unknown;
}

export default {
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // wired up in Task 9
  },
};
```

- [ ] **Step 6: Write `test/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import worker from "../src/index";
describe("worker module", () => {
  it("exports a scheduled handler", () => {
    expect(typeof worker.scheduled).toBe("function");
  });
});
```

- [ ] **Step 7: Install + run**

Run: `npm install && npm test`
Expected: smoke test PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold Cloudflare Worker project"
```

---

### Task 2: `config` module

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `type Config` and `loadConfig(env: Env): Config`. Fields: `timezone`, `companyCode`, `employeeId`, `password`, `resendApiKey`, `notifyTo`, `notifyFrom`, `latitude`, `longitude`, `punchesLocationId`, `identifyCode`, `locationDetails`, `userAgent`, `jitter: {inMin,inMax,outMin,outMax}`, `windows: {morningStart,morningEnd,eveningStart,eveningEnd}`, `respectLeave`, `respectHolidays`, `notifyOnSuccess`, `notifyOnFailure`, `dryRun`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  MAYO_COMPANY_CODE: "acme", MAYO_EMPLOYEE_ID: "e1", MAYO_PASSWORD: "p",
  RESEND_API_KEY: "re_x", NOTIFY_TO: "me@x.com", NOTIFY_FROM: "bot@x.com",
  PUNCHES_LOCATION_ID: "loc", IDENTIFY_CODE: "id",
} as any;

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const c = loadConfig(base);
    expect(c.timezone).toBe("Asia/Taipei");
    expect(c.latitude).toBe("25.0781415");
    expect(c.jitter.outMax).toBe(15);
    expect(c.dryRun).toBe(false);
    expect(c.respectLeave).toBe(true);
  });
  it("throws when a required secret is missing", () => {
    const { MAYO_PASSWORD, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/MAYO_PASSWORD/);
  });
  it("overrides defaults from env and parses numbers/bools", () => {
    const c = loadConfig({ ...base, DRY_RUN: "false", JITTER_OUT_MAX: "30", TIMEZONE: "UTC" });
    expect(c.timezone).toBe("UTC");
    expect(c.jitter.outMax).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/config.ts`**

```ts
import type { Env } from "./index";

export interface Config {
  timezone: string;
  companyCode: string; employeeId: string; password: string;
  resendApiKey: string; notifyTo: string; notifyFrom: string;
  latitude: string; longitude: string;
  punchesLocationId: string; identifyCode: string; locationDetails: string;
  userAgent: string;
  jitter: { inMin: number; inMax: number; outMin: number; outMax: number };
  windows: { morningStart: string; morningEnd: string; eveningStart: string; eveningEnd: string };
  respectLeave: boolean; respectHolidays: boolean;
  notifyOnSuccess: boolean; notifyOnFailure: boolean; dryRun: boolean;
}

function req(env: Env, k: string): string {
  const v = env[k];
  if (typeof v !== "string" || v === "") throw new Error(`Missing required config: ${k}`);
  return v;
}
function opt(env: Env, k: string, d: string): string {
  const v = env[k];
  return typeof v === "string" && v !== "" ? v : d;
}
function num(env: Env, k: string, d: number): number {
  const v = env[k];
  return typeof v === "string" && v !== "" ? Number(v) : d;
}
function bool(env: Env, k: string, d: boolean): boolean {
  const v = env[k];
  return typeof v === "string" && v !== "" ? v === "true" : d;
}

export function loadConfig(env: Env): Config {
  return {
    timezone: opt(env, "TIMEZONE", "Asia/Taipei"),
    companyCode: req(env, "MAYO_COMPANY_CODE"),
    employeeId: req(env, "MAYO_EMPLOYEE_ID"),
    password: req(env, "MAYO_PASSWORD"),
    resendApiKey: req(env, "RESEND_API_KEY"),
    notifyTo: req(env, "NOTIFY_TO"),
    notifyFrom: req(env, "NOTIFY_FROM"),
    latitude: opt(env, "PUNCH_LATITUDE", "25.0781415"),
    longitude: opt(env, "PUNCH_LONGITUDE", "121.5703676"),
    punchesLocationId: req(env, "PUNCHES_LOCATION_ID"),
    identifyCode: req(env, "IDENTIFY_CODE"),
    locationDetails: opt(env, "LOCATION_DETAILS", ""),
    userAgent: opt(env, "USER_AGENT", "Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)"),
    jitter: {
      inMin: num(env, "JITTER_IN_MIN", -5), inMax: num(env, "JITTER_IN_MAX", 0),
      outMin: num(env, "JITTER_OUT_MIN", 2), outMax: num(env, "JITTER_OUT_MAX", 15),
    },
    windows: {
      morningStart: opt(env, "WINDOW_MORNING_START", "08:00"),
      morningEnd: opt(env, "WINDOW_MORNING_END", "09:30"),
      eveningStart: opt(env, "WINDOW_EVENING_START", "17:30"),
      eveningEnd: opt(env, "WINDOW_EVENING_END", "19:30"),
    },
    respectLeave: bool(env, "RESPECT_LEAVE", true),
    respectHolidays: bool(env, "RESPECT_HOLIDAYS", true),
    notifyOnSuccess: bool(env, "NOTIFY_ON_SUCCESS", true),
    notifyOnFailure: bool(env, "NOTIFY_ON_FAILURE", true),
    dryRun: bool(env, "DRY_RUN", false),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts && git commit -m "feat: config loader with defaults and validation"
```

---

### Task 3: `state` module (KV plan + idempotency flags)

**Files:**
- Create: `src/state.ts`, `test/state.test.ts`

**Interfaces:**
- Produces:
  - `type DayPlan = { kind: "skip"; reason: string } | { kind: "active"; targetIn: string; targetOut: string; inDone: boolean; outDone: boolean }` (times are ISO strings).
  - `getPlan(kv, dateKey): Promise<DayPlan | null>`
  - `savePlan(kv, dateKey, plan): Promise<void>`
  - `dateKey` is the `YYYY-MM-DD` local date string (produced by `time` util, Task 9).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getPlan, savePlan, type DayPlan } from "../src/state";

describe("state", () => {
  it("returns null for an unseen day", async () => {
    expect(await getPlan(env.STATE, "2026-07-23")).toBeNull();
  });
  it("round-trips a plan", async () => {
    const p: DayPlan = { kind: "active", targetIn: "2026-07-23T01:00:00.000Z", targetOut: "2026-07-23T10:10:00.000Z", inDone: false, outDone: false };
    await savePlan(env.STATE, "2026-07-23", p);
    expect(await getPlan(env.STATE, "2026-07-23")).toEqual(p);
  });
});
```

(Add `test/env.d.ts` referencing `@cloudflare/vitest-pool-workers` so `cloudflare:test` `env` types resolve; the KV binding `STATE` comes from `wrangler.toml`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/state.ts`**

```ts
export type DayPlan =
  | { kind: "skip"; reason: string }
  | { kind: "active"; targetIn: string; targetOut: string; inDone: boolean; outDone: boolean };

const key = (dateKey: string) => `plan:${dateKey}`;

export async function getPlan(kv: KVNamespace, dateKey: string): Promise<DayPlan | null> {
  return kv.get<DayPlan>(key(dateKey), "json");
}

export async function savePlan(kv: KVNamespace, dateKey: string, plan: DayPlan): Promise<void> {
  // 3-day TTL: long enough to survive the day, short enough to self-clean.
  await kv.put(key(dateKey), JSON.stringify(plan), { expirationTtl: 60 * 60 * 24 * 3 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts test/env.d.ts && git commit -m "feat: KV-backed day plan state"
```

---

### Task 4: `notify` module (Resend email)

**Files:**
- Create: `src/notify.ts`, `test/notify.test.ts`

**Interfaces:**
- Consumes: `Config` (`resendApiKey`, `notifyTo`, `notifyFrom`, `notifyOnSuccess`, `notifyOnFailure`).
- Produces: `notify(cfg, { level: "success" | "failure"; subject: string; body: string }): Promise<void>`. Respects the on-success/on-failure toggles; posts to `https://api.resend.com/emails`. Uses an injectable `fetchImpl` param (default global `fetch`) so tests assert the request without network.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { notify } from "../src/notify";

const cfg: any = { resendApiKey: "re_x", notifyTo: "me@x.com", notifyFrom: "bot@x.com", notifyOnSuccess: true, notifyOnFailure: true };

describe("notify", () => {
  it("posts to Resend with auth + recipients", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await notify(cfg, { level: "success", subject: "S", body: "B" }, f as any);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as any).Authorization).toBe("Bearer re_x");
    const sent = JSON.parse(init.body);
    expect(sent.to).toBe("me@x.com");
    expect(sent.subject).toBe("S");
  });
  it("suppresses success email when notifyOnSuccess is false", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await notify({ ...cfg, notifyOnSuccess: false }, { level: "success", subject: "S", body: "B" }, f as any);
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notify.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/notify.ts`**

```ts
import type { Config } from "./config";

export interface Notification { level: "success" | "failure"; subject: string; body: string }

export async function notify(
  cfg: Config,
  n: Notification,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (n.level === "success" && !cfg.notifyOnSuccess) return;
  if (n.level === "failure" && !cfg.notifyOnFailure) return;

  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: cfg.notifyFrom,
      to: cfg.notifyTo,
      subject: n.subject,
      text: n.body,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/notify.ts test/notify.test.ts && git commit -m "feat: Resend email notifications"
```

---

## Phase 2 — Mayo integration (built against Task 0 fixtures)

> For every task in this phase: open `docs/api-facts.md` and use the **captured** URLs and field names. The code below uses the names known from research; if the fixture differs, the fixture wins — update the constant/path and the test's fixture import accordingly.

### Task 5: `auth` module

**Files:**
- Create: `src/auth.ts`, `test/auth.test.ts`

**Interfaces:**
- Consumes: `Config` (`companyCode`, `employeeId`, `password`, `userAgent`).
- Produces: `login(cfg, fetchImpl?): Promise<string>` returning a bearer `access_token`. Endpoint `https://auth.mayohr.com/token`. **Confirm the request body field names + grant type against `fixtures/auth-request.md`**, and the token JSON path against `fixtures/auth-token.json`.

- [ ] **Step 1: Write the failing test** (fixture-driven)

```ts
import { describe, it, expect, vi } from "vitest";
import { login } from "../src/auth";
const cfg: any = { companyCode: "acme", employeeId: "e1", password: "p", userAgent: "UA" };

describe("login", () => {
  it("returns the access_token from the token response", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "TOK", token_type: "bearer", expires_in: 431999 }), { status: 200 }));
    const tok = await login(cfg, f as any);
    expect(tok).toBe("TOK");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://auth.mayohr.com/token");
    expect(init.method).toBe("POST");
  });
  it("throws on non-200", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 401 }));
    await expect(login(cfg, f as any)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/auth.ts`** (adjust body fields per `fixtures/auth-request.md`)

```ts
import type { Config } from "./config";

export async function login(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<string> {
  // NOTE: field names below assumed from research — verify against fixtures/auth-request.md.
  const body = new URLSearchParams({
    grant_type: "password",
    username: cfg.employeeId,
    password: cfg.password,
    companyCode: cfg.companyCode,
  });
  const res = await fetchImpl("https://auth.mayohr.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": cfg.userAgent },
    body,
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const json = await res.json<{ access_token: string }>();
  if (!json.access_token) throw new Error("Login response missing access_token");
  return json.access_token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts && git commit -m "feat: Apollo auth/login"
```

---

### Task 6: `calendar` module

**Files:**
- Create: `src/calendar.ts`, `test/calendar.test.ts`

**Interfaces:**
- Consumes: bearer token, `Config` (`userAgent`, `respectLeave`, `respectHolidays`), a `dateKey`.
- Produces: `getDayInfo(token, cfg, dateKey, fetchImpl?): Promise<DayInfo>` where
  `type DayInfo = { isWorkday: boolean; onLeave: boolean; shiftStart: string | null; shiftEnd: string | null }` (`shiftStart/End` are `"HH:MM"` local). **Endpoint + JSON paths come from `docs/api-facts.md`; `fixtures/calendar.json` is the test input.**

- [ ] **Step 1: Write the failing test** (uses the real captured fixture)

```ts
import { describe, it, expect, vi } from "vitest";
import { getDayInfo } from "../src/calendar";
import calendarFixture from "../fixtures/calendar.json";
const cfg: any = { userAgent: "UA", respectLeave: true, respectHolidays: true };

describe("getDayInfo", () => {
  it("parses a workday with shift times from the captured fixture", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(calendarFixture), { status: 200 }));
    const info = await getDayInfo("TOK", cfg, "<A_WORKDAY_DATE_FROM_FIXTURE>", f as any);
    expect(info.isWorkday).toBe(true);
    expect(info.onLeave).toBe(false);
    expect(info.shiftStart).toMatch(/^\d{2}:\d{2}$/);
    expect(info.shiftEnd).toMatch(/^\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/calendar.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/calendar.ts`**

Implement against the captured shape. Fetch the calendar endpoint from `docs/api-facts.md` with `authorization: Bearer <token>` + `user-agent`. Find the entry whose date equals `dateKey`, then map its fields to `DayInfo`:
- `isWorkday`: true when Mayo marks the day a working day (honor `respectHolidays` — if false, treat every non-weekend as workday regardless of Mayo's holiday flag).
- `onLeave`: true when an approved leave/business-trip covers the day (only considered when `respectLeave` is true).
- `shiftStart`/`shiftEnd`: the `WorkOnTime`/`WorkOffTime` as `"HH:MM"`; `null` when not a workday.

```ts
import type { Config } from "./config";

export interface DayInfo { isWorkday: boolean; onLeave: boolean; shiftStart: string | null; shiftEnd: string | null }

const CALENDAR_URL = "REPLACE_FROM_api-facts.md";

export async function getDayInfo(token: string, cfg: Config, dateKey: string, fetchImpl: typeof fetch = fetch): Promise<DayInfo> {
  const res = await fetchImpl(CALENDAR_URL, {
    headers: { authorization: `Bearer ${token}`, "user-agent": cfg.userAgent },
  });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<any>();

  // Map the captured structure. Field paths below are placeholders to replace
  // with the concrete paths recorded in docs/api-facts.md.
  const day = findDay(data, dateKey);
  if (!day) throw new Error(`No calendar entry for ${dateKey}`);

  const isWorkday = cfg.respectHolidays ? Boolean(day.IsWorkday) : !isWeekend(dateKey);
  const onLeave = cfg.respectLeave ? Boolean(day.LeaveApproved) : false;
  return {
    isWorkday,
    onLeave,
    shiftStart: isWorkday ? toHHMM(day.WorkOnTime) : null,
    shiftEnd: isWorkday ? toHHMM(day.WorkOffTime) : null,
  };
}

function findDay(data: any, dateKey: string): any {
  const list: any[] = data?.Data?.Calendars ?? data?.Calendars ?? data?.Data ?? [];
  return list.find((d) => String(d.Date ?? d.date).startsWith(dateKey));
}
function toHHMM(v: string): string { return v.slice(11, 16); } // adjust to fixture time format
function isWeekend(dateKey: string): boolean {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/calendar.test.ts`
Expected: PASS. (Adjust `findDay`/`toHHMM` until the real fixture parses.)

- [ ] **Step 5: Commit**

```bash
git add src/calendar.ts test/calendar.test.ts && git commit -m "feat: parse Mayo calendar into DayInfo"
```

---

### Task 7: `punch` module

**Files:**
- Create: `src/punch.ts`, `test/punch.test.ts`

**Interfaces:**
- Consumes: bearer token, `Config`, a `direction: "in" | "out"`.
- Produces: `punch(token, cfg, direction, fetchImpl?): Promise<PunchResult>` where `type PunchResult = { attendanceHistoryId: string; punchDate: string; locationName: string }`. `direction` maps to `AttendanceType` 1/2 (**confirm in `docs/api-facts.md`**). Honors `cfg.dryRun` by returning a synthetic result without POSTing.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { punch } from "../src/punch";
const cfg: any = { latitude: "25.07", longitude: "121.57", punchesLocationId: "loc", identifyCode: "id", locationDetails: "", userAgent: "UA", dryRun: false };

describe("punch", () => {
  it("posts AttendanceType 1 for clock-in and returns the record", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ Data: { AttendanceHistoryId: "AH", PunchDate: "2026-07-23T01:03:00", LocationName: "HQ" } }), { status: 200 }));
    const r = await punch("TOK", cfg, "in", f as any);
    expect(r.attendanceHistoryId).toBe("AH");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://pt.mayohr.com/api/checkin/punch/locate");
    expect(String(init.body)).toContain("AttendanceType=1");
  });
  it("does not POST when dryRun is true", async () => {
    const f = vi.fn();
    const r = await punch("TOK", { ...cfg, dryRun: true }, "out", f as any);
    expect(f).not.toHaveBeenCalled();
    expect(r.attendanceHistoryId).toBe("DRY_RUN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/punch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/punch.ts`** (confirm response paths against `fixtures/attendance-record.json`)

```ts
import type { Config } from "./config";

export interface PunchResult { attendanceHistoryId: string; punchDate: string; locationName: string }

export async function punch(token: string, cfg: Config, direction: "in" | "out", fetchImpl: typeof fetch = fetch): Promise<PunchResult> {
  const attendanceType = direction === "in" ? 1 : 2;
  if (cfg.dryRun) return { attendanceHistoryId: "DRY_RUN", punchDate: new Date().toISOString(), locationName: "DRY_RUN" };

  const body = new URLSearchParams({
    AttendanceType: String(attendanceType),
    Latitude: cfg.latitude,
    Longitude: cfg.longitude,
    PunchesLocationId: cfg.punchesLocationId,
    IdentifyCode: cfg.identifyCode,
    LocationDetails: cfg.locationDetails,
  });
  const res = await fetchImpl("https://pt.mayohr.com/api/checkin/punch/locate", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": cfg.userAgent,
    },
    body,
  });
  if (!res.ok) throw new Error(`Punch ${direction} failed: ${res.status} ${await res.text()}`);
  const j = await res.json<any>();
  const d = j.Data ?? j;
  return { attendanceHistoryId: String(d.AttendanceHistoryId), punchDate: String(d.PunchDate ?? d.punchDate), locationName: String(d.LocationName ?? "") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/punch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/punch.ts test/punch.test.ts && git commit -m "feat: Apollo punch in/out with dry-run"
```

---

### Task 8: `verify` module (read-back)

**Files:**
- Create: `src/verify.ts`, `test/verify.test.ts`

**Interfaces:**
- Consumes: bearer token, `Config`, `dateKey`, `direction`.
- Produces: `verifyPunch(token, cfg, dateKey, direction, fetchImpl?): Promise<{ found: boolean; recordedTime: string | null }>`. Reads the day's attendance record (endpoint from `docs/api-facts.md`, fixture `fixtures/attendance-record.json`) and confirms a punch of the matching type exists. In `dryRun`, returns `{ found: true, recordedTime: null }`.

- [ ] **Step 1: Write the failing test** (fixture-driven)

```ts
import { describe, it, expect, vi } from "vitest";
import { verifyPunch } from "../src/verify";
import record from "../fixtures/attendance-record.json";
const cfg: any = { userAgent: "UA", dryRun: false };

describe("verifyPunch", () => {
  it("finds the clock-in in the day's record", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(record), { status: 200 }));
    const r = await verifyPunch("TOK", cfg, "<FIXTURE_DATE>", "in", f as any);
    expect(r.found).toBe(true);
    expect(r.recordedTime).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/verify.ts`** (map paths to the fixture)

```ts
import type { Config } from "./config";

const RECORD_URL = "REPLACE_FROM_api-facts.md";

export async function verifyPunch(
  token: string, cfg: Config, dateKey: string, direction: "in" | "out", fetchImpl: typeof fetch = fetch,
): Promise<{ found: boolean; recordedTime: string | null }> {
  if (cfg.dryRun) return { found: true, recordedTime: null };
  const res = await fetchImpl(RECORD_URL, { headers: { authorization: `Bearer ${token}`, "user-agent": cfg.userAgent } });
  if (!res.ok) throw new Error(`Read-back failed: ${res.status} ${await res.text()}`);
  const data = await res.json<any>();
  const type = direction === "in" ? 1 : 2;
  const punches: any[] = data?.Data?.Punches ?? data?.Punches ?? [];
  const match = punches.find((p) => Number(p.AttendanceType) === type && String(p.PunchDate ?? p.Date).startsWith(dateKey));
  return { found: Boolean(match), recordedTime: match ? String(match.PunchDate ?? match.Date) : null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify.test.ts`
Expected: PASS (adjust paths until the fixture matches).

- [ ] **Step 5: Commit**

```bash
git add src/verify.ts test/verify.test.ts && git commit -m "feat: attendance read-back verification"
```

---

## Phase 3 — Orchestration & deploy

### Task 9: `time` util + `scheduler`

**Files:**
- Create: `src/time.ts`, `src/scheduler.ts`, `test/time.test.ts`, `test/scheduler.test.ts`
- Modify: `src/index.ts` (wire `scheduled()` → `runScheduler`)

**Interfaces:**
- `time.ts` produces: `nowParts(tz): { dateKey: string; hhmm: string; iso: string }`; `atLocalTime(dateKey, hhmm, tz): string` (ISO instant for a local wall-clock time); `addJitterMinutes(hhmm, min, max): string` (deterministic given `Math.random`, returns `"HH:MM"`).
- `scheduler.ts` produces: `runScheduler(env, deps?): Promise<void>` where `deps` injects `{ login, getDayInfo, punch, verifyPunch, notify, now }` (all default to the real modules) so it's unit-testable. Orchestrates the per-fire flow from the spec.

- [ ] **Step 1: Write `test/time.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { nowParts, atLocalTime } from "../src/time";
describe("time", () => {
  it("computes local dateKey/hhmm for a fixed instant", () => {
    const p = nowParts("Asia/Taipei", new Date("2026-07-23T01:05:00Z")); // 09:05 TW
    expect(p.dateKey).toBe("2026-07-23");
    expect(p.hhmm).toBe("09:05");
  });
  it("atLocalTime maps TW wall time back to the right UTC instant", () => {
    expect(atLocalTime("2026-07-23", "09:00", "Asia/Taipei")).toBe("2026-07-23T01:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/time.test.ts` → FAIL.

- [ ] **Step 3: Write `src/time.ts`**

```ts
export function nowParts(tz: string, now: Date = new Date()): { dateKey: string; hhmm: string; iso: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}`, iso: now.toISOString() };
}

export function atLocalTime(dateKey: string, hhmm: string, tz: string): string {
  // Find the UTC instant whose local (tz) wall time equals dateKey+hhmm.
  const target = `${dateKey}T${hhmm}`;
  let guess = new Date(`${target}:00Z`).getTime();
  for (let i = 0; i < 3; i++) {
    const local = nowParts(tz, new Date(guess));
    const localMs = new Date(`${local.dateKey}T${local.hhmm}:00Z`).getTime();
    const wantMs = new Date(`${target}:00Z`).getTime();
    guess += wantMs - localMs;
  }
  return new Date(guess).toISOString();
}

export function addJitterMinutes(hhmm: string, min: number, max: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const offset = Math.floor(min + Math.random() * (max - min + 1));
  const total = h * 60 + m + offset;
  const hh = String(Math.floor(((total % 1440) + 1440) % 1440 / 60)).padStart(2, "0");
  const mm = String((((total % 60) + 60) % 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/time.test.ts` → PASS.

- [ ] **Step 5: Write `test/scheduler.test.ts`** (inject fakes; no network)

```ts
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { runScheduler } from "../src/scheduler";
import { getPlan } from "../src/state";

function baseEnv() {
  return { ...env, MAYO_COMPANY_CODE: "a", MAYO_EMPLOYEE_ID: "e", MAYO_PASSWORD: "p", RESEND_API_KEY: "re", NOTIFY_TO: "to@x", NOTIFY_FROM: "fr@x", PUNCHES_LOCATION_ID: "loc", IDENTIFY_CODE: "id", DRY_RUN: "true" } as any;
}

describe("runScheduler", () => {
  it("stores a skip plan and never punches on a non-workday", async () => {
    const punch = vi.fn();
    await runScheduler(baseEnv(), {
      login: async () => "TOK",
      getDayInfo: async () => ({ isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null }),
      punch, verifyPunch: vi.fn(), notify: vi.fn(),
      now: new Date("2026-07-23T01:05:00Z"),
    });
    expect(punch).not.toHaveBeenCalled();
    const plan = await getPlan(env.STATE, "2026-07-23");
    expect(plan?.kind).toBe("skip");
  });

  it("punches in once the in-target passes, and is idempotent across fires", async () => {
    const punch = vi.fn(async () => ({ attendanceHistoryId: "AH", punchDate: "x", locationName: "HQ" }));
    const deps = {
      login: async () => "TOK",
      getDayInfo: async () => ({ isWorkday: true, onLeave: false, shiftStart: "09:00", shiftEnd: "18:00" }),
      punch, verifyPunch: async () => ({ found: true, recordedTime: "09:00" }), notify: vi.fn(),
      now: new Date("2026-07-23T01:30:00Z"), // 09:30 TW, past a 09:00-ish in-target
    };
    await runScheduler(baseEnv(), deps);
    await runScheduler(baseEnv(), deps); // second fire same day
    expect(punch).toHaveBeenCalledTimes(1); // in only, exactly once
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `npx vitest run test/scheduler.test.ts` → FAIL (module not found).

- [ ] **Step 7: Write `src/scheduler.ts`**

```ts
import type { Env } from "./index";
import { loadConfig } from "./config";
import { getPlan, savePlan, type DayPlan } from "./state";
import { nowParts, atLocalTime, addJitterMinutes } from "./time";
import { login as realLogin } from "./auth";
import { getDayInfo as realGetDayInfo } from "./calendar";
import { punch as realPunch } from "./punch";
import { verifyPunch as realVerify } from "./verify";
import { notify as realNotify } from "./notify";

export interface Deps {
  login: typeof realLogin;
  getDayInfo: typeof realGetDayInfo;
  punch: typeof realPunch;
  verifyPunch: typeof realVerify;
  notify: typeof realNotify;
  now?: Date;
}

export async function runScheduler(env: Env, deps: Partial<Deps> = {}): Promise<void> {
  const d: Deps = { login: realLogin, getDayInfo: realGetDayInfo, punch: realPunch, verifyPunch: realVerify, notify: realNotify, ...deps };
  const cfg = loadConfig(env);
  const now = deps.now ?? new Date();
  const { dateKey, hhmm } = nowParts(cfg.timezone, now);

  try {
    let plan = await getPlan(env.STATE, dateKey);

    if (!plan) {
      const token = await d.login(cfg);
      const info = await d.getDayInfo(token, cfg, dateKey);
      if (!info.isWorkday || info.onLeave || !info.shiftStart || !info.shiftEnd) {
        plan = { kind: "skip", reason: !info.isWorkday ? "not a workday" : info.onLeave ? "on leave" : "no shift" };
      } else {
        plan = {
          kind: "active",
          targetIn: addJitterMinutes(info.shiftStart, cfg.jitter.inMin, cfg.jitter.inMax),
          targetOut: addJitterMinutes(info.shiftEnd, cfg.jitter.outMin, cfg.jitter.outMax),
          inDone: false, outDone: false,
        } as any;
      }
      await savePlan(env.STATE, dateKey, plan);
    }

    if (plan.kind !== "active") return;

    if (!plan.inDone && hhmm >= plan.targetIn) {
      await doPunch(env, cfg, d, dateKey, "in");
      plan.inDone = true;
      await savePlan(env.STATE, dateKey, plan);
    }
    if (!plan.outDone && hhmm >= plan.targetOut) {
      await doPunch(env, cfg, d, dateKey, "out");
      plan.outDone = true;
      await savePlan(env.STATE, dateKey, plan);
    }
  } catch (err) {
    await d.notify(cfg, { level: "failure", subject: "⚠️ Apollo auto-punch failed", body: String(err) });
    throw err;
  }
}

async function doPunch(env: Env, cfg: ReturnType<typeof loadConfig>, d: Deps, dateKey: string, dir: "in" | "out") {
  const token = await d.login(cfg);
  const res = await d.punch(token, cfg, dir);
  const check = await d.verifyPunch(token, cfg, dateKey, dir);
  if (!check.found) throw new Error(`Punch ${dir} not confirmed on record (id=${res.attendanceHistoryId})`);
  await d.notify(cfg, {
    level: "success",
    subject: `✅ Apollo clock-${dir} ${dateKey}`,
    body: `Clock-${dir} recorded. Mayo shows: ${check.recordedTime ?? res.punchDate} @ ${res.locationName}${cfg.dryRun ? " (DRY_RUN)" : ""}`,
  });
}
```

- [ ] **Step 8: Wire `src/index.ts`**

```ts
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
```

- [ ] **Step 9: Run all tests**

Run: `npm test`
Expected: every suite PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: time utils + per-fire scheduler orchestration"
```

---

### Task 10: Cron windows, deploy runbook, live cutover

**Files:**
- Modify: `wrangler.toml` (add `[triggers]` crons derived from the window vars)
- Create: `README.md` (setup + deploy + go-live runbook)

**Interfaces:** none (operational).

- [ ] **Step 1: Add cron triggers to `wrangler.toml`**

Windows default to TW 08:00–09:30 and 17:30–19:30 = UTC 00:00–01:30 and 09:30–11:30. Every 5 minutes:

```toml
[triggers]
crons = [
  "*/5 0-1 * * 1-5",
  "0,30 1 * * 1-5",
  "*/5 9-11 * * 1-5"
]
```

(If the window vars are changed, regenerate these expressions to match — they are the UTC projection of the TW windows.)

- [ ] **Step 2: Write `README.md`** — cover: `npm install`; `wrangler kv namespace create STATE` → paste id into `wrangler.toml`; `wrangler secret put` for the four secrets; set the location/identity vars from `docs/api-facts.md`; Resend sender verification; `npm test`.

- [ ] **Step 3: Create the KV namespace**

Run: `npx wrangler kv namespace create STATE`
Paste the returned id into `wrangler.toml`.

- [ ] **Step 4: Deploy in DRY_RUN**

Ensure `DRY_RUN = "true"`. Run: `npx wrangler deploy`. Then `npx wrangler tail` and confirm, across a real window, that it plans correctly and sends the DRY_RUN success email quoting a (synthetic) time — without creating a real punch.

- [ ] **Step 5: Go live**

Set `DRY_RUN = "false"` (or `wrangler secret`/var), redeploy. Watch the first real workday via `wrangler tail` and confirm the success email quotes Mayo's read-back time. Verify in Apollo that exactly one in + one out landed.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: cron triggers + deployment runbook"
```

---

## Self-review notes

- **Spec coverage:** auth (T5), calendar workday/leave/shift (T6), punch in/out + AttendanceType (T7), read-back verify (T8), Resend email success+failure (T4), KV idempotent state (T3), full config incl. all toggles + jitter + windows + DRY_RUN (T2), scheduler flow incl. skip/retry/notify (T9), cron + timezone (T9/T10), discovery (T0). All spec sections mapped.
- **Discovery dependency:** Tasks 5–8 depend on Task 0 outputs; each names the exact fixture/`api-facts.md` field to confirm, and its test consumes the captured fixture so drift from assumed field names surfaces immediately as a failing test.
- **Type consistency:** `Config`, `DayPlan`, `DayInfo`, `PunchResult`, and the `Deps` injection names are used identically across tasks.
