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

/** The tz offset (ms east of UTC) at a given instant, via Intl. */
function tzOffsetMs(tz: string, epoch: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour); // some engines emit "24" for midnight
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - epoch;
}

/**
 * Absolute epoch-ms for a wall-clock time in `tz`. `dateKey`="YYYY-MM-DD",
 * `hhmm`="HH:MM", plus optional whole seconds. Taiwan has no DST so this is
 * exact; DST zones are resolved at the target instant (one correction pass).
 */
export function zonedTimeToEpoch(dateKey: string, hhmm: string, tz: string, seconds = 0): number {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, m, seconds);
  const off1 = tzOffsetMs(tz, naive);
  const off2 = tzOffsetMs(tz, naive - off1); // re-resolve at the corrected instant (DST edges)
  return naive - off2;
}

/** The day after `dateKey` ("YYYY-MM-DD"), as a dateKey. */
export function nextDateKey(dateKey: string): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/** "HH:MM:SS" wall-clock in `tz` for an absolute instant (for logs). */
export function hhmmss(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epoch));
}
