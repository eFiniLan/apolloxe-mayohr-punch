import { describe, it, expect } from "vitest";
import { nowParts, addMinutes, randInt, isValidDateKey, zonedTimeToEpoch, nextDateKey, hhmmss } from "../src/time";

describe("isValidDateKey", () => {
  it("accepts real dates (incl. a leap day)", () => {
    expect(isValidDateKey("2026-08-01")).toBe(true);
    expect(isValidDateKey("2026-02-28")).toBe(true);
    expect(isValidDateKey("2028-02-29")).toBe(true); // 2028 is a leap year
  });
  it("rejects bad format and impossible dates", () => {
    expect(isValidDateKey("not-a-date")).toBe(false);
    expect(isValidDateKey("2026-13-01")).toBe(false); // month 13
    expect(isValidDateKey("2026-07-32")).toBe(false); // day 32
    expect(isValidDateKey("2026-02-30")).toBe(false); // rolls over → rejected
    expect(isValidDateKey("2026-02-29")).toBe(false); // 2026 not a leap year
    expect(isValidDateKey("2026-2-1")).toBe(false); // not zero-padded
  });
});

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

describe("zonedTimeToEpoch (Asia/Taipei = UTC+8, no DST)", () => {
  it("maps a Taipei wall-clock to the right UTC instant", () => {
    // 09:30 Taipei on 2026-07-24 = 01:30 UTC
    expect(zonedTimeToEpoch("2026-07-24", "09:30", "Asia/Taipei")).toBe(Date.UTC(2026, 6, 24, 1, 30, 0));
  });
  it("includes seconds", () => {
    expect(zonedTimeToEpoch("2026-07-24", "09:30", "Asia/Taipei", 47)).toBe(Date.UTC(2026, 6, 24, 1, 30, 47));
  });
  it("handles the previous-UTC-day case (00:05 Taipei)", () => {
    // 00:05 Taipei on 2026-07-25 = 16:05 UTC on 2026-07-24
    expect(zonedTimeToEpoch("2026-07-25", "00:05", "Asia/Taipei")).toBe(Date.UTC(2026, 6, 24, 16, 5, 0));
  });
});

describe("nextDateKey", () => {
  it("advances one day, rolling months", () => {
    expect(nextDateKey("2026-07-24")).toBe("2026-07-25");
    expect(nextDateKey("2026-07-31")).toBe("2026-08-01");
    expect(nextDateKey("2026-12-31")).toBe("2027-01-01");
  });
});

describe("hhmmss", () => {
  it("formats an instant as HH:MM:SS in the given tz", () => {
    expect(hhmmss(Date.UTC(2026, 6, 24, 1, 19, 5), "Asia/Taipei")).toBe("09:19:05");
  });
});
