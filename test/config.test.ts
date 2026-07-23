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
    expect(c.latitude).toBe("25.0781415");
    expect(c.longitude).toBe("121.5703676");
    expect(c.gpsJitterMeters).toBe(12);
    expect(c.punchesLocationId).toBe("0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1");
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
