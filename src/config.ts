import type { Env } from "./index";

export interface Config {
  timezone: string;
  // Auth: login uses the account EMAIL as userName; the email encodes the
  // tenant, so no separate company/employee code is needed.
  userName: string;
  password: string;
  userAgent: string;
  // GPS: the fixed office point, plus a small random shift applied per punch so
  // the reported location is never byte-identical (looks like real phone noise).
  latitude: string;
  longitude: string;
  gpsJitterMeters: number;
  punchesLocationId: string; // office punch location (from locations/EnableList)
  // Jitter magnitudes (positive, min clamped ≥1). The scheduler computes:
  //   clock-IN  = shiftStart − (reactionBufferMin + random(earlyIn))  → always EARLY
  //   clock-OUT = shiftEnd   + random(lateOut)                        → always LATE
  earlyIn: { min: number; max: number };
  lateOut: { min: number; max: number };
  // Clock-in is attempted at least this many minutes before the shift, so if it
  // genuinely fails you find out (a failed run / exit code) with time to punch manually.
  reactionBufferMin: number;
  respectLeave: boolean;
  dryRun: boolean;
  calendarCheck: boolean; // CLI: check today's shift before punching
  sessionCache: boolean; // CLI: reuse the cached session cookie
}

function req(env: Env, k: string): string {
  const v = env[k];
  if (typeof v !== "string" || v === "") throw new Error(`Missing required config: ${k}`);
  return v;
}
function opt(env: Env, k: string, d: string): string {
  const v = env[k];
  return typeof v === "string" && v !== "" ? v : d;
}
function num(env: Env, k: string, d: number): number {
  const v = env[k];
  return typeof v === "string" && v !== "" ? Number(v) : d;
}
function bool(env: Env, k: string, d: boolean): boolean {
  const v = env[k];
  return typeof v === "string" && v !== "" ? v === "true" : d;
}

// A jitter band of positive minutes; min forced ≥1, max forced ≥min.
function band(env: Env, minKey: string, maxKey: string, dMin: number, dMax: number) {
  const min = Math.max(1, num(env, minKey, dMin));
  const max = Math.max(min, num(env, maxKey, dMax));
  return { min, max };
}

export function loadConfig(env: Env): Config {
  return {
    timezone: opt(env, "TIMEZONE", "Asia/Taipei"),
    userName: req(env, "MAYO_USERNAME"),
    password: req(env, "MAYO_PASSWORD"),
    userAgent: opt(
      env,
      "USER_AGENT",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    ),
    latitude: opt(env, "PUNCH_LATITUDE", "25.0500000"),
    longitude: opt(env, "PUNCH_LONGITUDE", "121.5500000"),
    gpsJitterMeters: num(env, "GPS_JITTER_METERS", 12),
    // default = generic placeholder; set your office via `npm run config set location`
    punchesLocationId: opt(env, "PUNCHES_LOCATION_ID", "00000000-0000-0000-0000-000000000000"),
    earlyIn: band(env, "PUNCH_EARLY_IN_MIN", "PUNCH_EARLY_IN_MAX", 1, 15),
    lateOut: band(env, "PUNCH_LATE_OUT_MIN", "PUNCH_LATE_OUT_MAX", 1, 15),
    reactionBufferMin: Math.max(0, num(env, "REACTION_BUFFER_MIN", 10)),
    respectLeave: bool(env, "RESPECT_LEAVE", false),
    dryRun: bool(env, "DRY_RUN", false),
    calendarCheck: bool(env, "CALENDAR_CHECK", true),
    sessionCache: bool(env, "SESSION_CACHE", true),
  };
}
