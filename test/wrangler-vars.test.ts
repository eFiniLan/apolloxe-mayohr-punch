import { describe, it, expect } from "vitest";
import { parseTomlVars, upsertTomlVar, upsertTomlVars } from "../scripts/wrangler-vars";

const SAMPLE = `name = "app"
compatibility_date = "2024-12-30"

[triggers]
crons = ["5 16 * * *"]

[vars]
TIMEZONE = "Asia/Taipei"
DRY_RUN = "false"               # "true" = dry-run
MAYO_USERNAME = "you@company.com"
PUNCH_LATITUDE = "25.0500000"
# REACTION_BUFFER_MIN = "10"     # commented placeholder
`;

describe("parseTomlVars", () => {
  it("reads active [vars] entries, ignoring comments and other tables", () => {
    const v = parseTomlVars(SAMPLE);
    expect(v).toEqual({
      TIMEZONE: "Asia/Taipei",
      DRY_RUN: "false", // inline comment stripped
      MAYO_USERNAME: "you@company.com",
      PUNCH_LATITUDE: "25.0500000",
    });
    expect(v.REACTION_BUFFER_MIN).toBeUndefined(); // commented → not active
    expect(v.crons).toBeUndefined(); // not in [vars]
  });
  it("returns {} when there is no [vars] table", () => {
    expect(parseTomlVars(`name = "app"\n[triggers]\ncrons = []\n`)).toEqual({});
  });
});

describe("upsertTomlVar", () => {
  it("replaces an existing key in place, only within [vars]", () => {
    const out = upsertTomlVar(SAMPLE, "PUNCH_LATITUDE", "11.1111111");
    expect(parseTomlVars(out).PUNCH_LATITUDE).toBe("11.1111111");
    expect(out).toContain(`PUNCH_LATITUDE = "11.1111111"`);
    expect(out).toContain(`crons = ["5 16 * * *"]`); // other tables untouched
  });
  it("inserts a new key under [vars] when absent", () => {
    const out = upsertTomlVar(SAMPLE, "SESSION_CACHE", "false");
    expect(parseTomlVars(out).SESSION_CACHE).toBe("false");
    expect(out).toContain(`SESSION_CACHE = "false"`);
  });
  it("does not touch a commented placeholder of the same name key elsewhere", () => {
    const out = upsertTomlVar(SAMPLE, "TIMEZONE", "UTC");
    // exactly one active TIMEZONE line, updated
    expect(out.match(/^TIMEZONE = /gm)?.length).toBe(1);
    expect(parseTomlVars(out).TIMEZONE).toBe("UTC");
  });
  it("creates a [vars] table if the file has none", () => {
    const out = upsertTomlVar(`name = "app"\n`, "MAYO_USERNAME", "e@x.com");
    expect(parseTomlVars(out).MAYO_USERNAME).toBe("e@x.com");
    expect(out).toContain("[vars]");
    expect(out.endsWith("\n")).toBe(true);
  });
  it("round-trips multiple entries", () => {
    const out = upsertTomlVars(SAMPLE, { PUNCH_LATITUDE: "1.5", PUNCH_LONGITUDE: "2.5" });
    const v = parseTomlVars(out);
    expect(v.PUNCH_LATITUDE).toBe("1.5");
    expect(v.PUNCH_LONGITUDE).toBe("2.5");
  });
});
