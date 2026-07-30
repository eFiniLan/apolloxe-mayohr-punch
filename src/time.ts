// Pure time helpers (no I/O). All "HH:MM" strings are local wall-clock time
// in whatever timezone the caller specifies (no minutes/seconds beyond the
// two given fields, no timezone offset embedded).

/**
 * Local date+time parts (in `tz`) for a given instant (default now).
 * `dateKey` is "YYYY-MM-DD" (via Intl "en-CA" which formats that way);
 * `hhmm` is "HH:MM" 24h (via Intl "en-GB" with hour12:false).
 */
export function nowParts(tz: string, now: Date = new Date()): { dateKey: string; hhmm: string } {
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return { dateKey, hhmm };
}

/** Add (or subtract) minutes to an "HH:MM", wrapping within a day (mod 1440). */
export function addMinutes(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = ((h * 60 + m + delta) % 1440 + 1440) % 1440;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

/** Inclusive random integer in [min,max]; `rand` injectable (default Math.random). */
export function randInt(min: number, max: number, rand: () => number = Math.random): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * True iff `s` is a real "YYYY-MM-DD" date. Rejects bad format AND rollovers —
 * e.g. `2026-02-30`, which the Date parser silently rolls forward to Mar 2.
 */
export function isValidDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}
