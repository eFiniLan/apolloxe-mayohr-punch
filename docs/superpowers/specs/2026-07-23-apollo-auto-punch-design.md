# Apollo / MayoHR Auto Punch — Design

**Date:** 2026-07-23
**Status:** Approved design, pending discovery session
**Target system:** Apollo XE (MayoHR) — `https://apolloxe.mayohr.com`

## Goal

Automatically clock in and clock out of Apollo/MayoHR on real workdays, using
Mayo's own calendar and shift schedule as the source of truth, running serverless
on a Cloudflare Worker. Notify the user by email on every success and on any
failure. **Everything the user might reasonably want to change is configurable —
nothing operationally significant is hardcoded.**

## Non-goals

- No UI / dashboard. Configuration is via Worker environment + Secrets.
- No multi-user support. One employee, one deployment.
- Does not attempt to defeat captcha or device attestation (Apollo's punch API
  currently requires neither).

## Ethical / risk note

This writes attendance records on the user's behalf with a submitted (spoofed)
GPS location. Whether that is acceptable is between the user and their employer's
policy. The "only punch on real workdays, and skip approved leave/business-trip"
logic exists specifically so the system does not create *false* records on days
the user is not actually working.

## Known API mechanics (to be confirmed in discovery)

- **Auth:** `POST https://auth.mayohr.com/token` with company code + employee ID +
  password → `access_token` (~5 day expiry), `refresh_token`.
- **Punch:** `POST https://pt.mayohr.com/api/checkin/punch/locate`
  - Headers: `authorization: Bearer <token>`,
    `content-type: application/x-www-form-urlencoded`,
    `user-agent: Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)`
  - Body: `AttendanceType` (1 = in, 2 = out), `Latitude`, `Longitude`,
    `PunchesLocationId` (UUID), `IdentifyCode` (UUID), `LocationDetails` (optional)
  - Response: `AttendanceHistoryId`, `LocationName`, `punchDate`
- **Calendar / shift:** Apollo personal calendar API returns, per day, whether it
  is a workday, any approved leave/business-trip, and scheduled `WorkOnTime` /
  `WorkOffTime`. Exact endpoint + shape captured in discovery.
- **Read-back:** Apollo attendance-record API for a given day, used to confirm a
  punch actually landed on the record (ground truth beyond the punch response).

## Architecture

One Cloudflare Worker triggered by Cron, backed by one KV namespace for per-day
state. No origin server. Runs within the free tier.

### Modules (each independently testable)

| Module      | Responsibility                                                        | Depends on |
|-------------|-----------------------------------------------------------------------|------------|
| `config`    | Load + validate all env/secrets into a typed config object            | env        |
| `auth`      | Log in, return a valid bearer token                                    | config     |
| `calendar`  | For a date, return `{ isWorkday, onLeave, shiftStart, shiftEnd }`      | auth       |
| `punch`     | POST a clock-in or clock-out                                           | auth, config |
| `verify`    | Read back the day's attendance record; confirm a punch is present     | auth       |
| `notify`    | Send email via Resend (success + failure)                             | config     |
| `state`     | Read/write the day's plan and punched flags in KV                     | KV         |
| `scheduler` | Per-fire orchestration tying the above together                       | all        |

### Per-fire flow (`scheduler`)

1. Compute "today" in the configured timezone (default `Asia/Taipei`).
2. Load today's plan from `state`.
   - **No plan yet** → call `calendar`:
     - not a workday, or on approved leave/business-trip → store a `skip` plan, stop.
     - workday → compute jittered targets from `shiftStart`/`shiftEnd` + configured
       jitter windows; store `active` plan `{ targetIn, targetOut, inDone:false, outDone:false }`.
   - **`skip` plan** → stop.
3. If `active` and `now >= targetIn` and `!inDone`:
   `auth` → `punch(in)` → `verify` → mark `inDone` → `notify` success.
4. If `active` and `now >= targetOut` and `!outDone`:
   `auth` → `punch(out)` → `verify` → mark `outDone` → `notify` success.
5. Any thrown error → `notify` failure; leave the flag unset so the next fire retries.

### Cron design

