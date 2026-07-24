import { describe, it, expect, vi } from "vitest";
import { punch, jitterCoord } from "../src/punch";

const PUNCH_URL = "https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate";
const OFFICE_LAT = 25.0781415;
const OFFICE_LNG = 121.5703676;

const session: any = { cookie: "__ModuleSessionCookie=ABC123" };
const cfg: any = {
  latitude: String(OFFICE_LAT),
  longitude: String(OFFICE_LNG),
  gpsJitterMeters: 12,
  punchesLocationId: "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1",
  userAgent: "test-agent/1.0",
  dryRun: false,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Haversine distance in meters between two lat/lng points.
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: any, _init: any = {}) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("jitterCoord", () => {
  it("stays within `meters` of the origin over 200 iterations, and varies", () => {
    const meters = 12;
    const results: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < 200; i++) {
      const r = jitterCoord(OFFICE_LAT, OFFICE_LNG, meters);
      results.push(r);
      const d = haversine(OFFICE_LAT, OFFICE_LNG, r.lat, r.lng);
      expect(d).toBeLessThanOrEqual(meters + 0.01); // small epsilon for float/rounding
    }
    const distinct = new Set(results.map((r) => `${r.lat},${r.lng}`));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("punch", () => {
  it("clock-in success: returns success outcome with fields, and posts correct body", async () => {
    const f = mockFetch({
      Meta: { HttpStatusCode: "200" },
      Data: {
        AttendanceHistoryId: "AH",
        punchDate: "2026-07-23T11:07:11+00:00",
        LocationName: "台北辦公室",
      },
    });

    const result = await punch(session, cfg, "in", f as any);

    expect(result).toEqual({
      outcome: "success",
      attendanceHistoryId: "AH",
      punchDate: "2026-07-23T11:07:11+00:00",
      locationName: "台北辦公室",
    });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(PUNCH_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.cookie).toBe(session.cookie);
    expect(init.headers["user-agent"]).toBe(cfg.userAgent);

    const body = JSON.parse(init.body);
    expect(body.AttendanceType).toBe(1);
    expect(body.PunchesLocationId).toBe(cfg.punchesLocationId);
    expect(body.IdentifyCode).toMatch(UUID_RE);
    expect(body.LocationDetails).toBe("");
    const d = haversine(OFFICE_LAT, OFFICE_LNG, body.Latitude, body.Longitude);
    expect(d).toBeLessThanOrEqual(cfg.gpsJitterMeters + 0.01);
  });

  it("clock-out uses AttendanceType 2", async () => {
    const f = mockFetch({
      Meta: { HttpStatusCode: "200" },
      Data: { AttendanceHistoryId: "AH2", punchDate: "2026-07-23T11:07:11+00:00", LocationName: "台北辦公室" },
    });

    await punch(session, cfg, "out", f as any);

    const [, init] = f.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.AttendanceType).toBe(2);
  });

  it("already done: PT_TodayHas*Records error maps to already_done outcome", async () => {
    const f = mockFetch(
      {
        Meta: { HttpStatusCode: "400" },
        Error: { Status: "PT_TodayHasCheckInRecords", Title: "on duty record of the day has existed" },
      },
      400,
    );

    const result = await punch(session, cfg, "in", f as any);

    expect(result).toEqual({
      outcome: "already_done",
      detail: "on duty record of the day has existed",
    });
  });

  it("cooldown: PT_PlsDonotContinuousCheckIn maps to cooldown outcome (not failure)", async () => {
    const f = mockFetch(
      {
        Meta: { HttpStatusCode: "400" },
        Error: { Status: "PT_PlsDonotContinuousCheckIn", Title: "Do not check in/out continually, please check in/out again after 8 minutes" },
      },
      400,
    );

    const result = await punch(session, cfg, "in", f as any);

    expect(result).toEqual({
      outcome: "cooldown",
      detail: "Do not check in/out continually, please check in/out again after 8 minutes",
    });
  });

  it("failure: generic error maps to failure outcome with detail", async () => {
    const f = mockFetch(
      { Meta: { HttpStatusCode: "400" }, Error: { Status: "SH_Whatever", Title: "nope" } },
      400,
    );

    const result = await punch(session, cfg, "in", f as any);

    expect(result).toEqual({ outcome: "failure", detail: "nope" });
  });

  it("dry run: returns synthetic success without calling fetch", async () => {
    const f = mockFetch({});
    const dryCfg = { ...cfg, dryRun: true };

    const result = await punch(session, dryCfg, "in", f as any);

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.attendanceHistoryId).toBe("DRY_RUN");
      expect(result.locationName).toBe("DRY_RUN");
      expect(typeof result.punchDate).toBe("string");
    }
    expect(f).not.toHaveBeenCalled();
  });
});
