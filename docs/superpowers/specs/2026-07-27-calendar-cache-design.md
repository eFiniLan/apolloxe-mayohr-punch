# Calendar cache for the manual punch command — design

**Date:** 2026-07-27
**Status:** approved, ready for planning

## Problem

`npm run punch in|out` (`scripts/punch-now.ts`) runs `login → getDayInfo → punch`
on every invocation. `getDayInfo` is a live calendar round trip (~350ms of a ~1s
run) whose only load-bearing job in the CLI is the `isWorkday` guard that refuses
to punch on a weekend/holiday. That network read repeats every punch even though
a month's schedule rarely changes.

Goal: serve the workday guard (and the shift-time display) from a local,
human-readable cache file so the common case does no calendar network call, while
staying correct and letting the user verify their schedule by eye.

Login still happens every punch (~500ms) — the punch itself needs the session, so
that is not removable. This change targets only the ~350ms calendar read.

## Scope

**CLI-only.** The cache lives in `scripts/` and is used solely by
`scripts/punch-now.ts`. The deployed Cloudflare Worker is unchanged: it is
stateless with no filesystem, and remains on live `getDayInfo`. Nothing in
`src/scheduler.ts` / `src/index.ts` behavior changes. (The Worker path is
currently unused but retained.)

## Refresh policy (option C: automatic + manual)

- **Automatic:** on a punch, the cache is refreshed if the file is missing, its
  `generatedAt` is older than **7 days**, or it does not contain **today**.
  A refresh re-fetches the current month + next month and rewrites the file.
- **Manual:** `npm run calendar:sync` forces a refresh on demand (for right after
  a known schedule change, without waiting for the 7-day window).

Correctness note: the "missing today ⇒ refresh" rule means the cache is always
correct for today regardless of horizon; it self-heals at month boundaries. The
7-day age bound caps how stale an already-cached day can be.

## Horizon

Cache **current month + next month** (2 months = 2 API calls per refresh; the
calendar endpoint is month-scoped). Correctness only needs *today*; the second
month exists so the user can see upcoming shifts in the file when verifying, and
so today is always present across a month boundary. No benefit to caching further
out (future schedules are more speculative and staler for no correctness gain).

## Architecture

Four pieces. `src/` stays the single source of truth for calendar parsing; the
cache reuses it rather than re-implementing.

### 1. Refactor `src/calendar.ts` — extract `getMonthInfo`

```ts
// New: return every day's DayInfo for one month.
export async function getMonthInfo(
  session: Session, cfg: Config, year: number, month: number,
  fetchImpl?: typeof fetch,
): Promise<Record<string, DayInfo>>   // keyed by "YYYY-MM-DD"
```

`getDayInfo` becomes a thin wrapper: call `getMonthInfo` for the month of
`dateKey`, return the one day (throwing "No calendar entry for <dateKey>" if
absent, as today). Pure refactor — external behavior of `getDayInfo` is
unchanged and its existing tests still pass. The per-day derivation
(`isWorkday`, `onLeave`, `shiftStart`, `shiftEnd`) moves into the per-entry
mapping inside `getMonthInfo`.

### 2. New `scripts/calendar-cache.ts`

```ts
export async function cachedDayInfo(
  session: Session, cfg: Config, dateKey: string,
): Promise<DayInfo>
```

- Read `calendar-cache.json` (repo root). If parseable, current (`generatedAt`
  within 7 days), and contains `dateKey` → return that day's `DayInfo` (built
  from the stored structured fields, no string parsing).
- Otherwise **refresh**: `getMonthInfo` for this month and next, write the file
  (see format), return the requested day.
- Uses the `session` the caller already holds (a refresh costs no extra login).

```ts
export async function syncCalendar(session: Session, cfg: Config): Promise<CacheFile>
```
Unconditional refresh (fetch 2 months, write file, return it). Used by both the
manual command and internally by `cachedDayInfo`'s refresh path.

**Fallback:** if reading the file throws (corrupt) or a refresh fetch throws,
`cachedDayInfo` falls back to a live `getDayInfo(session, cfg, dateKey)` and
returns that — a cache problem must never block a punch. (The failed write is
logged to stderr but not fatal.)

### 3. New `scripts/sync-calendar.ts` + `npm run calendar:sync`

`localConfig → login → syncCalendar → print a short summary` (months cached, day
count, file path). `package.json`: `"calendar:sync": "tsx scripts/sync-calendar.ts"`.

### 4. `scripts/punch-now.ts`

Replace `getDayInfo(session, cfg, dateKey)` with
`cachedDayInfo(session, cfg, dateKey)`. The `isWorkday` guard and shift-time
display are unchanged. Add a one-line note to output indicating whether the day
came from cache or a fresh fetch (nice-to-have for transparency).

## File format — `calendar-cache.json`

Repo root, gitignored (personal schedule), pretty-printed (2-space), keyed by
date so it reads like a table.

```json
{
  "generatedAt": "2026-07-27T19:30:00+08:00",
  "timezone": "Asia/Taipei",
  "months": ["2026-07", "2026-08"],
  "days": {
    "2026-07-27": {
      "workday": true,
      "onLeave": false,
      "shiftStart": "09:30",
      "shiftEnd": "18:30",
      "label": "Sun · work · 09:30-18:30"
    },
    "2026-08-01": {
      "workday": false,
      "onLeave": false,
      "shiftStart": null,
      "shiftEnd": null,
      "label": "Sat · off"
    }
  }
}
```

Field contract — **if the program reads it, it's a structured field; if a human
reads it, it's `label`. No field is both.**

- **Structured per-day (code reads these):** `workday`, `onLeave`, `shiftStart`,
  `shiftEnd` — map 1:1 to `DayInfo` (`shiftStart`/`shiftEnd` are `null` on
  non-workdays). No re-parsing of any display string.
- **Structured metadata (code reads):** `generatedAt` — an ISO-8601 timestamp,
  read for the 7-day staleness check (never a free-text string).
- **Human-only (code never reads):** `label` (weekday + work/off + shift range)
  per day, plus top-level `timezone` and `months` — present purely so the file
  is self-explanatory when skimmed.

`generatedAt` uses the local timezone offset for readability; staleness compares
it to now as absolute instants (parse → epoch ms), so the offset does not affect
the 7-day math.

## Testing

- **`getMonthInfo` refactor:** existing `getDayInfo` tests must stay green
  (behavior unchanged). Add a `getMonthInfo` test asserting a fixture month maps
  to the right per-day `DayInfo` map (workday, non-workday, and a whole-shift
  leave day).
- **`calendar-cache` staleness logic:** unit-test the decision function (fresh
  vs. >7-days-old vs. today-absent vs. missing-file) with an injected "now" and
  an injected file reader / `getMonthInfo`, so no real I/O or network. Assert:
  fresh+present ⇒ no refresh; stale ⇒ refresh; today-absent ⇒ refresh; corrupt
  file ⇒ fallback to live `getDayInfo`.
- Keep the impure-boundary-injection convention: file read/write, `now`, and the
  month fetch are injectable parameters with real defaults, like `fetchImpl` /
  `rand` elsewhere.

## Out of scope

- Worker/scheduler using the cache (it is stateless; no filesystem).
- Caching login sessions (a live bearer token on disk — deliberately not done).
- Any change to punch or notify behavior.
