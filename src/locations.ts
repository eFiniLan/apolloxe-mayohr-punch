import type { Session } from "./auth";
import type { Config } from "./config";

export interface Location {
  PunchesLocationId: string;
  LocationCode: string;
  LocationName: string;
}

const LOCATIONS_URL = "https://apolloxe.mayohr.com/backend/pt/api/locations/EnableList";

/**
 * Read-only: the punch locations enabled for this account (GET EnableList).
 * Cookie auth; `accept-language` is required (this API family varies its shape
 * without it — see src/calendar.ts).
 */
export async function getLocations(
  session: Session,
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Location[]> {
  const res = await fetchImpl(LOCATIONS_URL, {
    headers: {
      cookie: session.cookie,
      "user-agent": cfg.userAgent,
      accept: "*/*",
      "accept-language": "en-us",
      "content-type": "application/json",
      referer: "https://apolloxe.mayohr.com/ta",
    },
  });
  if (!res.ok) throw new Error(`locations: HTTP ${res.status}`);
  return ((await res.json()) as { Data?: Location[] })?.Data ?? [];
}

/** A fixed-width table of locations for terminal display (pure). */
export function formatLocations(locs: Location[]): string {
  const rows = locs.map(
    (l) =>
      "  " +
      String(l.PunchesLocationId).padEnd(38) +
      String(l.LocationCode).padEnd(8) +
      l.LocationName,
  );
  return (
    "  " + "PunchesLocationId".padEnd(38) + "Code".padEnd(8) + "Name\n" +
    "  " + "-".repeat(70) + "\n" +
    rows.join("\n")
  );
}
