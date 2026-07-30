import type { Session } from "./auth";
import type { Config } from "./config";

export type PunchOutcome =
  | { outcome: "success"; attendanceHistoryId: string; punchDate: string; locationName: string }
  | { outcome: "already_done"; detail: string } // server: a record already exists today → idempotent
  | { outcome: "cooldown"; detail: string } // server: punched <~10 min ago → a punch just happened
  | { outcome: "failure"; detail: string };

/**
 * Shared human summary + pass/fail of a punch outcome, used by both the CLI
 * (exit code + message) and the Worker (log + throw). `ok` means "nothing to
 * worry about" — a punch happened or already had; only `failure` is not ok.
 */
export function summarize(
  direction: "in" | "out",
  outcome: PunchOutcome,
): { ok: boolean; reason: string } {
  switch (outcome.outcome) {
    case "success":
      return { ok: true, reason: `clock-${direction} recorded ${outcome.punchDate} @ ${outcome.locationName}` };
    case "already_done":
      return { ok: true, reason: `already clocked ${direction} (${outcome.detail})` };
    case "cooldown":
      return { ok: true, reason: `cooldown (${outcome.detail})` };
    case "failure":
      return { ok: false, reason: `clock-${direction} FAILED: ${outcome.detail}` };
  }
}

const PUNCH_URL = "https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate";
const REFERER_URL = "https://apolloxe.mayohr.com/ta?id=webpunch";

const ALREADY_DONE_RE = /^PT_TodayHas.*Records$/;
const COOLDOWN_STATUS = "PT_PlsDonotContinuousCheckIn";

const METERS_PER_DEGREE_LAT = 111320;

/**
 * Uniform random point within `meters` of (lat, lng), rounded to 7 decimals.
 * `rand` is injectable (like time.randInt) so the jitter is testable.
 * (GPS jitter format confirmed against the live API.)
 */
export function jitterCoord(
  lat: number,
  lng: number,
  meters: number,
  rand: () => number = Math.random,
): { lat: number; lng: number } {
  const r = meters * Math.sqrt(rand());
  const t = rand() * 2 * Math.PI;
  const dLat = (r * Math.cos(t)) / METERS_PER_DEGREE_LAT;
  const dLng = (r * Math.sin(t)) / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return { lat: +(lat + dLat).toFixed(7), lng: +(lng + dLng).toFixed(7) };
}

interface PunchResponse {
  Meta?: { HttpStatusCode?: string };
  Data?: { AttendanceHistoryId?: string; punchDate?: string; LocationName?: string };
  Error?: { Status?: string; Title?: string };
}

/**
 * Clock in/out via the GPS `/locate` endpoint (not IP-gated). The response is
 * self-verifying: Meta.HttpStatusCode === "200" + Data.AttendanceHistoryId IS
 * the confirmation, so there is no separate read-back step.
 * (Endpoint + response shape confirmed against the live API.)
 */
export async function punch(
  session: Session,
  cfg: Config,
  direction: "in" | "out",
  fetchImpl: typeof fetch = fetch,
): Promise<PunchOutcome> {
  if (cfg.dryRun) {
    return {
      outcome: "success",
      attendanceHistoryId: "DRY_RUN",
      punchDate: new Date().toISOString(),
      locationName: "DRY_RUN",
    };
  }

  const officeLat = parseFloat(cfg.latitude);
  const officeLng = parseFloat(cfg.longitude);
  const { lat, lng } = jitterCoord(officeLat, officeLng, cfg.gpsJitterMeters);

  const body = {
    AttendanceType: direction === "in" ? 1 : 2,
    Latitude: lat,
    Longitude: lng,
    PunchesLocationId: cfg.punchesLocationId,
    IdentifyCode: crypto.randomUUID(),
    LocationDetails: "",
  };

  const res = await fetchImpl(PUNCH_URL, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "user-agent": cfg.userAgent,
      accept: "*/*",
      "accept-language": "en-us",
      "content-type": "application/json",
      origin: "https://apolloxe.mayohr.com",
      referer: REFERER_URL,
    },
    body: JSON.stringify(body),
  });

  // Read the raw body once so a failure can surface the server's full response
  // (MayoHR reports field-level validation detail beyond the one-line Title).
  const raw = await res.text();
  let json: PunchResponse;
  try {
    json = JSON.parse(raw) as PunchResponse;
  } catch {
    return { outcome: "failure", detail: `HTTP ${res.status}: ${raw.slice(0, 800)}` };
  }

  if (json.Meta?.HttpStatusCode === "200" && json.Data?.AttendanceHistoryId) {
    return {
      outcome: "success",
      attendanceHistoryId: json.Data.AttendanceHistoryId,
      punchDate: json.Data.punchDate ?? "",
      locationName: json.Data.LocationName ?? "",
    };
  }

  if (json.Error?.Status && ALREADY_DONE_RE.test(json.Error.Status)) {
    return { outcome: "already_done", detail: json.Error.Title ?? json.Error.Status };
  }

  if (json.Error?.Status === COOLDOWN_STATUS) {
    return { outcome: "cooldown", detail: json.Error.Title ?? json.Error.Status };
  }

  // Verbose on failure: the one-line Title (e.g. "You must fill in all the required
  // fields") rarely names the field, so also include the raw server response and
  // the location/coords we sent — the usual suspects. No secrets are in this body.
  const title = json.Error?.Title ?? `HTTP ${res.status}`;
  const sent = `sent PunchesLocationId=${cfg.punchesLocationId || "(empty)"} lat=${lat} lng=${lng}`;
  return { outcome: "failure", detail: `${title} | server=${raw.slice(0, 800)} | ${sent}` };
}
