// Read-only: show whether a day is a workday and its shift times, from Mayo's
// calendar. Reading the calendar is a tool — this NEVER punches. Live read (does
// not touch the punch cache), reusing the cached session for login.
//
//   npm run calendar                 # today
//   npm run calendar 2026-08-01      # a specific day (YYYY-MM-DD)
//   npm run calendar -- --json       # machine-readable line (the `--` is required under npm)
//
// Exit: 0 = workday · 1 = not a workday · 2 = usage · 3 = couldn't run.
import { acquireSession } from "../src/flow";
import { getDayInfo } from "../src/calendar";
import { nowParts } from "../src/time";
import { localConfig } from "./_env";
import { fileStore } from "./cache-fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json") || args.includes("-j");
const dateArg = args.find((a) => !a.startsWith("-"));

const { cfg } = localConfig();
const dateKey = dateArg ?? nowParts(cfg.timezone).dateKey;

if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
  console.error(`Usage: npm run calendar [YYYY-MM-DD] [-- --json]   (got "${dateKey}")`);
  process.exit(2);
}

const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(
  new Date(`${dateKey}T00:00:00Z`),
);

console.log(`\x1b[1m📅 ${dateKey} (${weekday})\x1b[0m  [${cfg.timezone}]`);

try {
  const { session } = await acquireSession(cfg, fileStore);
  const info = await getDayInfo(session, cfg, dateKey);

  console.log(`  workday : ${info.isWorkday ? "\x1b[32myes\x1b[0m" : "\x1b[33mno\x1b[0m"}`);
  console.log(`  shift   : ${info.shiftStart ?? "--"}–${info.shiftEnd ?? "--"}`);
  console.log(`  on leave: ${info.onLeave ? "yes" : "no"}`);

  if (asJson) {
    console.log(
      JSON.stringify({
        date: dateKey,
        workday: info.isWorkday,
        shiftStart: info.shiftStart,
        shiftEnd: info.shiftEnd,
        onLeave: info.onLeave,
      }),
    );
  }
  process.exit(info.isWorkday ? 0 : 1);
} catch (e) {
  const msg = (e as Error).message;
  console.error(`\x1b[31m✖ couldn't read the calendar: ${msg}\x1b[0m`);
  if (asJson) console.log(JSON.stringify({ date: dateKey, error: msg }));
  process.exit(3);
}
