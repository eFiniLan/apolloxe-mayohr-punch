// The reusable punch flow: session acquisition (respecting cfg.sessionCache) and
// the punch orchestration (respecting cfg.calendarCheck + a per-call force). The
// CLI and a future Agent both call this; Part 2's Worker will too. Every boundary
// is injectable for testing.
import type { Session } from "./auth";
import { login as realLogin } from "./auth";
import type { Config } from "./config";
import type { CacheStore } from "./cache-store";
import type { DayInfo } from "./calendar";
import { getDayInfo as realGetDayInfo } from "./calendar";
import { cachedDayInfo as realCachedDayInfo } from "./calendar-cache";
import { getSession as realGetSession } from "./session-cache";
import { getLocations as realGetLocations } from "./locations";
import { punch as realPunch, type PunchOutcome } from "./punch";
import { nowParts } from "./time";

interface AcquireDeps {
  login?: (cfg: Config) => Promise<Session>;
  getSession?: typeof realGetSession;
  getLocations?: typeof realGetLocations;
}

/**
 * A session for the caller. `store === null` or `cfg.sessionCache === false` →
 * fresh login. Otherwise the cached cookie, validated by a cheap locations GET.
 */
export async function acquireSession(
  cfg: Config,
  store: CacheStore | null,
  deps: AcquireDeps = {},
): Promise<{ session: Session; source: "cache" | "fresh" }> {
  const login = deps.login ?? realLogin;
  if (!store || !cfg.sessionCache) {
    return { session: await login(cfg), source: "fresh" };
  }
  const getSession = deps.getSession ?? realGetSession;
  const getLocations = deps.getLocations ?? realGetLocations;
  return getSession(cfg, store, {
    login,
    // A live session lists the account's punch locations; an empty/no-Data
    // response (a dead cookie can return 200 with no Data) means "not valid" →
    // re-login. getLocations throws on non-2xx; both fall through to a fresh login.
    validate: (s) => getLocations(s, cfg).then((locs) => locs.length > 0).catch(() => false),
  });
}

export interface RunPunchOpts {
  direction: "in" | "out";
  force?: boolean; // skip the calendar check for this run
}

export interface RunPunchResult {
  step: "punched" | "skipped";
  reason?: string; // when skipped
  outcome?: PunchOutcome; // when punched
  sessionSource: "cache" | "fresh";
  calendarSource?: "cache" | "fresh"; // present only when the cache was consulted
  dayInfo?: DayInfo; // present when the calendar was checked
}

interface RunPunchDeps {
  acquireSession?: typeof acquireSession;
  cachedDayInfo?: typeof realCachedDayInfo;
  getDayInfo?: typeof realGetDayInfo;
  punch?: typeof realPunch;
  now?: () => Date;
}

/**
 * Today's DayInfo — cached when a store is given (auto-refresh on stale/missing),
 * live otherwise. Shared by runPunch and the Worker scheduler.
 */
export async function getDay(
  session: Session,
  cfg: Config,
  store: CacheStore | null,
  dateKey: string,
  deps: { cachedDayInfo?: typeof realCachedDayInfo; getDayInfo?: typeof realGetDayInfo } = {},
): Promise<{ info: DayInfo; source?: "cache" | "fresh" }> {
  if (store) {
    const r = await (deps.cachedDayInfo ?? realCachedDayInfo)(session, cfg, dateKey, store);
    return { info: r.info, source: r.source };
  }
  return { info: await (deps.getDayInfo ?? realGetDayInfo)(session, cfg, dateKey) };
}

/**
 * One punch: session → (optional workday check) → punch. Effective calendar
 * check = `cfg.calendarCheck && !opts.force`. With a store, the calendar read is
 * cached; without one (a stateless Worker) it is live.
 */
export async function runPunch(
  cfg: Config,
  store: CacheStore | null,
  opts: RunPunchOpts,
  deps: RunPunchDeps = {},
): Promise<RunPunchResult> {
  const acquire = deps.acquireSession ?? acquireSession;
  const punch = deps.punch ?? realPunch;
  const now = deps.now ?? (() => new Date());

  const { session, source: sessionSource } = await acquire(cfg, store);

  if (cfg.calendarCheck && !opts.force) {
    const { dateKey } = nowParts(cfg.timezone, now());
    const { info: dayInfo, source: calendarSource } = await getDay(session, cfg, store, dateKey, {
      cachedDayInfo: deps.cachedDayInfo,
      getDayInfo: deps.getDayInfo,
    });
    if (!dayInfo.isWorkday) {
      return { step: "skipped", reason: "not a workday", sessionSource, calendarSource, dayInfo };
    }
    const outcome = await punch(session, cfg, opts.direction);
    return { step: "punched", outcome, sessionSource, calendarSource, dayInfo };
  }

  const outcome = await punch(session, cfg, opts.direction);
  return { step: "punched", outcome, sessionSource };
}
