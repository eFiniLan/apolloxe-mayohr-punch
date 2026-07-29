// The storage boundary shared by the calendar cache and the session cache.
// fs-backed for the CLI (scripts/cache-fs.ts); a future Worker injects KV.
export interface CacheStore {
  read: (key: string) => Promise<string | null>; // null when absent
  write: (key: string, contents: string) => Promise<void>;
}
