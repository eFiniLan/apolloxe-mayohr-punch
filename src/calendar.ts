import type { Session } from "./auth";
import type { Config } from "./config";

export interface DayInfo {
  isWorkday: boolean; // false on weekends/holidays
  onLeave: boolean; // approved leave/trip covering the WHOLE shift
  shiftStart: string | null; // "HH:MM" in cfg.timezone; null when not a workday
  shiftEnd: string | null; // "HH:MM" in cfg.timezone; null when not a workday
}

const CALENDAR_URL =
  "https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling";
const REFERER_URL = "https://apolloxe.mayohr.com/ta/personal/shiftschedule";

interface ShiftSchedule {
  workOnTime: string | null;
  workOffTime: string | null;
  originalWorkOnTime: string | null;
  originalWorkOffTime: string | null;
}

// leaveSheets/tripSheets entries — field naming confirmed for leaveSheets
// (leaveStartDatetime/leaveEndDatetime) via the live fixture; tripSheets are
// assumed to follow the same "leave*"/"trip*" naming convention per
// the live API (same idea), with generic startDatetime/endDatetime as a
// fallback since no real tripSheets entry has been captured yet.
interface ApprovalSheet {
  status: number;
  leaveStartDatetime?: string;
  leaveEndDatetime?: string;
  tripStartDatetime?: string;
  tripEndDatetime?: string;
  startDatetime?: string;
  endDatetime?: string;
}

interface CalendarDay {
  date: string;
  shiftSchedule: ShiftSchedule | null;
  leaveSheets?: ApprovalSheet[];
  tripSheets?: ApprovalSheet[];
}

interface CalendarResponse {
  data?: { calendars?: CalendarDay[] };
}

const APPROVED_STATUS = 50;

function sheetRange(s: ApprovalSheet): { start: string; end: string } | null {
  const start = s.leaveStartDatetime ?? s.tripStartDatetime ?? s.startDatetime;
  const end = s.leaveEndDatetime ?? s.tripEndDatetime ?? s.endDatetime;
  if (!start || !end) return null;
  return { start, end };
}

function coversWholeShift(
  sheets: ApprovalSheet[] | undefined,
  schedOn: string | null,
  schedOff: string | null,
): boolean {
  if (!sheets?.length || !schedOn || !schedOff) return false;
  const shiftStart = new Date(schedOn).getTime();
  const shiftEnd = new Date(schedOff).getTime();
  return sheets.some((s) => {
    if (s.status !== APPROVED_STATUS) return false;
    const range = sheetRange(s);
    if (!range) return false;
    const start = new Date(range.start).getTime();
    const end = new Date(range.end).getTime();
    return start <= shiftStart && end >= shiftEnd;
  });
}

function toLocalHHMM(isoUtc: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoUtc));
}

function deriveDayInfo(entry: CalendarDay, tz: string): DayInfo {
  const ss = entry.shiftSchedule;
  const isWorkday = ss?.workOnTime != null;
  const schedOn = ss ? (ss.originalWorkOnTime ?? ss.workOnTime) : null;
  const schedOff = ss ? (ss.originalWorkOffTime ?? ss.workOffTime) : null;
  const shiftStart = isWorkday && schedOn ? toLocalHHMM(schedOn, tz) : null;
  const shiftEnd = isWorkday && schedOff ? toLocalHHMM(schedOff, tz) : null;
  const onLeave =
    isWorkday &&
    (coversWholeShift(entry.leaveSheets, schedOn, schedOff) ||
      coversWholeShift(entry.tripSheets, schedOn, schedOff));
  return { isWorkday, onLeave, shiftStart, shiftEnd };
}

/**
 * Read the scheduling calendar for one month and map every day to a DayInfo,
 * keyed "YYYY-MM-DD".
 */
export async function getMonthInfo(
  session: Session,
  cfg: Config,
  year: number,
  month: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, DayInfo>> {
  const url = `${CALENDAR_URL}?year=${year}&month=${month}`;

  const res = await fetchImpl(url, {
    headers: {
      cookie: session.cookie,
      "user-agent": cfg.userAgent,
      accept: "*/*",
      // REQUIRED: without accept-language the API returns a different
      // (numeric-indexed) shape with no `data.calendars`.
      "accept-language": "en-us",
      "content-type": "application/json",
      referer: REFERER_URL,
    },
  });

  if (!res.ok) {
    throw new Error(`calendar: HTTP ${res.status} fetching ${url}`);
  }

  let json: CalendarResponse;
  try {
    json = (await res.json()) as CalendarResponse;
  } catch (e) {
    throw new Error(`calendar: response was not JSON (${(e as Error).message})`);
  }

  const out: Record<string, DayInfo> = {};
  for (const entry of json.data?.calendars ?? []) {
    const dateKey = String(entry.date).slice(0, 10); // "YYYY-MM-DDT..." -> "YYYY-MM-DD"
    out[dateKey] = deriveDayInfo(entry, cfg.timezone);
  }
  return out;
}

/**
 * DayInfo for a single day. Thin wrapper over getMonthInfo.
 */
export async function getDayInfo(
  session: Session,
  cfg: Config,
  dateKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DayInfo> {
  const [yearStr, monthStr] = dateKey.split("-");
  const month = await getMonthInfo(session, cfg, Number(yearStr), Number(monthStr), fetchImpl);
  const info = month[dateKey];
  if (!info) {
    throw new Error(`No calendar entry for ${dateKey}`);
  }
  return info;
}
