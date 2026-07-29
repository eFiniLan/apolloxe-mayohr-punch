# Exit codes + throw-on-failure, drop Resend notify — design

**Date:** 2026-07-29
**Status:** approved (decisions settled), ready for spec review → planning

## Goal

Replace the Resend email notification subsystem with platform-native signaling:
the **CLI** reports via **exit codes** (+ an opt-in JSON line), the **Worker**
reports by **throwing on failure** (Cloudflare marks the cron invocation failed).
Both derive the pass/fail decision and the human reason from **one shared
classifier**, so they never drift. Delete `notify.ts`, the Resend/NOTIFY config,
and the CLI stubs.

Motivation: `notify.ts` is our own Resend call (Cloudflare can't send email), it's
Worker-only yet baked into the shared `Config` (forcing the CLI to stub 3 dummy
secrets), and exit codes / failed-invocations are the standard, dependency-free,
Agent-friendly way to signal. Retry is unaffected — the Worker's re-punch is the
5-minute cron cadence (stateless), independent of exit status; the CLI is one-shot
(caller decides). Server idempotency (`already_done`/`cooldown`) still prevents
double punches.

## Shared classifier (`src/punch.ts`)

Co-located with `PunchOutcome`:
```ts
export function summarize(
  direction: "in" | "out",
  outcome: PunchOutcome,
): { ok: boolean; reason: string } {
  // success       → ok:true,  reason "clock-in recorded <punchDate> @ <locationName>"
  // already_done  → ok:true,  reason "already clocked in (<detail>)"
  // cooldown      → ok:true,  reason "cooldown (<detail>)"
  // failure       → ok:false, reason "clock-in FAILED: <detail>"
}
```
`ok` means "nothing to worry about" (a punch happened or already had). `failure`
is the only `!ok` outcome. Both the CLI and the Worker call this — same reason
string, same decision, no drift.

## CLI — `scripts/punch-now.ts`

Exit codes (a small category set; the specific reason stays in the printed message):

| Exit | Meaning | Trigger |
|---|---|---|
| `0` | OK | `runPunch` returns `step:"skipped"`, or `summarize(...).ok` |
| `1` | punch rejected | `summarize(...).ok === false` (a `failure` outcome) |
| `2` | usage | bad CLI args (already the `process.exit(1)`→`2` for the usage branch) |
| `3` | couldn't run | `runPunch` threw (login/calendar/network) — caught in `punch-now` |

- Human output stays (the pretty lines + the reason). On a thrown error, print it and exit `3`.
- **`--json` / `-j`** flag: after the human output, print exactly one line to stdout:
  `{"step":"punched"|"skipped","outcome":"<outcome>|error","detail":"<reason>","exit":<N>}`.
  (Without `--json`, no JSON line — humans/`$?`-checkers are unaffected.)
- Wrap the `runPunch` call in try/catch to map a throw → exit `3` (+ optional JSON).

## Worker — `src/scheduler.ts`

- Remove the `notify` dep and all `notify(...)` calls.
- After the punch: `const { ok, reason } = summarize(direction, r);`
  - `ok` → `console.log(reason)` (shows in `wrangler tail`) and return (green invocation).
  - `!ok` → `throw new Error(reason)` (invocation marked failed → dashboard/tail/CF Notifications).
- The "missing shift time on a workday" branch, which currently notifies failure, instead `throw new Error(...)`.
- The outer `catch (err)` currently notifies then rethrows; now it just rethrows (no notify) — the throw is the signal.
- `Deps` drops `notify`; `runScheduler` no longer needs notify config.

## Config & cleanup

- **`src/config.ts`:** remove `resendApiKey`, `notifyTo`, `notifyFrom`, `notifyOnSuccess`, `notifyOnFailure` from `Config` and `loadConfig`.
- **`scripts/_env.ts`:** remove the `RESEND_API_KEY` / `NOTIFY_TO` / `NOTIFY_FROM` stubs.
- **Delete:** `src/notify.ts`, `test/notify.test.ts`.
- **`wrangler.toml` / README:** remove the `RESEND_API_KEY` / `NOTIFY_TO` / `NOTIFY_FROM` `wrangler secret put` lines; document the exit-code table and that Worker failure = a failed cron invocation (optionally wire Cloudflare Notifications).

## Testing

- `test/punch.test.ts`: `summarize` — success/already_done/cooldown → `ok:true` with the right reason; failure → `ok:false` with `clock-<dir> FAILED: <detail>`.
- `test/scheduler.test.ts`: replace notify assertions —
  - failure outcome → `await expect(runScheduler(...)).rejects.toThrow(<detail>)`.
  - success / already_done / cooldown → resolves without throwing; `punch` was called.
  - missing shift time → rejects/throws (was: notify failure).
  - the `Deps` no longer has `notify`; drop it from the test's `deps()` helper.
- `test/config.test.ts`: remove any assertions on the deleted notify fields; `loadConfig` no longer requires `RESEND_API_KEY`/`NOTIFY_*` (a base env without them still loads).
- CLI exit codes verified by a live/dry run (`DRY_RUN=true npm run punch out; echo $?` → 0; `--json` prints the line). No unit test for the entrypoint.
- Full suite green; `npm run typecheck` clean; the Worker's remaining behavior (timing/direction/skip) unchanged.

## Out of scope

- Any richer Worker alerting (Cloudflare Notifications setup is the user's, when/if deployed).
- Changing punch/calendar/session behavior beyond how success/failure is signaled.
- The CLI's human output format beyond adding the exit code + optional `--json`.
