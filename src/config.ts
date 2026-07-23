import type { Env } from "./index";

export interface Config {
  timezone: string;
  companyCode: string; employeeId: string; password: string;
  resendApiKey: string; notifyTo: string; notifyFrom: string;
  latitude: string; longitude: string;
  punchesLocationId: string; identifyCode: string; locationDetails: string;
  userAgent: string;
  jitter: { inMin: number; inMax: number; outMin: number; outMax: number };
  windows: { morningStart: string; morningEnd: string; eveningStart: string; eveningEnd: string };
  respectLeave: boolean; respectHolidays: boolean;
  notifyOnSuccess: boolean; notifyOnFailure: boolean; dryRun: boolean;
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

export function loadConfig(env: Env): Config {
  return {
    timezone: opt(env, "TIMEZONE", "Asia/Taipei"),
    companyCode: req(env, "MAYO_COMPANY_CODE"),
    employeeId: req(env, "MAYO_EMPLOYEE_ID"),
    password: req(env, "MAYO_PASSWORD"),
    resendApiKey: req(env, "RESEND_API_KEY"),
    notifyTo: req(env, "NOTIFY_TO"),
    notifyFrom: req(env, "NOTIFY_FROM"),
    latitude: opt(env, "PUNCH_LATITUDE", "25.0781415"),
    longitude: opt(env, "PUNCH_LONGITUDE", "121.5703676"),
    punchesLocationId: req(env, "PUNCHES_LOCATION_ID"),
    identifyCode: req(env, "IDENTIFY_CODE"),
    locationDetails: opt(env, "LOCATION_DETAILS", ""),
    userAgent: opt(env, "USER_AGENT", "Apollo HR XE/3.0.41 (iPhone; iOS 13.3; Scale/2.00)"),
    jitter: {
      inMin: num(env, "JITTER_IN_MIN", -5), inMax: num(env, "JITTER_IN_MAX", 0),
      outMin: num(env, "JITTER_OUT_MIN", 2), outMax: num(env, "JITTER_OUT_MAX", 15),
    },
    windows: {
      morningStart: opt(env, "WINDOW_MORNING_START", "08:00"),
      morningEnd: opt(env, "WINDOW_MORNING_END", "09:30"),
      eveningStart: opt(env, "WINDOW_EVENING_START", "17:30"),
      eveningEnd: opt(env, "WINDOW_EVENING_END", "19:30"),
    },
    respectLeave: bool(env, "RESPECT_LEAVE", true),
    respectHolidays: bool(env, "RESPECT_HOLIDAYS", true),
    notifyOnSuccess: bool(env, "NOTIFY_ON_SUCCESS", true),
    notifyOnFailure: bool(env, "NOTIFY_ON_FAILURE", true),
    dryRun: bool(env, "DRY_RUN", false),
  };
}
