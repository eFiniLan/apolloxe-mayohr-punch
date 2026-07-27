// Pre-warm / force-refresh the local calendar cache (calendar-cache.json)
// WITHOUT punching. Reuses the same login + getMonthInfo the punch command uses,
// so it can't drift.
//
//   npm run calendar:sync
//
// Credentials: .dev.vars (or MAYO_USERNAME / MAYO_PASSWORD env vars).
import { login } from "../src/auth";
import { nowParts } from "../src/time";
import { localConfig } from "./_env";
import { syncCalendar, CACHE_KEY } from "../src/calendar-cache";
import { fileStore } from "./cache-fs";

const { cfg, credsFrom } = localConfig();

console.log("\x1b[1mCalendar sync\x1b[0m (force-refresh the local cache)");
console.log(`  account : ${cfg.userName}  (creds from ${credsFrom})`);

console.log("\n\x1b[36m▶ login\x1b[0m");
const session = await login(cfg);
console.log("  \x1b[32m✓\x1b[0m session established");

const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ fetch + write ${CACHE_KEY}\x1b[0m`);
const file = await syncCalendar(session, cfg, dateKey, fileStore);
console.log(`  \x1b[32m✓\x1b[0m cached ${file.months.join(" + ")} (${Object.keys(file.days).length} days) → ${CACHE_KEY}`);
console.log(`  generated ${file.generatedAt}`);
