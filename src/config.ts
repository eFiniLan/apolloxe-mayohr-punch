import type { Env } from "./index";

export interface Config {
  timezone: string;
  // Auth: login uses the account EMAIL as userName; the email encodes the
  // tenant, so no separate company/employee code is needed.
  userName: string;
  password: string;
  // Notify (Resend)
  resendApiKey: string;
  notifyTo: string;
  notifyFrom: string;
  userAgent: string;
  // GPS: the fixed office point, plus a small random shift applied per punch so
  // the reported location is never byte-identical (looks like real phone noise).
  latitude: string;
  longitude: string;
  gpsJitterMeters: number;
  punchesLocationId: string; // office punch location (from locations/EnableList)
  // Jitter, expressed as POSITIVE magnitudes so direction is guaranteed:
  //   clock-IN  = shiftStart − random(earlyIn.min..earlyIn.max)  → always EARLY
  //   clock-OUT = shiftEnd   + random(lateOut.min..lateOut.max)  → always LATE
  // min is clamped to ≥1 so it is never exactly on the scheduled boundary.
  earlyIn: { min: number; max: number };
  lateOut: { min: number; max: number };
  windows: { morningStart: string; morningEnd: string; eveningStart: string; eveningEnd: string };
  respectLeave: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  dryRun: boolean;
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
    resendApiKey: req(env, "RESEND_API_KEY"),
    notifyTo: req(env, "NOTIFY_TO"),
    notifyFrom: req(env, "NOTIFY_FROM"),
    userAgent: opt(
      env,
      "USER_AGENT",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    ),
    latitude: opt(env, "PUNCH_LATITUDE", "25.0781415"),
    longitude: opt(env, "PUNCH_LONGITUDE", "121.5703676"),
    gpsJitterMeters: num(env, "GPS_JITTER_METERS", 12),
    punchesLocationId: opt(env, "PUNCHES_LOCATION_ID", "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1"),
    earlyIn: band(env, "PUNCH_EARLY_IN_MIN", "PUNCH_EARLY_IN_MAX", 1, 15),
    lateOut: band(env, "PUNCH_LATE_OUT_MIN", "PUNCH_LATE_OUT_MAX", 1, 15),
    windows: {
      morningStart: opt(env, "WINDOW_MORNING_START", "08:00"),
      morningEnd: opt(env, "WINDOW_MORNING_END", "09:30"),
      eveningStart: opt(env, "WINDOW_EVENING_START", "17:30"),
      eveningEnd: opt(env, "WINDOW_EVENING_END", "19:30"),
    },
    respectLeave: bool(env, "RESPECT_LEAVE", false),
    notifyOnSuccess: bool(env, "NOTIFY_ON_SUCCESS", true),
    notifyOnFailure: bool(env, "NOTIFY_ON_FAILURE", true),
    dryRun: bool(env, "DRY_RUN", false),
  };
}
