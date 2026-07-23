import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getPlan, savePlan, type DayPlan } from "../src/state";

describe("state", () => {
  it("returns null for an unseen day", async () => {
    expect(await getPlan(env.STATE, "2026-07-23")).toBeNull();
  });
  it("round-trips an active plan", async () => {
    const p: DayPlan = {
      kind: "active",
      targetIn: "09:26",
      targetOut: "18:37",
      escalateInAt: "09:20",
      inDone: false,
      outDone: false,
      escalatedIn: false,
    };
    await savePlan(env.STATE, "2026-07-23", p);
    expect(await getPlan(env.STATE, "2026-07-23")).toEqual(p);
  });
  it("round-trips a skip plan", async () => {
    const p: DayPlan = { kind: "skip", reason: "not a workday" };
    await savePlan(env.STATE, "2026-07-25", p);
    expect(await getPlan(env.STATE, "2026-07-25")).toEqual(p);
  });
});
