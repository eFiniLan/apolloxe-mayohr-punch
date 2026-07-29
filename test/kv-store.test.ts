import { describe, it, expect } from "vitest";
import { kvStore } from "../src/kv-store";

// Map-backed fake of the KVNamespace bits we use.
function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
  } as unknown as KVNamespace;
}

describe("kvStore", () => {
  it("round-trips read/write and returns null for a missing key", async () => {
    const store = kvStore(fakeKV());
    expect(await store.read("k")).toBeNull();
    await store.write("k", "hello");
    expect(await store.read("k")).toBe("hello");
  });
});
