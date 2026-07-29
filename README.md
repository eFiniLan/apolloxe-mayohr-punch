# apollo-auto-punch

A Cloudflare Worker that automatically clocks you in/out of Apollo XE (MayoHR),
driven by your own shift calendar. It logs in, reads Mayo's schedule for the day,
and punches via the GPS `/locate` endpoint (which validates by location, not IP —
so it works from Cloudflare's network). Emails you on success and failure.

## How it works (per cron fire)

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
  shift, so if it genuinely fails you get the failure email with time to punch manually.
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
   npm run config set location            # no id → lists your offices, then re-run with one:
   npm run config set location 0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1
   ```
   **The location id and the GPS coordinates must be the same office** — the punch
   sends both, and a mismatch can trip the office geofence. So set `pos` to match:
   ```bash
   npm run config set pos 25.0781415 121.5703676   # that office's real coordinates
   ```
   The default already pairs L001 台北辦公室 (`0e7d3f49…`) with the Taipei coords
   above, so if you punch from Taipei you can skip this step. Run `npm run config
   list` to see the effective values (password masked).

3. **Set deployed secrets** (separate from `.dev.vars`; never commit these):
   ```bash
   npx wrangler secret put MAYO_USERNAME     # your login email
   npx wrangler secret put MAYO_PASSWORD
   npx wrangler secret put RESEND_API_KEY    # from resend.com (free tier is plenty)
   npx wrangler secret put NOTIFY_TO         # where to email you
   npx wrangler secret put NOTIFY_FROM       # a verified Resend sender
   ```

4. **Verify locally:**
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

The session cookie lives in gitignored `session-cache.json` (mode 600); it's
reused across runs and re-validated by a cheap request, so a revoked cookie
never breaks a punch.

## Go live safely

`wrangler.toml` ships with `DRY_RUN = "true"` — the Worker runs the whole pipeline
(login, calendar, planning, email) but **never actually punches**.

```bash
npx wrangler deploy
npx wrangler tail          # watch a real morning/evening window
```
Confirm it plans correctly and sends a DRY_RUN success email. Then flip it live:

```toml
# wrangler.toml
DRY_RUN = "false"
```
```bash
npx wrangler deploy
```
Watch the first real workday via `wrangler tail`, confirm the success email quotes
Mayo's recorded time, and check Apollo shows exactly one in + one out.

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
| `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` | Taipei office | reported coordinates |
| `PUNCHES_LOCATION_ID` | `0e7d3f49…` (台北辦公室) | office location id |
| `GPS_JITTER_METERS` | `12` | random shift radius per punch |
| `PUNCH_EARLY_IN_MIN` / `_MAX` | `1` / `15` | minutes early (on top of buffer) |
| `PUNCH_LATE_OUT_MIN` / `_MAX` | `1` / `15` | minutes late for clock-out |
| `REACTION_BUFFER_MIN` | `10` | clock in at least this many min before shift (failure-email buffer) |
| `RESPECT_LEAVE` | `false` | `true` = skip full-day-leave days |
| `NOTIFY_ON_SUCCESS` / `NOTIFY_ON_FAILURE` | `true` / `true` | email toggles |
| `DRY_RUN` | `true` | plan + email but never punch |

## Layout

- `src/` — `config`, `auth`, `calendar`, `punch`, `locations`, `notify`, `time`,
  `calendar-cache`, `session-cache` (validate-before-use cookie cache),
  `cache-store` (shared `CacheStore`), `flow` (`runPunch`/`acquireSession`/`getDay` — the reusable core), `kv-store`
  (KV `CacheStore` for the Worker), `scheduler` + `index` (the Worker).
- `scripts/` — local CLI helpers, built on the **same `src/` modules** the Worker
  runs (so they can't drift from deployed behaviour): `punch-now.ts` (manual
  clock in/out), `config-cli.ts` (`npm run config` / `config set` — writes
  `.dev.vars`, lists locations via `set location`), `dev-vars.ts` (pure `.dev.vars`
  editing) + `cache-fs.ts` (file-backed cache store), `_env.ts` (shared `.dev.vars`
  + config bootstrap; `APOLLO_DEV_VARS` overrides the file path).
- `docs/` — the design spec, plan, and confirmed API facts.
