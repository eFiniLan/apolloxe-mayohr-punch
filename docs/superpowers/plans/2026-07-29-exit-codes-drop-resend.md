# Exit codes + throw-on-failure, drop Resend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Resend email subsystem with a shared `summarize()` classifier the CLI signals via exit codes (+ opt-in `--json`) and the Worker signals via `throw`. Delete `notify.ts`, its config, and the CLI stubs.

**Architecture:** One `summarize(direction, outcome) → {ok, reason}` in `src/punch.ts` used by both `scripts/punch-now.ts` (exit codes) and `src/scheduler.ts` (throw), so the reason never drifts. Retry is unchanged (Worker = 5-min cron cadence; CLI = one-shot); server idempotency still prevents double punches.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), `tsx` for CLI.

## Global Constraints

- **Exit codes:** `0` OK (success / already_done / cooldown / skipped), `1` punch rejected (`failure`), `2` usage (bad args), `3` couldn't run (a throw from login/calendar/network).
- **`ok` means "nothing to worry about"** — only a `failure` outcome is `!ok`.
- **CLI and Worker share `summarize()`** — identical reason strings, no drift.
- **Retry is untouched** — do not add/remove any retry logic; the Worker's throw only affects invocation *status*, not the cron cadence.
- `src/` stays free of `node:` imports.
- After this change `loadConfig` no longer requires `RESEND_API_KEY`/`NOTIFY_*`; the deployed Worker no longer needs those secrets.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Shared `summarize()` in `src/punch.ts`

**Files:**
- Modify: `src/punch.ts`
- Test: `test/punch.test.ts` (append)

**Interfaces:**
- Produces: `export function summarize(direction: "in" | "out", outcome: PunchOutcome): { ok: boolean; reason: string }`

- [ ] **Step 1: Write the failing test**

Append to `test/punch.test.ts`, and add `summarize` to the existing import from `../src/punch`:
```ts
describe("summarize", () => {
  it("success/already_done/cooldown are ok, with a reason", () => {
    expect(summarize("in", { outcome: "success", attendanceHistoryId: "A", punchDate: "09:20", locationName: "HQ" }))
      .toEqual({ ok: true, reason: "clock-in recorded 09:20 @ HQ" });
    expect(summarize("in", { outcome: "already_done", detail: "exists" }).ok).toBe(true);
    expect(summarize("out", { outcome: "cooldown", detail: "wait 8 min" }).ok).toBe(true);
  });
  it("failure is not ok and carries the detail", () => {
    const s = summarize("in", { outcome: "failure", detail: "SH_NonAuthorisedIP" });
    expect(s).toEqual({ ok: false, reason: "clock-in FAILED: SH_NonAuthorisedIP" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/punch.test.ts -t "summarize"`
Expected: FAIL — `summarize` is not exported.

- [ ] **Step 3: Add `summarize` to `src/punch.ts`**

