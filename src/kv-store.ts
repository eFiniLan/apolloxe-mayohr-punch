import type { CacheStore } from "./cache-store";

/**
 * A Workers-KV-backed CacheStore for the deployed Worker. `ns` is the bound
 * KVNamespace (e.g. env.APOLLO_KV). Stores the same JSON strings the file store
 * does; KV's eventual consistency is fine (validate-before-use + TTL cover it).
 */
export function kvStore(ns: KVNamespace): CacheStore {
  return {
    read: (key) => ns.get(key),
    write: (key, contents) => ns.put(key, contents),
  };
}
