// Storage-agnostic session cookie cache. No node: import — only the injected
// CacheStore. Reuses a cached cookie only after validate-before-use.
import type { Session } from "./auth";
import { login as realLogin } from "./auth";
import type { Config } from "./config";
import type { CacheStore } from "./cache-store";

export const SESSION_KEY = "session-cache.json";
const TTL_MS = 9 * 24 * 60 * 60 * 1000;

export interface SessionFile {
  cookie: string;
  savedAt: string; // ISO-8601, read for staleness
}

export interface SessionOpts {
  now?: () => Date;
  login?: (cfg: Config) => Promise<Session>;
  validate?: (session: Session) => Promise<boolean>;
  ttlMs?: number;
}

/** Pure: the cached cookie iff present and savedAt within TTL; else null. */
export function readCachedCookie(raw: string | null, now: Date, ttlMs: number = TTL_MS): string | null {
  if (!raw) return null;
  let f: SessionFile;
  try {
    f = JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
  if (!f || typeof f.cookie !== "string" || !f.cookie || typeof f.savedAt !== "string") return null;
  const saved = Date.parse(f.savedAt);
  if (Number.isNaN(saved)) return null;
  if (now.getTime() - saved > ttlMs) return null;
  return f.cookie;
}

/** Force-write the current cookie to the cache. */
export async function saveSession(
  store: CacheStore,
  session: Session,
  now: () => Date = () => new Date(),
): Promise<void> {
  const file: SessionFile = { cookie: session.cookie, savedAt: now().toISOString() };
  await store.write(SESSION_KEY, JSON.stringify(file, null, 2) + "\n");
}

/**
 * Cached-or-fresh session. Reuses a cached cookie only if it validates (when a
 * `validate` is given); otherwise logs in fresh and saves. Write is non-fatal.
 */
export async function getSession(
  cfg: Config,
  store: CacheStore,
  opts: SessionOpts = {},
): Promise<{ session: Session; source: "cache" | "fresh" }> {
  const now = opts.now ?? (() => new Date());
  const login = opts.login ?? realLogin;
  const ttlMs = opts.ttlMs ?? TTL_MS;

  let raw: string | null = null;
  try {
    raw = await store.read(SESSION_KEY);
  } catch (e) {
    console.error(`session-cache: read failed (${(e as Error).message}); logging in fresh`);
    raw = null;
  }
  const cookie = readCachedCookie(raw, now(), ttlMs);
  if (cookie) {
    const session: Session = { cookie };
    if (!opts.validate || (await opts.validate(session))) {
      return { session, source: "cache" };
    }
  }

  const session = await login(cfg);
  try {
    await saveSession(store, session, now);
  } catch (e) {
    console.error(`session-cache: write failed (${(e as Error).message}); continuing`);
  }
  return { session, source: "fresh" };
}
