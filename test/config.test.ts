import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  MAYO_COMPANY_CODE: "acme", MAYO_EMPLOYEE_ID: "e1", MAYO_PASSWORD: "p",
  RESEND_API_KEY: "re_x", NOTIFY_TO: "me@x.com", NOTIFY_FROM: "bot@x.com",
  PUNCHES_LOCATION_ID: "loc", IDENTIFY_CODE: "id",
} as any;

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const c = loadConfig(base);
    expect(c.timezone).toBe("Asia/Taipei");
    expect(c.latitude).toBe("25.0781415");
    expect(c.jitter.outMax).toBe(15);
    expect(c.dryRun).toBe(false);
    expect(c.respectLeave).toBe(true);
  });
  it("throws when a required secret is missing", () => {
    const { MAYO_PASSWORD, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/MAYO_PASSWORD/);
  });
  it("overrides defaults from env and parses numbers/bools", () => {
    const c = loadConfig({ ...base, DRY_RUN: "false", JITTER_OUT_MAX: "30", TIMEZONE: "UTC" });
    expect(c.timezone).toBe("UTC");
    expect(c.jitter.outMax).toBe(30);
  });
});
