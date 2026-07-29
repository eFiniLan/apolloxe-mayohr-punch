// Manual punch, via the shared src/flow.runPunch — the same core an Agent (and
// the Worker) use. Makes a REAL punch unless DRY_RUN=true.
//
//   npm run punch in                 # clock in  (real)
//   npm run punch out                # clock out (real)
//   npm run punch in -- --force      # skip the calendar check this run (-f too; -- needed under npm)
//   npm run punch in -- --json       # also print one machine-readable JSON line (last line of output)
//   DRY_RUN=true npm run punch in     # dry run — no real punch
//
// Exit codes:  0 ok (success/already_done/cooldown/skipped) · 1 punch rejected ·
//              2 usage · 3 could not run (login/calendar/network error)
import { runPunch } from "../src/flow";
import { summarize } from "../src/punch";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const args = process.argv.slice(2);
const dir = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
const force = args.includes("--force") || args.includes("-f");
const asJson = args.includes("--json") || args.includes("-j");
if (dir !== "in" && dir !== "out") {
  console.error("Usage: npm run punch in|out [-- --force] [-- --json]   (DRY_RUN=true for a no-op)");
  process.exit(2);
}

/** Print the optional JSON summary line (stdout) and exit with the given code. */
function done(step: string, outcome: string, detail: string, code: number): never {
  if (asJson) console.log(JSON.stringify({ step, outcome, detail, exit: code }));
  process.exit(code);
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

try {
  const r = await runPunch(cfg, fileStore, { direction: dir as "in" | "out", force });

  console.log(`\n  session   : ${r.sessionSource}${r.calendarSource ? `   calendar : ${r.calendarSource}` : ""}`);
  if (r.dayInfo) {
    console.log(`  shift     : ${r.dayInfo.shiftStart ?? "--"}–${r.dayInfo.shiftEnd ?? "--"}  workday=${r.dayInfo.isWorkday}  onLeave=${r.dayInfo.onLeave}`);
  }

  if (r.step === "skipped") {
    console.log(`\n\x1b[33m⤼ Skipped: ${r.reason}. Not punching.\x1b[0m`);
    done("skipped", "skipped", r.reason ?? "", 0);
  }

  const o = r.outcome!;
  const { ok, reason } = summarize(dir as "in" | "out", o);
  const detail = "detail" in o ? o.detail : "";
  console.log("");
  console.log(ok ? `\x1b[32m✅ ${reason}\x1b[0m` : `\x1b[31m❌ ${reason}\x1b[0m`);
  done("punched", o.outcome, detail, ok ? 0 : 1);
} catch (e) {
  const msg = (e as Error).message;
  console.error(`\n\x1b[31m✖ could not run: ${msg}\x1b[0m`);
  done("error", "error", msg, 3);
}
