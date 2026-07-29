# Apollo (apolloxe / MayoHR) — Confirmed API facts

Status: **auth, calendar, and punch all CONFIRMED against the live account** —
including real clock-in and clock-out from a non-office IP. The reverse-engineering
scripts this was derived from have been deleted; `src/` is now the only
implementation, and this document is its reference.

## Auth flow (Worker-portable, pure `fetch`)

All in `fetch` with a manual cookie jar; no browser needed.

1. **GET** `https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us`
   - Scrape hidden input `__RequestVerificationToken` from the HTML.
   - Keep the `__RequestVerificationToken` cookie (Set-Cookie).
2. **POST** `https://auth.mayohr.com/Token` (form-urlencoded), cookie from step 1:
   - `grant_type=password`, `userName=<email>`, `password=<secret>`,
     `locale=en-us`, `red=https://apolloxe.mayohr.com/ta`, `userStatus=1`,
     `__RequestVerificationToken=<scraped html value>`
   - Response JSON: `{ access_token, refresh_token, code, expires_in, token_type,
     userName, SelectCompanyRequired, UserStatus, ... }`. **We only need `code`.**
   - `code` is **single-use**.
3. **GET** `https://authcommon.mayohr.com/api/auth/checkticket?code=<code>`
   - **No `response_type` param** (that variant returns JSON id_token instead).
   - Follow redirects, absorbing Set-Cookie at each hop.
   - Sets cookie **`__ModuleSessionCookie`** (a JWT, ~10-day expiry) + `__ModuleSessionCookie2`, `ARRAffinity`, etc.
4. **All subsequent API calls** (calendar, punch, read-back): authenticate with
   the **cookie `__ModuleSessionCookie`** (plus the incap/ARRAffinity cookies from
   the jar). **No `Authorization` header.** `content-type: application/json`.

Failure modes seen: requesting `response_type=id_token` returns a JSON `id_token`
but does NOT set `__ModuleSessionCookie`; reusing an already-consumed `code` → 403;
calling calendar with `Authorization: <id_token>` → 500 (wrong mechanism).

The CLI reuses the `__ModuleSessionCookie` across runs via `src/session-cache.ts`
(gitignored `session-cache.json`, 9-day TTL). **Validate-before-use:** a cached
cookie is trusted only after a cheap authenticated GET (locations/EnableList)
succeeds; otherwise it re-logs-in. Toggle with `SESSION_CACHE` (default on). The
Worker does not cache sessions (stateless).

## Calendar / shift schedule — CONFIRMED

**GET** `https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling?year=<YYYY>&month=<M>`
(cookie auth). Response: `{ data: { calendars: [ ... ] } }`, one entry per day.

Per-day entry fields that matter:
- `date`: e.g. `"2026-07-23T00:00:00Z"` (day label).
- `shiftSchedule`:
  - `workOnTime` / `workOffTime`: **UTC ISO**. On unpunched days = scheduled
    time; on punched days = actual punch time. `null` on non-workdays.
  - `originalWorkOnTime` / `originalWorkOffTime`: the stable scheduled template
    (e.g. `01:30Z` = 09:30 Taipei, `10:30Z` = 18:30). May be `null` on some
    future days when it equals `workOnTime`.
  - `workSlots`: `[]` on non-workdays.
  - `shiftScheduleName`: e.g. `常日班`.
- `leaveSheets[]`: `{ leaveRequestFormId, leaveStartDatetime, leaveEndDatetime, status, leaveNames }`. `status: 50` = approved. Times are UTC ISO. May be **partial-day**.
- `tripSheets[]`: business trips (same idea).
- `overtimeSheets[]`, `calendarEvent` (holiday info; `null` on normal days).

