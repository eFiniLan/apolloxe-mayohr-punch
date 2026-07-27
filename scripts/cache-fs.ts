// The file-backed CacheStore for the CLI. This is the ONLY place in the feature
// that imports node:fs — no test and no src/ file imports it, so src/ stays
// Workers-safe. A future Worker would provide a KV-backed CacheStore instead.
import { readFile, writeFile } from "node:fs/promises";
import type { CacheStore } from "../src/calendar-cache";

export const fileStore: CacheStore = {
  async read(key) {
    try {
      return await readFile(key, "utf8");
    } catch {
      return null; // absent → treat as no cache
    }
  },
  async write(key, contents) {
    await writeFile(key, contents, "utf8");
  },
};
