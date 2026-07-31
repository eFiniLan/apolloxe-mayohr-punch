// Storage-agnostic calendar cache. The ONLY I/O boundary is the injected
// CacheStore (read/write) — no node:fs, no KV — so this stays Workers-safe and
// unit-tests without touching the filesystem. The CLI injects a file-backed
// store (scripts/cache-fs.ts); a future Worker could inject a KV-backed store.
import type { DayInfo } from "./calendar";
import { getMonthInfo } from "./calendar";
import type { Config } from "./config";
import type { Session } from "./auth";
import type { CacheStore } from "./cache-store";

export type { CacheStore }; // re-export for existing importers (cache-fs, tests)

export const CACHE_KEY = "calendar-cache.json";
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheDay {
  workday: boolean;
  onLeave: boolean;
  shiftStart: string | null;
  shiftEnd: string | null;
  label: string; // human-only; never parsed back
}

export interface CacheFile {
  generatedAt: string; // ISO-8601 (read for staleness)
  timezone: string; // human-only
  months: string[]; // human-only, e.g. ["2026-07","2026-08"]
  days: Record<string, CacheDay>; // keyed "YYYY-MM-DD"
}

/** Injectable non-storage boundaries (clock, month fetch). Both default inline. */
export interface CacheOpts {
  now?: () => Date;
  getMonthInfo?: typeof getMonthInfo;
}

/** Human-readable one-liner for a day. Code never reads this back. */
export function dayLabel(dateKey: string, info: DayInfo): string {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${dateKey}T00:00:00Z`));
  if (!info.isWorkday) return `${weekday} · off`;
  const leave = info.onLeave ? " · leave" : "";
  return `${weekday} · work · ${info.shiftStart}-${info.shiftEnd}${leave}`;
}

export function infoToCacheDay(dateKey: string, info: DayInfo): CacheDay {
  return {
    workday: info.isWorkday,
    onLeave: info.onLeave,
    shiftStart: info.shiftStart,
    shiftEnd: info.shiftEnd,
    label: dayLabel(dateKey, info),
  };
}

export function cacheDayToInfo(d: CacheDay): DayInfo {
  return {
    isWorkday: d.workday,
    onLeave: d.onLeave,
    shiftStart: d.shiftStart,
    shiftEnd: d.shiftEnd,
  };
}

export function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Current month + next month (year rolls over in December). */
export function targetMonths(dateKey: string): Array<{ year: number; month: number }> {
  const [y, m] = dateKey.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return [
    { year: y, month: m },
    { year: nextY, month: nextM },
  ];
}

/** Fresh = today is present AND generated within the refresh window. */
export function isFresh(file: CacheFile, dateKey: string, now: Date): boolean {
  if (!file.days?.[dateKey]) return false;
  const gen = Date.parse(file.generatedAt);
  if (Number.isNaN(gen)) return false;
  return now.getTime() - gen <= REFRESH_AFTER_MS;
}

/** Fetch the target months and assemble a fresh CacheFile (does not write). */
export async function buildCache(
  session: Session,
  cfg: Config,
  dateKey: string,
  opts: CacheOpts = {},
): Promise<CacheFile> {
  const now = opts.now ?? (() => new Date());
  const fetchMonth = opts.getMonthInfo ?? getMonthInfo;
  const months = targetMonths(dateKey);
  const days: Record<string, CacheDay> = {};
  for (const { year, month } of months) {
    const monthInfo = await fetchMonth(session, cfg, year, month);
    for (const [dk, info] of Object.entries(monthInfo)) {
      days[dk] = infoToCacheDay(dk, info);
    }
  }
  return {
    generatedAt: now().toISOString(),
    timezone: cfg.timezone,
    months: months.map(({ year, month }) => monthLabel(year, month)),
    days,
  };
}

function serialize(file: CacheFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Cache-only read: today's DayInfo iff the cache is present, fresh, and covers
 * today — else null. No session, no network. Lets a caller (the Worker's daily
 * plan build) use a warm calendar without logging in, authenticating only on a
 * miss. `cachedDayInfo` is the read-or-refresh version that needs a session.
 */
export async function peekDay(
  store: CacheStore,
  dateKey: string,
  opts: { now?: () => Date } = {},
): Promise<DayInfo | null> {
  const now = opts.now ?? (() => new Date());
  try {
    const raw = await store.read(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CacheFile;
    if (isFresh(cached, dateKey, now())) return cacheDayToInfo(cached.days[dateKey]);
  } catch {
    // unreadable / corrupt → treat as a miss
  }
  return null;
}

/**
 * Read today's DayInfo from the store, refreshing (fetch current + next month,
 * rewrite) when the cache is missing, corrupt, stale (>7d), or lacks today. A
 * failed write is logged but non-fatal — a cache problem must never block a punch.
 */
export async function cachedDayInfo(
  session: Session,
  cfg: Config,
  dateKey: string,
  store: CacheStore,
  opts: CacheOpts = {},
): Promise<{ info: DayInfo; source: "cache" | "fresh" }> {
  const now = opts.now ?? (() => new Date());

  let cached: CacheFile | null = null;
  try {
    const raw = await store.read(CACHE_KEY);
    if (raw) cached = JSON.parse(raw) as CacheFile;
  } catch {
    cached = null; // unreadable or corrupt → refresh
  }
  if (cached && isFresh(cached, dateKey, now())) {
    return { info: cacheDayToInfo(cached.days[dateKey]), source: "cache" };
  }

  const file = await buildCache(session, cfg, dateKey, opts);
  try {
    await store.write(CACHE_KEY, serialize(file));
  } catch (e) {
    console.error(`calendar-cache: write failed (${(e as Error).message}); continuing`);
  }

  const day = file.days[dateKey];
  if (!day) throw new Error(`No calendar entry for ${dateKey}`);
  return { info: cacheDayToInfo(day), source: "fresh" };
}
