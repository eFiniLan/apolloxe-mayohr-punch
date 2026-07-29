// Setup helper: lists your Apollo punch locations so you can choose which one to
// punch from, then set it with `npm run config set location <id>`.
// Read-only — logs in and GETs locations/EnableList. Never punches.
//
//   npm run locations
//
// Credentials: .dev.vars (or MAYO_USERNAME / MAYO_PASSWORD env vars).

import { acquireSession } from "../src/flow";
import { getLocations, formatLocations } from "../src/locations";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const { cfg, credsFrom } = localConfig();
console.log(`Logging in as ${cfg.userName} (creds from ${credsFrom})…`);

const { session } = await acquireSession(cfg, fileStore);
const locs = await getLocations(session, cfg);
if (!locs.length) {
  console.error("No locations returned.");
  process.exit(1);
}

console.log("\nYour Apollo punch locations:\n");
console.log(formatLocations(locs));
console.log("\nSet the one you punch from with:\n  npm run config set location <PunchesLocationId>\n");
