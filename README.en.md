# apolloxe-mayohr-punch

> **English** ・ [繁體中文](README.md)

**For the forgetful and the gloriously lazy — never miss a clock-in again.** 🕘

A little tool that punches you in/out of Apollo XE (MayoHR) so you don't have to,
driven by your own shift calendar. Its core logs in, reads Mayo's schedule for the
day, and punches via the GPS `/locate` endpoint (validates by location, not IP).
You run it from the CLI (`npm run punch in|out`). We also include an optional, thin
**Cloudflare Worker** for hands-off punch in/out automation: it uses your shift
calendar to punch at the right time (direction from time of day, timing from the
shift's start/end). The CLI reports via exit codes; the Worker marks a failed cron
run in Cloudflare.

## How it works

The core flow is **login → read today's calendar → punch**. Run it by hand and the
CLI does exactly that, on command. Run it automatically and the optional Worker
wraps that same core with cron timing:

```
login → read today's calendar → workday? ──no─→ skip (weekend/holiday)
                                   │yes
                                   ▼
                         on leave? ──(RESPECT_LEAVE=true)─→ skip
                                   │ default: no
                                   ▼
          clock in  = shiftStart − (buffer + random early)   → always EARLY
          clock out = shiftEnd   + random late               → always LATE
          each punch: GPS office coords + small random jitter, verified by the
          server's response (AttendanceHistoryId).
```

- **Stateless — no KV.** The Worker keeps no state. MayoHR itself is the source of
  truth: a second punch returns `already_done` (already punched today) or a
  `cooldown` (punched <~10 min ago), both of which the Worker treats as "done" and
  stays quiet. So the cron can fire every 5 min safely.
- **Reaction buffer:** clock-in is attempted `≥ REACTION_BUFFER_MIN` before your
  shift, so if it genuinely fails you find out (a failed run / exit code) with time to punch manually.
- Shift times come from Mayo's calendar, so flex/variable schedules just work.

> **Note.** Your company IP-restricts the *web* punch (office/VPN only). This uses
> the *GPS* punch, sending your office coordinates from a cloud server. That
> deliberately works around the office-only control — make sure you're comfortable
> that this is within your employer's policy before running it.

## Setup

```bash
npm install
```

1. **Credentials** — via env (`export`) or the config CLI (writes gitignored `.dev.vars`):
   ```bash
   export MAYO_USERNAME=you@company.com MAYO_PASSWORD=…    # or:
   npm run config set username you@company.com
   npm run config set password            # prompted, hidden — never argv/history
   ```
   Precedence is **env > `.dev.vars` > defaults**, so `export` overrides the file.
   The password is never taken as a CLI argument (it would leak to shell history / `ps`).

2. **Pick your punch location** (which office to report):
   ```bash
   npm run config set location                    # no id → lists your offices, then re-run with one:
   npm run config set location <PunchesLocationId>
   ```
   **The location id and the GPS coordinates must be the same office** — the punch
   sends both, and a mismatch can trip the office geofence. So set `pos` to match:
   ```bash
   npm run config set pos <lat> <lng>             # that office's real coordinates
   ```
   Run `npm run config` to see the effective values (password masked).

3. **Verify locally:**
   ```bash
   npm test          # unit tests
   npm run typecheck # tsc
   npm run punch in  # optional: a REAL end-to-end clock-in (or DRY_RUN=true to dry-run)
   ```

   `npm run punch` reads your shift from a local `calendar-cache.json` instead of
   hitting the calendar API every time. It auto-refreshes when the file is missing,
   older than 7 days, or doesn't cover today (caching the current + next month).
   The file is gitignored (your personal schedule) and human-readable — open it to
   verify your upcoming shifts.

### Caching & toggles

`punch` runs the shared `src/flow.runPunch` core (also callable by an Agent). Two
independent toggles, both **on** by default, set via `config` (or env
`CALENDAR_CHECK` / `SESSION_CACHE`):

- `npm run config set calendar on|off` — check today's shift (workday guard) before punching, or skip it.
- `npm run config set session on|off` — reuse the ~10-day login cookie (validated before use), or log in fresh each run.
- `npm run punch in -- --force` (`-f`) — skip the calendar check for that one run. (the `--` is required so npm forwards the flag to the script)
- `npm run config` shows the effective config, both toggles, password masked.
- `npm run calendar [YYYY-MM-DD]` — read-only: is that day a workday, and its shift? Never punches; exits `0` (workday) / `1` (not), `-- --json` for a summary line.

The session cookie lives in gitignored `session-cache.json` (mode 600); it's
reused across runs and re-validated by a cheap request, so a revoked cookie
never breaks a punch.

**Signals.** `npm run punch` exits `0` (ok: success/already_done/cooldown/skipped),
`1` (punch rejected — reason printed), `2` (usage), or `3` (couldn't run —
login/calendar/network). Add `-- --json` for a machine-readable summary line. The
Worker doesn't email; a failed punch **throws**, marking the cron invocation failed
in the Cloudflare dashboard / `wrangler tail` — wire a Cloudflare Notification if
you want to be alerted.

## Deploy the Worker (optional)

The Worker is optional. If you want hands-off automation, here's the safe path.
A Cloudflare **free plan is enough** (cron triggers are free).

1. **Authenticate** wrangler (opens a browser):
   ```bash
   npx wrangler login
   ```
2. **Set the two secrets** (interactive prompt; your password never touches a file or argv):
   ```bash
   npx wrangler secret put MAYO_USERNAME
   npx wrangler secret put MAYO_PASSWORD
   ```
3. **Deploy in DRY-RUN first.** `wrangler.toml` ships `DRY_RUN = "true"`, so it runs
   the whole flow (login → calendar → plan) but **never actually punches**:
   ```bash
   npx wrangler deploy
   ```
4. **Watch a real shift window.** Cron windows (Taipei): **08:00–09:55** (in) and
   **18:00–19:55** (out) — matching a 09:30–18:30 shift.
   ```bash
   npx wrangler tail
   ```
   The skip-reason logs show exactly what it's doing:
   ```
   apollo: 2026-07-31 09:00 — not time yet (09:00 < target 09:19)
   apollo: clock-in 2026-07-31 — recorded … (DRY_RUN)
   apollo: 2026-08-02 — skipped, not a workday
   ```
5. **Go live** — only once the DRY_RUN plan looks right. Flip the flag and redeploy:
   ```toml
   # wrangler.toml
   DRY_RUN = "false"
   ```
   ```bash
   npx wrangler deploy
   ```
   > ⚠️ This is the real thing — the Worker now actually auto-punches, unattended.
   > Sit on the DRY_RUN deploy for a day and read `tail` before you flip it.
6. **Verify the first real workday** via `wrangler tail`, and check Apollo shows
   exactly one in + one out.

> Being stateless, each cron fire does a fresh login + calendar read (≈ up to ~48
> logins/day across both windows). That's the trade for having no KV. If you want to
> cut that, narrow the `crons` windows in `wrangler.toml` to just around your shift.

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

## Configuration (all optional except secrets)

| Var | Default | Meaning |
|-----|---------|---------|
| `TIMEZONE` | `Asia/Taipei` | shift-time timezone |
| `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` | placeholder | reported coordinates — set yours |
| `PUNCHES_LOCATION_ID` | placeholder | office location id — set via `config set location` |
| `GPS_JITTER_METERS` | `12` | random shift radius per punch |
| `PUNCH_EARLY_IN_MIN` / `_MAX` | `1` / `15` | minutes early (on top of buffer) |
| `PUNCH_LATE_OUT_MIN` / `_MAX` | `1` / `15` | minutes late for clock-out |
| `REACTION_BUFFER_MIN` | `10` | clock in at least this many min before shift (so a failed run is visible with time to punch manually) |
| `RESPECT_LEAVE` | `false` | `true` = skip full-day-leave days |
| `DRY_RUN` | `true` | run the pipeline but never punch |

## Layout

- `src/` — `config`, `auth`, `calendar`, `punch`, `locations`, `time`,
  `calendar-cache`, `session-cache` (validate-before-use cookie cache),
  `cache-store` (shared `CacheStore`), `flow` (`runPunch`/`acquireSession`/`getDay` — the reusable core), `kv-store`
  (KV `CacheStore` for the Worker), `scheduler` + `index` (the Worker).
- `scripts/` — local CLI helpers, built on the **same `src/` modules** the Worker
  runs (so they can't drift from deployed behaviour): `punch-now.ts` (manual
  clock in/out), `calendar-cli.ts` (`npm run calendar` — read-only workday/shift
  lookup), `config-cli.ts` (`npm run config` / `config set` — writes
  `.dev.vars`, lists locations via `set location`), `dev-vars.ts` (pure `.dev.vars`
  editing) + `cache-fs.ts` (file-backed cache store), `_env.ts` (shared `.dev.vars`
  + config bootstrap; `APOLLO_DEV_VARS` overrides the file path).
