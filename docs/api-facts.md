# Apollo (apolloxe / MayoHR) — Confirmed API facts

Status: **auth + calendar CONFIRMED against the live account** via `probe/probe.mjs`
(read-only, no writes). Punch + attendance read-back still pending.

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
  and presumably clock-out — a second safety net beyond our KV flags.
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
- The clock-out cURL will reveal the exact field names (`Latitude`/`Longitude`?)
  and whether `PunchesLocationId` / `IdentifyCode` are required — add those to
  config once known.

## Scheduling / timing requirements (from user — bake into the scheduler, Task 9)

- **Clock-in ALWAYS earlier, clock-out ALWAYS later**, with randomness inside
  those bounds. Guaranteed by construction: `targetIn = shiftStart −
  random(earlyIn.min..earlyIn.max)`, `targetOut = shiftEnd +
  random(lateOut.min..lateOut.max)`, magnitudes clamped ≥1 (see `config.ts`).
- **Reaction buffer for failures:** clock-in is time-critical. Keep a buffer so
  the user can punch manually if automation fails.
  - Attempt clock-in early (the earliness is buffer) and **retry** on each cron
    fire until `shiftStart`.
  - On ANY punch failure, email immediately (failure notification).
  - **Escalate:** if still not clocked in by `shiftStart − reactionBufferMin`
    (config, default ~10 min), send an URGENT "clock-in failed — punch manually"
    email so the user reacts before being late, while the Worker keeps retrying.
  - Clock-out is not time-critical (can punch out anytime after shift) → no
    escalation needed, just "always later".
- Config to add when building Task 9: `reactionBufferMin` (default 10). Consider
  raising `earlyIn` defaults so the first attempt has inherent buffer.

## Attendance read-back — PENDING

Endpoint that lists a day's actual punch records (for verify). URL + shape TBD
(one read-only XHR URL from the attendance page will settle it).
