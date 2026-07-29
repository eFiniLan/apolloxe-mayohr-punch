import { describe, it, expect, vi } from "vitest";
import { getLocations, formatLocations, type Location } from "../src/locations";

const LOCATIONS_URL = "https://apolloxe.mayohr.com/backend/pt/api/locations/EnableList";
const session: any = { cookie: "__ModuleSessionCookie=ABC" };
const cfg: any = { userAgent: "test-agent/1.0" };

const SAMPLE: Location[] = [
  { PunchesLocationId: "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1", LocationCode: "L001", LocationName: "台北辦公室" },
  { PunchesLocationId: "00000000-0000-0000-0000-000000000000", LocationCode: "L9999", LocationName: "other" },
];

function mockFetch(body: unknown, status = 200) {
  return vi.fn(
    async (_url: any, _init: any = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("getLocations", () => {
  it("returns Data[] and sends cookie + accept-language to the EnableList URL", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ Data: SAMPLE }), { status: 200 });
    });
    const locs = await getLocations(session, cfg, f as any);
    expect(locs).toEqual(SAMPLE);
    expect(calls[0].url).toBe(LOCATIONS_URL);
    expect(calls[0].init.headers.cookie).toBe(session.cookie);
    expect(calls[0].init.headers["accept-language"]).toBe("en-us");
  });

  it("returns [] when Data is missing", async () => {
    expect(await getLocations(session, cfg, mockFetch({}) as any)).toEqual([]);
  });

  it("throws on a non-OK response", async () => {
    await expect(getLocations(session, cfg, mockFetch("err", 500) as any)).rejects.toThrow(/HTTP 500/);
  });
});

describe("formatLocations", () => {
  it("renders a header, a divider, and one line per location", () => {
    const out = formatLocations(SAMPLE);
    expect(out).toContain("PunchesLocationId");
    expect(out).toContain("L001");
    expect(out).toContain("台北辦公室");
    expect(out).toContain("00000000-0000-0000-0000-000000000000");
    expect(out.split("\n").length).toBe(2 + SAMPLE.length); // header + divider + rows
  });
});