Cloudflare cron expressions are UTC; Taiwan is UTC+8. Fire every few minutes
across the configured morning and evening windows (default morning ≈ TW 08:00–09:30,
evening ≈ TW 17:30–19:30). KV flags make repeated fires idempotent — the system
never double-punches. The window bounds are configurable (see below); the cron
expressions in `wrangler.toml` are derived from them at deploy time.

## Configuration (all of it)

Split into **Secrets** (sensitive, `wrangler secret put`) and **vars** (non-sensitive,
`wrangler.toml` `[vars]` or dashboard). No operationally significant value is hardcoded.

### Secrets
- `MAYO_COMPANY_CODE`
- `MAYO_EMPLOYEE_ID`
- `MAYO_PASSWORD`
- `RESEND_API_KEY`

### Vars — identity / location
- `NOTIFY_TO` — destination email address
- `NOTIFY_FROM` — verified Resend sender
- `PUNCH_LATITUDE` (default `25.0781415`)
- `PUNCH_LONGITUDE` (default `121.5703676`)
- `PUNCHES_LOCATION_ID` (UUID, from discovery)
- `IDENTIFY_CODE` (UUID, from discovery)
- `LOCATION_DETAILS` (optional string)
- `USER_AGENT` (default `Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)`)

### Vars — timing
- `TIMEZONE` (default `Asia/Taipei`)
- `JITTER_IN_MIN` / `JITTER_IN_MAX` minutes relative to `shiftStart`
  (default `-5` / `0` → punch in up to 5 min early)
- `JITTER_OUT_MIN` / `JITTER_OUT_MAX` minutes relative to `shiftEnd`
  (default `+2` / `+15` → punch out 2–15 min late)
- `WINDOW_MORNING_START` / `WINDOW_MORNING_END` (TW local, drives morning cron)
- `WINDOW_EVENING_START` / `WINDOW_EVENING_END` (TW local, drives evening cron)
- `CRON_STEP_MINUTES` (default `5`)

### Vars — behavior toggles
- `RESPECT_LEAVE` (default `true`) — skip approved leave/business-trip days
- `RESPECT_HOLIDAYS` (default `true`) — honor Mayo's non-workday calendar
- `NOTIFY_ON_SUCCESS` (default `true`) — daily success confirmations (chosen: on)
- `NOTIFY_ON_FAILURE` (default `true`)
- `DRY_RUN` (default `false`) — plan + notify but never actually POST a punch
  (used to validate the whole pipeline safely before going live)

## Error handling

Every network step is wrapped. Failure classes and responses:

- **Login rejected** → failure email; retry next fire (may be a transient auth blip).
- **Calendar unreadable** → failure email; retry next fire. If it never resolves
  within the window, the day is simply not punched (fail-safe: no false record).
- **Punch non-200** → failure email; flag left unset → retry next fire.
- **Read-back mismatch** (punch "succeeded" but not on record) → failure email so
  the user can punch manually; treated as not-done so a retry is attempted.

Because fires repeat every few minutes across a wide window, a transient failure
self-heals well before the shift boundary matters.

## Testing strategy

- Unit-test each module against recorded fixtures from the discovery session
  (real request/response shapes, secrets redacted).
- `DRY_RUN=true` end-to-end test: exercises auth + calendar + planning + notify
  without writing any real punch.
- Idempotency test: simulate many fires in one day → exactly one in, one out.
- Non-workday / on-leave test: planner produces `skip`, no punch attempted.

## Open items — resolved in the discovery session

1. Exact `auth.mayohr.com/token` request body (grant type, field names).
2. Calendar endpoint URL + JSON shape (workday flag, leave, shift times).
3. Attendance read-back endpoint URL + shape.
4. Confirm `AttendanceType` values (1 = in, 2 = out).
5. The user's real `PUNCHES_LOCATION_ID` and `IDENTIFY_CODE`.

## Discovery checklist (next step)

On `apolloxe.mayohr.com`, DevTools → Network (preserve log), then:

1. Log out and log in → capture the token request/response.
2. Punch once manually → capture the `punch/locate` request (body + headers).
3. Open the calendar/attendance view → capture the calendar + record requests.
4. Save these (redacted) as fixtures for building and testing the modules.