The CLI `punch` command reads this through a local `calendar-cache.json`
(current + next month, refreshed when missing / >7 days old / missing today) via
`src/calendar-cache.ts`, a storage-agnostic core (`getMonthInfo` is the shared
parser) whose only I/O is an injected `CacheStore` — the CLI injects a file store
(`scripts/cache-fs.ts`). The deployed Worker does NOT cache — it stays stateless
and reads live each fire. If a Worker cache is ever wanted, inject a KV-backed
`CacheStore` and refresh in `ctx.waitUntil` (non-blocking); no core changes.

### Derivation rules for `DayInfo`
- Timezone: `Asia/Taipei` (UTC+8, no DST).
- `isWorkday` = `shiftSchedule?.workOnTime != null` (equivalently `workSlots.length > 0`).
- `shiftStart` = `originalWorkOnTime ?? workOnTime` → local `HH:MM`.
- `shiftEnd`   = `originalWorkOffTime ?? workOffTime` → local `HH:MM`.
- Leave/trip covering the day: an approved (`status 50`) `leaveSheets`/`tripSheets`
  entry whose `[start,end]` **covers the whole shift** ⇒ full-day off (skip).
  A partial entry ⇒ (default policy) still punch at scheduled shift times.

## Punch — CONFIRMED (GPS `/locate` endpoint, NOT IP-gated)

There are two punch endpoints, both cookie-auth (`__ModuleSessionCookie`):
- `POST …/backend/pt/api/checkIn/punch/web` — **IP-gated** (`SH_NonAuthorisedIP`
  from any non-office IP). No GPS in body. Useless for a cloud Worker unless it
  routes through the office VPN. Body `{AttendanceType, ExtendWorkHourType,
  CheckInTimeoutType, CheckInPersonalReasonTypeId, CheckInPersonalReason}`.
- **`POST …/backend/pt/api/checkIn/punch/locate` — GPS-gated, NOT IP-gated.**
  Confirmed working from a non-office IP (schema test returned a business-logic
  error, never `SH_NonAuthorisedIP`). **This is the endpoint the Worker uses.**

`/locate` request (JSON body, cookie auth, `content-type: application/json`):
```json
{
  "AttendanceType": 1,          // 1 = clock-in, 2 = clock-out (confirmed)
  "Latitude": 25.0781415,        // office coords + small per-punch jitter
  "Longitude": 121.5703676,
  "PunchesLocationId": "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1",  // 台北辦公室 (L001)
  "IdentifyCode": "<random uuid>",   // client-generated; a fresh crypto.randomUUID() is ACCEPTED
  "LocationDetails": ""          // optional
}
```
- Confirmed via a schema test (0,0 coords) that returned `PT_TodayHasCheckInRecords`
  — i.e. the full body validated and it only stopped at the already-clocked-in
  check. Field names + random IdentifyCode confirmed accepted.
- Punch locations: `GET …/backend/pt/api/locations/EnableList` →
  `Data[{PunchesLocationId, LocationCode, LocationName}]`. Office = L001.
- Server-side idempotency: rejects a duplicate clock-in (`PT_TodayHasCheckInRecords`)
  and presumably clock-out. **This IS the Worker's idempotency — there is no KV.**
- **~10-minute cooldown:** a punch within ~10 min of a previous one is rejected with
  `Error.Status = "PT_PlsDonotContinuousCheckIn"` (Title counts down the remaining
  minutes). Mapped to its own `cooldown` outcome. The **Worker** treats `cooldown`
  (and `already_done`) as a quiet no-op — "a punch already happened, nothing to do" —
  so firing every 5 min never re-punches or emails. The **manual `punch-now`** tool
  shows it as a failure (honest feedback to a human deliberately punching twice).
- Geofence radius not directly read, but the office radius (`radiusofEffectiveRange`)
  far exceeds the ±12 m GPS jitter, so jitter stays in-bounds. Always send the
  real office coords.
- Response envelope `{ Meta: { HttpStatusCode }, Data: {...} }`.

