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
first fire of the day → read calendar → workday? ──no─→ save "skip" plan (weekend/holiday)
                                            │yes
                                            ▼
                    build plan for today (stored in KV):
                      clock in  = shiftStart − (buffer + random early)   → always EARLY
                      clock out = shiftEnd   + random late               → always LATE
                    (random offsets rolled ONCE, so the punch time is stable + human)

every fire → read today's plan from KV (no MayoHR call) → is a target due?
                                          │yes            │no → wait
                                          ▼
             punch (GPS office coords + jitter, verified by AttendanceHistoryId),
             mark it done in the plan so it won't punch twice.
```

- **KV-backed daily plan.** The cron fires every 10 min all day; the first fire
  reads that day's shift and writes a *plan* to KV, and later fires just read the
  plan — no login — punching only when a target time arrives. Because the plan
  comes from the *actual* calendar, **any schedule works** — different start/end
  every day, no fixed window to keep in sync. (KV is required.)
- **Idempotent.** MayoHR is still the source of truth: a second punch returns
  `already_done` or `cooldown`, both treated as "done", so nothing double-punches.
- **Reaction buffer:** clock-in is attempted `≥ REACTION_BUFFER_MIN` before your
  shift, so if it genuinely fails you find out (a failed run / exit code) with time to punch manually.

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

**Prerequisites:** a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
(the cron triggers this uses are on the free plan) and **Node.js 18+**. Run
`npm install` in the repo root first — every command below uses the repo's pinned
`wrangler` via `npx`, so there's nothing to install globally.

Then create your config from the template — `wrangler.toml` is gitignored, so your
office id / coords / login stay out of the repo:
```bash
cp wrangler.toml.example wrangler.toml
# then edit MAYO_USERNAME, PUNCHES_LOCATION_ID, PUNCH_LATITUDE / PUNCH_LONGITUDE
```

1. **Authenticate** wrangler (opens a browser):
   ```bash
   npx wrangler login
   ```
2. **Create the KV namespace** (required — the scheduler stores its daily plan and
   caches the cookie/calendar there) and paste the printed id into `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create APOLLO_KV
   # → copy the id into the [[kv_namespaces]] block in wrangler.toml
   ```
3. **Set the password secret** (the only secret — `MAYO_USERNAME` lives in
   `wrangler.toml`; the password never touches a file or argv):
   ```bash
   npx wrangler secret put MAYO_PASSWORD
   ```
4. **Deploy in DRY-RUN first.** `wrangler.toml` ships `DRY_RUN = "true"`, so it runs
   the whole flow (calendar → plan → decision) but **never actually punches**:
   ```bash
   npx wrangler deploy
   ```
5. **Watch a workday.** The cron fires every 10 min, all day — the interesting
   moments are your clock-in and clock-out targets:
   ```bash
   npx wrangler tail
   ```
   The logs show exactly what it's doing (times are Taipei):
   ```
   apollo: 2026-07-31 08:40 — waiting (in 09:14, out 18:37)
   apollo: clock-in 2026-07-31 — recorded … (DRY_RUN)
   apollo: 2026-07-31 13:00 — waiting (in 09:14 done, out 18:37)
   apollo: 2026-08-02 — skipped, not a workday
   ```
6. **Go live** — only once the DRY_RUN plan looks right. Flip the flag and redeploy:
   ```toml
   # wrangler.toml
   DRY_RUN = "false"
   ```
   ```bash
   npx wrangler deploy
   ```
   > ⚠️ This is the real thing — the Worker now actually auto-punches, unattended.
   > Sit on the DRY_RUN deploy for a day and read `tail` before you flip it.
7. **Verify the first real workday** via `wrangler tail`, and check Apollo shows
   exactly one in + one out.

> **How it stays cheap.** ~144 fires/day sounds like a lot, but only the *first*
> fire of the day reads the calendar, and only two fires actually punch — every
> other fire is a single KV read with no login. Well within Cloudflare's free
> 100k/day, and gentle on MayoHR.

### Worker gotchas

- **The Worker's name is the `name` field in `wrangler.toml`.** `npx wrangler tail`,
  `deploy`, and `delete` all key off it. If a command says *"This Worker does not
  exist"*, you're using a different name than what's deployed — run
  `npx wrangler tail <deployed-name>` with the actual name (find it in the
  Cloudflare dashboard).
- **Secrets are per-Worker.** If you rename the Worker (change `name`), the next
  `deploy` creates a *brand-new* Worker with **no secrets** — re-run
  `npx wrangler secret put MAYO_PASSWORD`, then
  `npx wrangler delete --name <old-name>` the old one so you don't have **two** crons
  punching.
- **The Cloudflare dashboard shows times in UTC** (Taipei = UTC+8). An event at
  "11:15" there is 19:15 Taipei. The Worker's own log lines print Taipei time, so
  read those when in doubt.

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
  (KV `CacheStore` for the Worker), `plan` (the Worker's per-day KV plan: targets + done-flags),
  `scheduler` + `index` (the Worker).
- `scripts/` — local CLI helpers, built on the **same `src/` modules** the Worker
  runs (so they can't drift from deployed behaviour): `punch-now.ts` (manual
  clock in/out), `calendar-cli.ts` (`npm run calendar` — read-only workday/shift
  lookup), `config-cli.ts` (`npm run config` / `config set` — writes
  `.dev.vars`, lists locations via `set location`), `dev-vars.ts` (pure `.dev.vars`
  editing) + `cache-fs.ts` (file-backed cache store), `_env.ts` (shared `.dev.vars`
  + config bootstrap; `APOLLO_DEV_VARS` overrides the file path).
