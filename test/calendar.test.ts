import { describe, it, expect, vi } from "vitest";
import { getDayInfo } from "../src/calendar";
import fixture from "../fixtures/calendar.json";

const cfg: any = {
  timezone: "Asia/Taipei",
  userAgent: "test-agent/1.0",
};
const session: any = { cookie: "__ModuleSessionCookie=ABC123" };

const CAL_URL_PREFIX =
  "https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling";

function mockFetch(status = 200, body: unknown = fixture) {
  return vi.fn(async (_url: any, _init: any = {}) => {
    if (status !== 200) {
      return new Response("server error", { status });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("getDayInfo", () => {
  it("workday (2026-07-23): originalWorkOnTime/Off drive shift times, no leave", async () => {
    const f = mockFetch();
    const info = await getDayInfo(session, cfg, "2026-07-23", f as any);
    expect(info).toEqual({
      isWorkday: true,
      onLeave: false,
      shiftStart: "09:30",
      shiftEnd: "18:30",
    });
  });

  it("weekend (2026-07-04): not a workday, null shift times", async () => {
    const f = mockFetch();
    const info = await getDayInfo(session, cfg, "2026-07-04", f as any);
    expect(info).toEqual({
      isWorkday: false,
      onLeave: false,
      shiftStart: null,
      shiftEnd: null,
    });
  });

  it("future workday (2026-07-24): originalWorkOnTime null, falls back to workOnTime", async () => {
    const f = mockFetch();
    const info = await getDayInfo(session, cfg, "2026-07-24", f as any);
    expect(info.isWorkday).toBe(true);
    expect(info.shiftStart).toBe("09:30");
    expect(info.shiftEnd).toBe("18:30");
  });

  it("partial-leave day (2026-07-03): a 2h mid-shift leave does NOT count as onLeave", async () => {
    const f = mockFetch();
    const info = await getDayInfo(session, cfg, "2026-07-03", f as any);
    expect(info.isWorkday).toBe(true);
    expect(info.shiftStart).toBe("09:30");
    expect(info.shiftEnd).toBe("18:30");
    expect(info.onLeave).toBe(false);
  });

  it("missing day: rejects with a clear error naming the date", async () => {
    const f = mockFetch();
    await expect(getDayInfo(session, cfg, "2026-08-15", f as any)).rejects.toThrow(
      /2026-08-15/,
    );
  });

  it("HTTP error: rejects when the calendar endpoint returns non-OK", async () => {
    const f = mockFetch(500);
    await expect(getDayInfo(session, cfg, "2026-07-23", f as any)).rejects.toThrow(/500/);
  });

  it("sends the session cookie and hits the URL with year/month derived from dateKey", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await getDayInfo(session, cfg, "2026-07-23", f as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CAL_URL_PREFIX}?year=2026&month=7`);
    const cookieHeader = calls[0].init.headers.cookie ?? calls[0].init.headers.Cookie;
    expect(cookieHeader).toBe(session.cookie);
  });
});
