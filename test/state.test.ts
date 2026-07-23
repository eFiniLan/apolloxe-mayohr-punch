import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getPlan, savePlan, type DayPlan } from "../src/state";

describe("state", () => {
  it("returns null for an unseen day", async () => {
    expect(await getPlan(env.STATE, "2026-07-23")).toBeNull();
  });
  it("round-trips a plan", async () => {
    const p: DayPlan = { kind: "active", targetIn: "2026-07-23T01:00:00.000Z", targetOut: "2026-07-23T10:10:00.000Z", inDone: false, outDone: false };
    await savePlan(env.STATE, "2026-07-23", p);
    expect(await getPlan(env.STATE, "2026-07-23")).toEqual(p);
  });
});
