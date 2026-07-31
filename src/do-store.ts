// A CacheStore backed by a Durable Object's storage. Lets the session cache +
// calendar cache (which speak CacheStore) live in the DO's own SQLite storage, so
// no KV namespace is needed.
import type { CacheStore } from "./cache-store";

/** The subset of DurableObjectStorage we use (also satisfied by test fakes). */
export interface KeyValueStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export function doStore(storage: KeyValueStorage): CacheStore {
  return {
    read: async (k) => (await storage.get<string>(k)) ?? null,
    write: async (k, v) => {
      await storage.put(k, v);
    },
  };
}
