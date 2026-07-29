// Manual punch, via the shared src/flow.runPunch — the same core an Agent (and
// later the Worker) uses. Makes a REAL punch unless DRY_RUN=true.
//
//   npm run punch in            # clock in  (real)
//   npm run punch out           # clock out (real)
//   npm run punch in --force    # skip the calendar check for this run (-f works too)
//   DRY_RUN=true npm run punch in   # dry run — no real punch
//
// Credentials: env (export MAYO_USERNAME/MAYO_PASSWORD) or .dev.vars.
// Location/coords/toggles: config (env > .dev.vars > defaults).
import { runPunch } from "../src/flow";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const args = process.argv.slice(2);
const dir = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
const force = args.includes("--force") || args.includes("-f");
if (dir !== "in" && dir !== "out") {
  console.error("Usage: npm run punch in|out [--force|-f]   (add DRY_RUN=true for a no-op test)");
  process.exit(1);
}

const { cfg, credsFrom } = localConfig();

const nowStr = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
console.log("\x1b[1mApollo punch-now\x1b[0m (via src/flow.runPunch)");
console.log(`  direction : clock-${dir.toUpperCase()}${force ? "  \x1b[33m[--force: skip calendar]\x1b[0m" : ""}${cfg.dryRun ? "  \x1b[33m[DRY_RUN]\x1b[0m" : ""}`);
console.log(`  now       : ${nowStr} (${cfg.timezone})`);
console.log(`  account   : ${cfg.userName}  (creds from ${credsFrom})`);
console.log(`  location  : ${cfg.punchesLocationId}`);
console.log(`  coords    : ${cfg.latitude}, ${cfg.longitude}  (± ${cfg.gpsJitterMeters} m jitter)`);
console.log(`  toggles   : calendar=${cfg.calendarCheck ? "on" : "off"}  session=${cfg.sessionCache ? "on" : "off"}`);

const r = await runPunch(cfg, fileStore, { direction: dir as "in" | "out", force });

console.log(`\n  session   : ${r.sessionSource}${r.calendarSource ? `   calendar : ${r.calendarSource}` : ""}`);
if (r.dayInfo) {
  console.log(`  shift     : ${r.dayInfo.shiftStart ?? "--"}–${r.dayInfo.shiftEnd ?? "--"}  workday=${r.dayInfo.isWorkday}  onLeave=${r.dayInfo.onLeave}`);
}
if (r.step === "skipped") {
  console.log(`\n\x1b[33m⤼ Skipped: ${r.reason}. Not punching.\x1b[0m`);
  process.exit(0);
}
const o = r.outcome!;
console.log("");
if (o.outcome === "success") console.log(`\x1b[32m✅ SUCCESS — Mayo recorded clock-${dir} at ${o.punchDate} @ ${o.locationName}\x1b[0m`);
else if (o.outcome === "already_done") console.log(`\x1b[33m✅ Already clocked ${dir} today (${o.detail}) — nothing to do.\x1b[0m`);
else console.log(`\x1b[31m❌ FAILED: ${o.detail}\x1b[0m`); // cooldown or failure — honest feedback to a human
