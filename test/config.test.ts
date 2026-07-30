import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  MAYO_USERNAME: "me@example.com",
  MAYO_PASSWORD: "p",
  RESEND_API_KEY: "re_x",
  NOTIFY_TO: "me@x.com",
  NOTIFY_FROM: "bot@x.com",
} as any;

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const c = loadConfig(base);
    expect(c.timezone).toBe("Asia/Taipei");
    expect(c.earlyIn).toEqual({ min: 1, max: 15 });
    expect(c.lateOut).toEqual({ min: 1, max: 15 });
    expect(c.dryRun).toBe(false);
    expect(c.respectLeave).toBe(false);
    expect(c.userAgent).toContain("Mozilla/5.0");
    expect(c.latitude).toBe("25.0500000");
    expect(c.longitude).toBe("121.5500000");
    expect(c.gpsJitterMeters).toBe(12);
    expect(c.punchesLocationId).toBe("00000000-0000-0000-0000-000000000000");
    expect(c.reactionBufferMin).toBe(10);
  });

  it("throws when a required secret is missing", () => {
    const { MAYO_PASSWORD, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/MAYO_PASSWORD/);
  });

  it("throws when the login email is missing", () => {
    const { MAYO_USERNAME, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/MAYO_USERNAME/);
  });

  it("overrides defaults from env and parses numbers/bools", () => {
    const c = loadConfig({ ...base, DRY_RUN: "false", PUNCH_LATE_OUT_MAX: "30", TIMEZONE: "UTC" });
    expect(c.timezone).toBe("UTC");
    expect(c.lateOut.max).toBe(30);
  });

  it("guarantees jitter magnitudes stay >=1 even if misconfigured to 0", () => {
    const c = loadConfig({ ...base, PUNCH_EARLY_IN_MIN: "0", PUNCH_EARLY_IN_MAX: "0" });
    // Clamped so clock-in is ALWAYS at least 1 minute early, never on-the-dot.
    expect(c.earlyIn.min).toBe(1);
    expect(c.earlyIn.max).toBeGreaterThanOrEqual(1);
  });
});

describe("caching toggles", () => {
  const base = { MAYO_USERNAME: "u", MAYO_PASSWORD: "p", RESEND_API_KEY: "r", NOTIFY_TO: "a@b", NOTIFY_FROM: "c@d" };
  it("calendarCheck and sessionCache default to true", () => {
    const cfg = loadConfig(base as never);
    expect(cfg.calendarCheck).toBe(true);
    expect(cfg.sessionCache).toBe(true);
  });
  it("respects CALENDAR_CHECK/SESSION_CACHE = false", () => {
    const cfg = loadConfig({ ...base, CALENDAR_CHECK: "false", SESSION_CACHE: "false" } as never);
    expect(cfg.calendarCheck).toBe(false);
    expect(cfg.sessionCache).toBe(false);
  });
});
