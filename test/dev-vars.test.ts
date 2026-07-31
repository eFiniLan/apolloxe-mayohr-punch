import { describe, it, expect } from "vitest";
import { upsertEnvVar, upsertEnvVars, removeEnvVars, buildEntries, normalizeBool, BOOLEAN_FIELDS } from "../scripts/dev-vars";

describe("upsertEnvVar", () => {
  it("appends when the key is absent, preserving existing lines", () => {
    expect(upsertEnvVar("MAYO_USERNAME=me@x.com\n", "PUNCHES_LOCATION_ID", "abc")).toBe(
      "MAYO_USERNAME=me@x.com\nPUNCHES_LOCATION_ID=abc\n",
    );
  });

  it("replaces the existing line in place, preserving other lines and comments", () => {
    const input = "# creds\nMAYO_USERNAME=me@x.com\nPUNCHES_LOCATION_ID=old\nMAYO_PASSWORD=pw\n";
    expect(upsertEnvVar(input, "PUNCHES_LOCATION_ID", "new")).toBe(
      "# creds\nMAYO_USERNAME=me@x.com\nPUNCHES_LOCATION_ID=new\nMAYO_PASSWORD=pw\n",
    );
  });

  it("ignores a commented-out line and appends a real one", () => {
    expect(upsertEnvVar("#PUNCHES_LOCATION_ID=old\n", "PUNCHES_LOCATION_ID", "new")).toBe(
      "#PUNCHES_LOCATION_ID=old\nPUNCHES_LOCATION_ID=new\n",
    );
  });

  it("does not false-match a key that has the target as a prefix", () => {
    expect(upsertEnvVar("PUNCHES_LOCATION_ID_EXTRA=keep\n", "PUNCHES_LOCATION_ID", "new")).toBe(
      "PUNCHES_LOCATION_ID_EXTRA=keep\nPUNCHES_LOCATION_ID=new\n",
    );
  });

  it("returns just the line (single trailing newline) from empty input", () => {
    expect(upsertEnvVar("", "MAYO_USERNAME", "me@x.com")).toBe("MAYO_USERNAME=me@x.com\n");
  });

  it("collapses trailing blank lines when appending", () => {
    expect(upsertEnvVar("A=1\n\n\n", "B", "2")).toBe("A=1\nB=2\n");
  });
});

describe("buildEntries", () => {
  it("maps single-value fields to their env keys", () => {
    expect(buildEntries("username", ["me@x.com"])).toEqual({ MAYO_USERNAME: "me@x.com" });
    expect(buildEntries("location", ["abc"])).toEqual({ PUNCHES_LOCATION_ID: "abc" });
    expect(buildEntries("password", ["s3cret"])).toEqual({ MAYO_PASSWORD: "s3cret" });
  });

  it("maps pos to the two coordinate keys", () => {
    expect(buildEntries("pos", ["25.07", "121.57"])).toEqual({
      PUNCH_LATITUDE: "25.07",
      PUNCH_LONGITUDE: "121.57",
    });
  });

  it("throws on an unknown field", () => {
    expect(() => buildEntries("nope", ["x"])).toThrow(/unknown field/);
  });

  it("throws on the wrong number of values", () => {
    expect(() => buildEntries("pos", ["25.07"])).toThrow(/needs 2/);
    expect(() => buildEntries("location", [])).toThrow(/needs 1/);
  });
});

describe("upsertEnvVars", () => {
  it("applies every entry", () => {
    expect(upsertEnvVars("", { PUNCH_LATITUDE: "25.07", PUNCH_LONGITUDE: "121.57" })).toBe(
      "PUNCH_LATITUDE=25.07\nPUNCH_LONGITUDE=121.57\n",
    );
  });
});

describe("boolean toggle fields", () => {
  it("maps calendar/session to their env keys", () => {
    expect(buildEntries("calendar", ["true"])).toEqual({ CALENDAR_CHECK: "true" });
    expect(buildEntries("session", ["false"])).toEqual({ SESSION_CACHE: "false" });
  });
  it("BOOLEAN_FIELDS lists them", () => {
    expect(BOOLEAN_FIELDS.has("calendar")).toBe(true);
    expect(BOOLEAN_FIELDS.has("session")).toBe(true);
    expect(BOOLEAN_FIELDS.has("location")).toBe(false);
  });
  it("normalizeBool accepts on/off/true/false, rejects garbage", () => {
    expect(normalizeBool("on")).toBe("true");
    expect(normalizeBool("OFF")).toBe("false");
    expect(normalizeBool("true")).toBe("true");
    expect(() => normalizeBool("maybe")).toThrow();
  });
});

describe("removeEnvVars", () => {
  it("drops the named keys, keeps comments and the rest", () => {
    const src = "# header\nMAYO_USERNAME=e@x.com\nMAYO_PASSWORD=secret\nPUNCH_LATITUDE=1.2\n";
    const out = removeEnvVars(src, ["MAYO_USERNAME", "PUNCH_LATITUDE"]);
    expect(out).toBe("# header\nMAYO_PASSWORD=secret\n");
  });
  it("returns empty string when everything is removed", () => {
    expect(removeEnvVars("A=1\nB=2\n", ["A", "B"])).toBe("");
  });
  it("is a no-op for absent keys", () => {
    expect(removeEnvVars("MAYO_PASSWORD=x\n", ["MAYO_USERNAME"])).toBe("MAYO_PASSWORD=x\n");
  });
});
