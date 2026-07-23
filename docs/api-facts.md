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

## Punch — PENDING (capture needed)

Likely `POST …/backend/pt/api/checkIn/punch/web` (or a platform-bff equivalent),
cookie auth (`__ModuleSessionCookie`), JSON body `{ "AttendanceType": 1|2 }`
(**1 = clock-in, 2 = clock-out**, confirmed by repos). No GPS fields seen in the
web-punch path. To confirm the exact endpoint/host/body for THIS account: capture
a real clock-out cURL. Response envelope expected `{ Meta: { HttpStatusCode }, Data: {...} }`.

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
