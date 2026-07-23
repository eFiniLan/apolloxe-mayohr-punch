import { describe, it, expect } from "vitest";
import { nowParts, addMinutes, randInt } from "../src/time";

describe("nowParts", () => {
  it("splits an instant into local dateKey + HH:MM for a tz", () => {
    expect(nowParts("Asia/Taipei", new Date("2026-07-23T01:05:00Z"))).toEqual({
      dateKey: "2026-07-23",
      hhmm: "09:05",
    });
  });
});

describe("addMinutes", () => {
  it("subtracts minutes within the day", () => {
    expect(addMinutes("09:30", -25)).toBe("09:05");
  });
  it("adds minutes within the day", () => {
    expect(addMinutes("18:30", 37)).toBe("19:07");
  });
  it("wraps forward past midnight", () => {
    expect(addMinutes("23:50", 20)).toBe("00:10");
  });
  it("wraps backward past midnight", () => {
    expect(addMinutes("00:10", -20)).toBe("23:50");
  });
});

describe("randInt", () => {
  it("returns min when rand() is 0", () => {
    expect(randInt(1, 15, () => 0)).toBe(1);
  });
  it("returns max when rand() is just under 1", () => {
    expect(randInt(1, 15, () => 0.999)).toBe(15);
  });
});
