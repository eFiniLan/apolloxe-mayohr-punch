import { describe, it, expect, vi } from "vitest";
import { readCachedCookie, getSession, saveSession, SESSION_KEY, type SessionOpts } from "../src/session-cache";

const cfg: any = { userName: "u" };
const SESSION = { cookie: "__ModuleSessionCookie=LIVE" };
const NOW = new Date("2026-07-29T12:00:00Z");

function memStore(initial: string | null) {
  const state = { cur: initial, written: [] as Array<[string, string]> };
  const store = {
    read: async (_k: string) => state.cur,
    write: async (k: string, c: string) => { state.cur = c; state.written.push([k, c]); },
  };
  return { store, state };
}

describe("readCachedCookie", () => {
  const file = (cookie: unknown, savedAt: unknown) => JSON.stringify({ cookie, savedAt });
  it("returns the cookie when present and within the 9-day TTL", () => {
    expect(readCachedCookie(file("C", "2026-07-27T12:00:00Z"), NOW)).toBe("C");
  });
  it("null when older than the TTL", () => {
    expect(readCachedCookie(file("C", "2026-07-19T11:00:00Z"), NOW)).toBeNull();
  });
  it("null on missing raw / corrupt JSON / missing fields / bad date", () => {
    expect(readCachedCookie(null, NOW)).toBeNull();
    expect(readCachedCookie("{ not json", NOW)).toBeNull();
    expect(readCachedCookie(file(undefined, "2026-07-29T00:00:00Z"), NOW)).toBeNull();
    expect(readCachedCookie(file("C", "nope"), NOW)).toBeNull();
  });
});

const opts = (over: Partial<SessionOpts> = {}): SessionOpts => ({ now: () => NOW, login: vi.fn(async () => SESSION), ...over });

describe("getSession", () => {
  it("no cache → logs in, saves, source fresh", async () => {
    const { store, state } = memStore(null);
    const o = opts();
    const r = await getSession(cfg, store, o);
    expect(r).toEqual({ session: SESSION, source: "fresh" });
    expect(o.login).toHaveBeenCalledTimes(1);
    expect(state.written).toHaveLength(1);
    expect(state.written[0][0]).toBe(SESSION_KEY);
    expect(JSON.parse(state.written[0][1]).cookie).toBe(SESSION.cookie);
  });
  it("cached + validate true → reuse, no login, source cache", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "CACHED", savedAt: "2026-07-28T12:00:00Z" }));
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate: async () => true }));
    expect(r).toEqual({ session: { cookie: "CACHED" }, source: "cache" });
    expect(login).not.toHaveBeenCalled();
  });
  it("cached + validate false → re-login + save, source fresh", async () => {
    const { store, state } = memStore(JSON.stringify({ cookie: "DEAD", savedAt: "2026-07-28T12:00:00Z" }));
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate: async () => false }));
    expect(r.source).toBe("fresh");
    expect(login).toHaveBeenCalledTimes(1);
    expect(state.written).toHaveLength(1);
  });
  it("expired cache → re-login without validating", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "OLD", savedAt: "2026-07-01T12:00:00Z" }));
    const validate = vi.fn(async () => true);
    const login = vi.fn(async () => SESSION);
    const r = await getSession(cfg, store, opts({ login, validate }));
    expect(r.source).toBe("fresh");
    expect(validate).not.toHaveBeenCalled();
  });
  it("no validate provided + cached → reuse without a check", async () => {
    const { store } = memStore(JSON.stringify({ cookie: "CACHED", savedAt: "2026-07-28T12:00:00Z" }));
    const r = await getSession(cfg, store, opts());
    expect(r).toEqual({ session: { cookie: "CACHED" }, source: "cache" });
  });
  it("write failure is non-fatal", async () => {
    const store = { read: async () => null, write: async () => { throw new Error("EACCES"); } };
    const r = await getSession(cfg, store, opts());
    expect(r).toEqual({ session: SESSION, source: "fresh" });
  });
});

describe("saveSession", () => {
  it("writes {cookie, savedAt} JSON via the store", async () => {
    const { store, state } = memStore(null);
    await saveSession(store, SESSION, () => NOW);
    expect(state.written[0][0]).toBe(SESSION_KEY);
    expect(JSON.parse(state.written[0][1])).toEqual({ cookie: SESSION.cookie, savedAt: NOW.toISOString() });
  });
});