Add after the `PunchOutcome` type definition (before `const PUNCH_URL`):
```ts
/**
 * Shared human summary + pass/fail of a punch outcome, used by both the CLI
 * (exit code + message) and the Worker (log + throw). `ok` means "nothing to
 * worry about" — a punch happened or already had; only `failure` is not ok.
 */
export function summarize(
  direction: "in" | "out",
  outcome: PunchOutcome,
): { ok: boolean; reason: string } {
  switch (outcome.outcome) {
    case "success":
      return { ok: true, reason: `clock-${direction} recorded ${outcome.punchDate} @ ${outcome.locationName}` };
    case "already_done":
      return { ok: true, reason: `already clocked ${direction} (${outcome.detail})` };
    case "cooldown":
      return { ok: true, reason: `cooldown (${outcome.detail})` };
    case "failure":
      return { ok: false, reason: `clock-${direction} FAILED: ${outcome.detail}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/punch.test.ts`
Expected: PASS (existing punch tests + the 2 new `summarize` tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/punch.ts test/punch.test.ts
git commit -m "feat(punch): shared summarize() classifier for CLI + Worker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Worker — `throw` on failure via `summarize` (drop notify)

**Files:**
- Modify: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `summarize` from `./punch`.
- Produces: `Deps` no longer has `notify`.

- [ ] **Step 1: Rewrite `test/scheduler.test.ts`'s `deps()` + affected tests first**

In `test/scheduler.test.ts`, remove `notify` from the `deps()` helper return (delete the `notify: vi.fn(...)` line). Then update the `describe("runScheduler ...")` tests so no test references `d.notify`. The full set of tests, updated:
```ts
  it("does nothing on a non-workday", async () => {
    const d = deps({ dayInfo: { isWorkday: false, onLeave: false, shiftStart: null, shiftEnd: null } });
    await runScheduler(baseEnv, d);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("skips full-day leave when RESPECT_LEAVE=true", async () => {
    const d = deps({ dayInfo: { ...WORKDAY, onLeave: true } });
    await runScheduler({ ...baseEnv, RESPECT_LEAVE: "true" }, d);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("still punches on a leave day when RESPECT_LEAVE=false (default)", async () => {
    const d = deps({ dayInfo: { ...WORKDAY, onLeave: true } });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("throws (fails the run) when a workday is missing its shift time", async () => {
    const d = deps({ dayInfo: { isWorkday: true, onLeave: false, shiftStart: null, shiftEnd: "18:30" } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/no scheduled/);
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("does not punch before the target time", async () => {
    const d = deps({ now: tw(9, 10) });
    await runScheduler(baseEnv, d);
    expect(d.getDay).toHaveBeenCalledOnce();
    expect(d.punch).not.toHaveBeenCalled();
  });

  it("clocks in past the target (resolves, no throw)", async () => {
    const d = deps({ now: tw(9, 20) });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "in");
  });

  it("stays quiet (no throw) on already_done", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "already_done", detail: "exists" } });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("stays quiet (no throw) on cooldown", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "cooldown", detail: "wait 8 minutes" } });
    await expect(runScheduler(baseEnv, d)).resolves.toBeUndefined();
    expect(d.punch).toHaveBeenCalledOnce();
  });

  it("throws on a genuine failure", async () => {
    const d = deps({ now: tw(9, 20), punchOutcome: { outcome: "failure", detail: "boom" } });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow(/boom/);
  });

  it("clocks OUT in the evening (direction from time of day)", async () => {
    const d = deps({ now: tw(18, 40) });
    await runScheduler(baseEnv, d);
    expect(d.punch).toHaveBeenCalledWith(expect.anything(), expect.anything(), "out");
  });

  it("rethrows when acquiring the session throws", async () => {
    const acquireSession = vi.fn(async () => { throw new Error("login down"); });
    const d = deps({ now: tw(9, 20), acquireSession: acquireSession as any });
    await expect(runScheduler(baseEnv, d)).rejects.toThrow("login down");
  });

  it("forwards the store to acquireSession and getDay", async () => {
    const store = { read: vi.fn(), write: vi.fn() } as any;
    const d = deps({ now: tw(9, 20), store });
    await runScheduler(baseEnv, d);
    expect(d.acquireSession).toHaveBeenCalledWith(expect.anything(), store);
    expect(d.getDay).toHaveBeenCalledWith(expect.anything(), expect.anything(), store, expect.anything());
  });
```
(Keep the file's imports, `baseEnv`, `tw`, `WORKDAY`, and the `deps()` signature; only remove the `notify` line inside `deps()` and use the tests above.)

- [ ] **Step 2: Run the scheduler tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL — the implementation still calls `d.notify` (undefined now) and doesn't throw on failure/missing-time.

- [ ] **Step 3: Rewrite `src/scheduler.ts`**

Replace the imports block:
```ts
import { punch as realPunch } from "./punch";
import { notify as realNotify } from "./notify";
```
with:
```ts
import { punch as realPunch, summarize } from "./punch";
```
Remove `notify: typeof realNotify;` from the `Deps` interface, and remove `notify: realNotify,` from the `const d = { ... }` defaults.

Update the doc comment's last two sentences ("Only a genuine failure emails …") to:
```
 * `cooldown` both mean "a punch already happened", so we stay quiet. A genuine
 * failure throws — marking the cron invocation failed (visible in the dashboard
 * / `wrangler tail`); success / already_done / cooldown return quietly.
```

Replace the whole `try { … } catch (err) { … }` block body (from `const { session } = …` through the end of the function) with this un-wrapped version (no try/catch — a thrown error propagates and marks the invocation failed):
```ts
  const { session } = await d.acquireSession(cfg, d.store ?? null);
  const { info } = await d.getDay(session, cfg, d.store ?? null, dateKey);

  if (!info.isWorkday) return; // weekend / holiday
  if (cfg.respectLeave && info.onLeave) return;

  // Clock-in needs the shift START; clock-out needs the shift END. A workday
  // missing the relevant time is an anomaly — fail the run rather than skip silently.
  const boundary = direction === "in" ? info.shiftStart : info.shiftEnd;
  if (!boundary) {
    throw new Error(
      `clock-${direction} ${dateKey}: workday but no scheduled ${direction === "in" ? "start" : "end"} time — punch manually`,
    );
  }

  const target =
    direction === "in"
      ? addMinutes(boundary, -Math.max(CRON_STEP_MIN, cfg.reactionBufferMin + randInt(cfg.earlyIn.min, cfg.earlyIn.max, rand)))
      : addMinutes(boundary, randInt(cfg.lateOut.min, cfg.lateOut.max, rand));

  if (hhmm < target) return; // not time yet

  const r = await d.punch(session, cfg, direction);
  const { ok, reason } = summarize(direction, r);
  if (!ok) throw new Error(`${reason} (${dateKey})`); // fails the invocation; retries next cron fire
  console.log(`apollo: clock-${direction} ${dateKey} — ${reason}${cfg.dryRun ? " (DRY_RUN)" : ""}`);
```
(The `target` comment block above it can stay as-is; only the `boundary`/`no scheduled time` and the post-punch block change.)

- [ ] **Step 4: Run the scheduler tests to verify they pass**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0. NOTE: `test/notify.test.ts` still exists and passes here (notify.ts is still present — it's deleted in Task 3). All green.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "refactor(scheduler): throw on failure via summarize; drop notify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Delete `notify.ts` + notify config + CLI stubs

Nothing imports `notify` after Task 2 (only `test/notify.test.ts`). Remove the module, its test, the config fields, and the CLI stubs.

**Files:**
- Delete: `src/notify.ts`, `test/notify.test.ts`
- Modify: `src/config.ts`, `scripts/_env.ts`

- [ ] **Step 1: Delete the notify module + test**

```bash
git rm src/notify.ts test/notify.test.ts
```

- [ ] **Step 2: Remove notify fields from `src/config.ts`**

In the `Config` interface, delete these lines:
```ts
  // Notify (Resend)
  resendApiKey: string;
  notifyTo: string;
  notifyFrom: string;
```
and:
```ts
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
```
In `loadConfig`, delete these returned lines:
```ts
    resendApiKey: req(env, "RESEND_API_KEY"),
    notifyTo: req(env, "NOTIFY_TO"),
    notifyFrom: req(env, "NOTIFY_FROM"),
```
and:
```ts
    notifyOnSuccess: bool(env, "NOTIFY_ON_SUCCESS", true),
    notifyOnFailure: bool(env, "NOTIFY_ON_FAILURE", true),
```
(Leave `req`/`opt`/`num`/`bool`/`band` — still used by the remaining fields.)

- [ ] **Step 3: Remove the stubs from `scripts/_env.ts`**

In `localConfig`, delete the three stub lines and their comment:
```ts
    // loadConfig requires these; the CLI helpers never send email, so stub them.
    RESEND_API_KEY: "unused",
    NOTIFY_TO: "unused@example.com",
    NOTIFY_FROM: "unused@example.com",
```
(Keep the `...dev` and `...process.env` spreads and the rest of the object.)

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0 (no references to the removed fields remain — `notify.ts` is gone, `scheduler.ts` no longer imports it, `config.test.ts` only *inputs* the env keys and never asserts the fields); all tests pass (notify test is gone).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts scripts/_env.ts
git commit -m "cleanup: delete notify.ts + Resend/NOTIFY config + CLI stubs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: CLI exit codes + `--json` in `scripts/punch-now.ts`

**Files:**
- Modify: `scripts/punch-now.ts` (full rewrite)

- [ ] **Step 1: Rewrite `scripts/punch-now.ts`**

```ts
// Manual punch, via the shared src/flow.runPunch — the same core an Agent (and
// the Worker) use. Makes a REAL punch unless DRY_RUN=true.
//
//   npm run punch in                 # clock in  (real)
//   npm run punch out                # clock out (real)
//   npm run punch in -- --force      # skip the calendar check this run (-f too; -- needed under npm)
//   npm run punch in -- --json       # also print one machine-readable JSON line (last line of output)
//   DRY_RUN=true npm run punch in     # dry run — no real punch
//
// Exit codes:  0 ok (success/already_done/cooldown/skipped) · 1 punch rejected ·
//              2 usage · 3 could not run (login/calendar/network error)
import { runPunch } from "../src/flow";
import { summarize } from "../src/punch";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const args = process.argv.slice(2);
const dir = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
const force = args.includes("--force") || args.includes("-f");
const asJson = args.includes("--json") || args.includes("-j");
if (dir !== "in" && dir !== "out") {
  console.error("Usage: npm run punch in|out [-- --force] [-- --json]   (DRY_RUN=true for a no-op)");
  process.exit(2);
}

/** Print the optional JSON summary line (stdout) and exit with the given code. */
function done(step: string, outcome: string, detail: string, code: number): never {
  if (asJson) console.log(JSON.stringify({ step, outcome, detail, exit: code }));
  process.exit(code);
}

const { cfg, credsFrom } = localConfig();

const nowStr = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
console.log("\x1b[1mApollo punch-now\x1b[0m (via src/flow.runPunch)");
console.log(`  direction : clock-${dir.toUpperCase()}${force ? "  \x1b[33m[--force: skip calendar]\x1b[0m" : ""}${cfg.dryRun ? "  \x1b[33m[DRY_RUN]\x1b[0m" : ""}`);
console.log(`  now       : ${nowStr} (${cfg.timezone})`);
console.log(`  account   : ${cfg.userName}  (creds from ${credsFrom})`);
console.log(`  location  : ${cfg.punchesLocationId}`);
console.log(`  coords    : ${cfg.latitude}, ${cfg.longitude}  (± ${cfg.gpsJitterMeters} m jitter)`);
console.log(`  toggles   : calendar=${cfg.calendarCheck ? "on" : "off"}  session=${cfg.sessionCache ? "on" : "off"}`);

try {
  const r = await runPunch(cfg, fileStore, { direction: dir as "in" | "out", force });

  console.log(`\n  session   : ${r.sessionSource}${r.calendarSource ? `   calendar : ${r.calendarSource}` : ""}`);
  if (r.dayInfo) {
    console.log(`  shift     : ${r.dayInfo.shiftStart ?? "--"}–${r.dayInfo.shiftEnd ?? "--"}  workday=${r.dayInfo.isWorkday}  onLeave=${r.dayInfo.onLeave}`);
  }

  if (r.step === "skipped") {
    console.log(`\n\x1b[33m⤼ Skipped: ${r.reason}. Not punching.\x1b[0m`);
    done("skipped", "skipped", r.reason ?? "", 0);
  }

  const o = r.outcome!;
  const { ok, reason } = summarize(dir as "in" | "out", o);
  const detail = "detail" in o ? o.detail : "";
  console.log("");
  console.log(ok ? `\x1b[32m✅ ${reason}\x1b[0m` : `\x1b[31m❌ ${reason}\x1b[0m`);
  done("punched", o.outcome, detail, ok ? 0 : 1);
} catch (e) {
  const msg = (e as Error).message;
  console.error(`\n\x1b[31m✖ could not run: ${msg}\x1b[0m`);
  done("error", "error", msg, 3);
}
```

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (no test imports punch-now).

- [ ] **Step 3: Live verification (real API; DRY_RUN, no real punch)**

```bash
DRY_RUN=true npm run punch out; echo "exit=$?"
```
Expected: prints the punch summary; `exit=0` (dry run returns a synthetic success). Then:
```bash
DRY_RUN=true npm run punch out -- --json; echo "exit=$?"
```
Expected: the last stdout line is a JSON object like `{"step":"punched","outcome":"success","detail":"","exit":0}`; `exit=0`. And a usage check:
```bash
npm run punch nonsense; echo "exit=$?"
```
Expected: usage message; `exit=2`.

- [ ] **Step 4: Commit**

```bash
git add scripts/punch-now.ts
git commit -m "feat(punch-cli): exit codes (0/1/2/3) + --json via shared summarize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs — README, CLAUDE.md, wrangler.toml

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `wrangler.toml`

- [ ] **Step 1: `README.md` — drop notify secrets, document exit codes**

Remove these three lines from the "Set deployed secrets" block:
```markdown
   npx wrangler secret put RESEND_API_KEY    # from resend.com (free tier is plenty)
   npx wrangler secret put NOTIFY_TO         # where to email you
   npx wrangler secret put NOTIFY_FROM       # a verified Resend sender
```
Remove the config-table row:
```markdown
| `NOTIFY_ON_SUCCESS` / `NOTIFY_ON_FAILURE` | `true` / `true` | email toggles |
```
In the Caching & toggles section (or near the punch usage), add:
```markdown
**Signals.** `npm run punch` exits `0` (ok: success/already_done/cooldown/skipped),
`1` (punch rejected — reason printed), `2` (usage), or `3` (couldn't run —
login/calendar/network). Add `-- --json` for a machine-readable summary line. The
Worker doesn't email; a failed punch **throws**, marking the cron invocation failed
in the Cloudflare dashboard / `wrangler tail` — wire a Cloudflare Notification if
you want to be alerted.
```

- [ ] **Step 2: `CLAUDE.md` — reflect no-notify architecture**

In the `src/` architecture bullets, replace the `notify` mention. Change:
```markdown
- **`scheduler.ts`, `time.ts`, `config.ts`, `notify.ts`** — orchestration, pure
  time math, env→Config, Resend email.
```
to:
```markdown
- **`scheduler.ts`, `time.ts`, `config.ts`** — orchestration, pure time math,
  env→Config. Success/failure is signaled by `punch.ts summarize()` — the CLI via
  exit codes, the Worker by throwing (no email).
```
If the "How it works" pipeline diagram ends in `→ email`, change that arrow to `→ exit code / throw`.

- [ ] **Step 3: `wrangler.toml` — drop notify from the secrets comment**

Change:
```toml
# here as needed. Secrets (MAYO_USERNAME, MAYO_PASSWORD, RESEND_API_KEY,
# NOTIFY_TO, NOTIFY_FROM) go via `wrangler secret put`, never here.
```
to:
```toml
# here as needed. Secrets (MAYO_USERNAME, MAYO_PASSWORD) go via
# `wrangler secret put`, never here.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md wrangler.toml
git commit -m "docs: exit-code signals, remove Resend/NOTIFY setup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Task order matters:** Task 2 must land before Task 3 — the scheduler has to stop importing `notify` before `notify.ts` is deleted, so the repo is green between tasks.
- **Retry is not touched.** The Worker's throw only changes the *invocation status*; the next cron fire still runs (stateless). Do not add retry logic.
- **`summarize` is the single source** of the reason string — the CLI and Worker both call it; don't inline a second copy.
- **`done()` in `punch-now` calls `process.exit`** (typed `never`), so the success path exits before the `catch`; the `catch` only fires on a thrown `runPunch`.
- The CLI's human output stays on stdout; the `--json` line is the **last** stdout line (an Agent reads the last line / the one starting with `{`).