**GPS is required (user-confirmed).** The punch carries the office coordinates,
and each punch must apply a small random shift around the fixed point so the
location is never identical:
- Fixed point: `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` (config; default 25.0781415 / 121.5703676).
- Jitter: a uniform random point within `GPS_JITTER_METERS` (config, default 12 m)
  of the fixed point. Convert meters→degrees: `dLat = r·cosθ / 111320`,
  `dLng = r·sinθ / (111320·cos(lat))`, with `r = meters·√U`, `θ = 2π·U` (U~Uniform[0,1)).

## Scheduling / timing (as implemented in `src/scheduler.ts`)

- **Clock-in ALWAYS earlier, clock-out ALWAYS later**, with randomness inside
  those bounds — guaranteed by construction, not by checking afterwards:
  - `targetIn  = shiftStart − max(CRON_STEP_MIN, reactionBufferMin + random(earlyIn))`
  - `targetOut = shiftEnd   + random(lateOut)`
  - Jitter magnitudes are clamped ≥1 in `config.band()`. The `CRON_STEP_MIN` (5,
    matching `wrangler.toml` crons) floor guarantees a 5-minute tick lands inside
    `[targetIn, shiftStart)`, so the clock-in can never slip past the shift even
    if `reactionBufferMin`/`earlyIn` are configured very small.
- **Reaction buffer:** clock-in is time-critical, so it is attempted at least
  `reactionBufferMin` (default 10) before the shift. If it genuinely fails, the
  failure email arrives with time to punch manually, and the next cron fire retries.
- Clock-out is not time-critical, so it only needs "always later" — no buffer.
- **No escalation tier.** An earlier design had a separate URGENT email; the thin
  stateless refactor dropped it, since every failure already emails immediately
  and retries, and the early attempt supplies the buffer.
- Direction is derived from the time of day (`hhmm < "12:00"` ⇒ in, else out)
  rather than from stored state — this is what makes the Worker stateless.

The Worker shares the CLI's core: `src/scheduler.ts` calls `flow.acquireSession`
+ `flow.getDay` + `punch` (not `runPunch` whole — its timing gate sits between the
calendar read and the punch). It runs stateless unless a KV namespace (`APOLLO_KV`)
is bound, in which case it caches the session cookie (validate-before-use, 9-day
TTL) and calendar in KV via `src/kv-store.ts`.

## Punch response — CONFIRMED (a real clock-out succeeded)

A real `/locate` clock-out from a non-office IP returned:
```json
{ "Meta": { "HttpStatusCode": "200" },
  "Data": { "AttendanceHistoryId": "…", "punchDate": "2026-07-23T11:07:11+00:00",
            "LocationName": "台北辦公室", "Note": "" } }
```
So the punch is **self-verifying**: `Meta.HttpStatusCode === "200"` + a `Data.AttendanceHistoryId`
IS the confirmation. **No separate read-back endpoint is needed** — `verify` is
just interpreting the punch response.

### Punch result handling (stateless — no KV)
- `Meta.HttpStatusCode === "200"` with `AttendanceHistoryId` → `success` (email quotes
  `Data.punchDate` + `LocationName`).
- `Error.Status` matching `/^PT_TodayHas.*Records$/` → `already_done` → Worker stays quiet.
- `Error.Status === "PT_PlsDonotContinuousCheckIn"` → `cooldown` → Worker stays quiet.
- `Error.Status === "SH_NonAuthorisedIP"` → only happens on `/web`; must never occur
  on `/locate`. Falls through to `failure`.
- Any other `Error` / non-200 → `failure` (alert email; retries next fire).

### GPS jitter (confirmed accepted)
Uniform point within `gpsJitterMeters` of the office, rounded to 7 decimals:
`r = meters·√U; θ = 2π·U; dLat = r·cosθ/111320; dLng = r·sinθ/(111320·cos(lat))`.
A jittered pair (25.0781332, 121.5702674, ~12 m off) was accepted in-geofence.
