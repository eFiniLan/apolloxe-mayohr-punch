// Setup helper: lists your Apollo punch locations so you can choose which one
// the Worker reports, then set PUNCHES_LOCATION_ID in wrangler.toml.
// Read-only — logs in and GETs locations/EnableList. Never punches.
//
//   npm run locations
//
// Credentials: .dev.vars (or MAYO_USERNAME / MAYO_PASSWORD env vars).

import { login } from "../src/auth";
import { localConfig } from "./_env";

const LOCATIONS_URL = "https://apolloxe.mayohr.com/backend/pt/api/locations/EnableList";

interface Location {
  PunchesLocationId: string;
  LocationCode: string;
  LocationName: string;
}

const { cfg, credsFrom } = localConfig();
console.log(`Logging in as ${cfg.userName} (creds from ${credsFrom})…`);

const session = await login(cfg);
const res = await fetch(LOCATIONS_URL, {
  headers: {
    cookie: session.cookie,
    "user-agent": cfg.userAgent,
    accept: "*/*",
    // See src/calendar.ts — this API family varies its response shape without it.
    "accept-language": "en-us",
    "content-type": "application/json",
    referer: "https://apolloxe.mayohr.com/ta",
  },
});
if (!res.ok) {
  console.error(`locations: HTTP ${res.status}`);
  process.exit(1);
}

const data: Location[] = ((await res.json()) as { Data?: Location[] })?.Data ?? [];
if (!data.length) {
  console.error("No locations returned.");
  process.exit(1);
}

console.log("\nYour Apollo punch locations:\n");
console.log("  " + "PunchesLocationId".padEnd(38) + "Code".padEnd(8) + "Name");
console.log("  " + "-".repeat(70));
for (const loc of data) {
  console.log(
    "  " +
      String(loc.PunchesLocationId).padEnd(38) +
      String(loc.LocationCode).padEnd(8) +
      loc.LocationName,
  );
}
console.log(
  "\nPick the office you punch from and set it in wrangler.toml:\n" +
    '  [vars]\n  PUNCHES_LOCATION_ID = "<the PunchesLocationId above>"\n',
);
