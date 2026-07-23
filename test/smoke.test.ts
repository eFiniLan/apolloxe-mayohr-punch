import { describe, it, expect } from "vitest";
import worker from "../src/index";
describe("worker module", () => {
  it("exports a scheduled handler", () => {
    expect(typeof worker.scheduled).toBe("function");
  });
});
