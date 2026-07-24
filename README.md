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

1. **Local credentials** — create `.dev.vars` in the project root (gitignored;
   also what `wrangler dev` reads). The CLI helpers below use it:
   ```
   MAYO_USERNAME=you@company.com
   MAYO_PASSWORD=your-password
   ```

2. **Pick your punch location** (which office to report):
   ```bash
   npm run locations
   ```
   Put the chosen `PunchesLocationId` into `wrangler.toml` → `PUNCHES_LOCATION_ID`,
   and set `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` to that office's coordinates.

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

- `src/` — `config`, `auth` (cookie/CSRF login), `calendar`, `punch` (GPS /locate),
  `notify` (Resend), `time`, `scheduler` (stateless per-fire logic), `index` (cron handler).
- `scripts/` — local CLI helpers, built on the **same `src/` modules** the Worker
  runs (so they can't drift from deployed behaviour): `punch-now.ts` (manual
  clock in/out), `list-locations.ts` (pick your `PUNCHES_LOCATION_ID`),
  `_env.ts` (shared `.dev.vars` + config bootstrap).
- `docs/` — the design spec, plan, and confirmed API facts.
