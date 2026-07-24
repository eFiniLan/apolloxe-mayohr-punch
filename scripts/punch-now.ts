// Manual end-to-end test that reuses the REAL Worker modules (no reimplementation,
// so it can't drift from the deployed code). Runs: loadConfig -> login -> getDayInfo
// -> punch, exactly as the scheduler does. Makes a REAL punch unless DRY_RUN=true.
//
//   npm run punch in            # clock in  (real)
//   npm run punch out           # clock out (real)
//   DRY_RUN=true npm run punch in   # dry run — no real punch (safe to try anytime)
//
// Credentials: env MAYO_USERNAME/MAYO_PASSWORD, else probe/secrets.json.
// Coords/location/timing: env (PUNCH_LATITUDE, …), else the Worker defaults.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import { login } from "../src/auth";
import { getDayInfo } from "../src/calendar";
import { punch } from "../src/punch";
import { nowParts } from "../src/time";

const dir = (process.argv[2] || "").toLowerCase();
if (dir !== "in" && dir !== "out") {
  console.error("Usage: npm run punch in|out   (add DRY_RUN=true for a no-op test)");
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
function creds(): { userName: string; password: string; src: string } {
  if (process.env.MAYO_USERNAME && process.env.MAYO_PASSWORD)
    return { userName: process.env.MAYO_USERNAME, password: process.env.MAYO_PASSWORD, src: "env" };
  try {
    const s = JSON.parse(readFileSync(join(HERE, "..", "probe", "secrets.json"), "utf8"));
    if (s.userName && s.password && !String(s.userName).startsWith("REPLACE"))
      return { userName: s.userName, password: s.password, src: "probe/secrets.json" };
  } catch {}
  console.error("No credentials: set MAYO_USERNAME + MAYO_PASSWORD, or fill probe/secrets.json.");
  process.exit(1);
}

const c = creds();
// Build the same env the Worker's loadConfig reads. NOTIFY_* / RESEND are required
// by loadConfig but unused here (punch-now never emails), so dummies are fine.
const env: Record<string, string> = {
  RESEND_API_KEY: "unused",
  NOTIFY_TO: "unused@example.com",
  NOTIFY_FROM: "unused@example.com",
  ...(process.env as Record<string, string>),
  MAYO_USERNAME: c.userName,
  MAYO_PASSWORD: c.password,
};
const cfg = loadConfig(env as any);

const now = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
console.log("\x1b[1mApollo punch-now\x1b[0m (reuses src/ modules)");
console.log(`  direction : clock-${dir.toUpperCase()}${cfg.dryRun ? "  \x1b[33m[DRY_RUN — no real punch]\x1b[0m" : ""}`);
console.log(`  now       : ${now} (${cfg.timezone})`);
console.log(`  account   : ${c.userName}  (creds from ${c.src})`);
console.log(`  location  : ${cfg.punchesLocationId}`);
console.log(`  coords    : ${cfg.latitude}, ${cfg.longitude}  (± ${cfg.gpsJitterMeters} m jitter)`);

console.log("\n\x1b[36m▶ login (auth.login)\x1b[0m");
const session = await login(cfg);
console.log("  \x1b[32m✓\x1b[0m session established (module cookie held)");

const { dateKey } = nowParts(cfg.timezone);
console.log(`\n\x1b[36m▶ read calendar (calendar.getDayInfo) for ${dateKey}\x1b[0m`);
const info = await getDayInfo(session, cfg, dateKey);
console.log(`  workday=${info.isWorkday}  shift=${info.shiftStart ?? "--"}–${info.shiftEnd ?? "--"}  onLeave=${info.onLeave}`);
if (!info.isWorkday) {
  console.log("\n  Not a workday — the Worker would SKIP. Not punching.");
  process.exit(0);
}

console.log(`\n\x1b[36m▶ punch (punch.punch, "${dir}")\x1b[0m`);
const r = await punch(session, cfg, dir as "in" | "out");
console.log(`  outcome: ${JSON.stringify(r)}`);
console.log("");
if (r.outcome === "success") console.log(`\x1b[32m✅ SUCCESS — Mayo recorded clock-${dir} at ${r.punchDate} @ ${r.locationName}\x1b[0m`);
else if (r.outcome === "already_done") console.log(`\x1b[33m✅ Already clocked ${dir} today (${r.detail}) — nothing to do.\x1b[0m`);
else console.log(`\x1b[31m❌ FAILED: ${r.detail}\x1b[0m`);
