// Config CLI: set login/location/coords/toggles, and show the effective config.
// Reuses the same src/ modules the punch uses.
//
//   npm run config set username <email>    # → wrangler.toml [vars]
//   npm run config set password            # → .dev.vars (prompted, hidden)
//   npm run config set location <id>       # → wrangler.toml (no id = list your locations)
//   npm run config set pos <lat> <lng>     # → wrangler.toml
//   npm run config set calendar|session on|off   # → wrangler.toml
//   npm run config                         # show effective config
//
// Non-secret config is single-sourced in wrangler.toml [vars] (shared with the
// deployed Worker); only the password goes to .dev.vars (mode 0600). No validation.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import * as readline from "node:readline";
import { buildEntries, upsertEnvVars, FIELDS, BOOLEAN_FIELDS, normalizeBool } from "./dev-vars";
import { upsertTomlVars } from "./wrangler-vars";
import { DEV_VARS_PATH, WRANGLER_PATH, mergedEnv, migrateDevVars, localConfig } from "./_env";
import { loadConfig } from "../src/config";
import { acquireSession } from "../src/flow";
import { fileStore } from "./cache-fs";
import { getLocations, formatLocations } from "../src/locations";

const USAGE =
  "Usage:\n" +
  "  npm run config set username <email>    # → wrangler.toml\n" +
  "  npm run config set password            # → .dev.vars (prompted, hidden)\n" +
  "  npm run config set location [<PunchesLocationId>]   # → wrangler.toml (no id = list)\n" +
  "  npm run config set pos <lat> <lng>     # → wrangler.toml\n" +
  "  npm run config set calendar on|off     # check today's shift before punching\n" +
  "  npm run config set session on|off      # reuse the cached login cookie\n" +
  "  npm run config migrate                 # move non-secret keys .dev.vars → wrangler.toml";

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function ensureCreds(env: Record<string, string>): void {
  if (!env.MAYO_USERNAME || !env.MAYO_PASSWORD) {
    console.error(
      "Your login isn't set yet. Set it first:\n" +
        "  npm run config set username <email>\n" +
        "  npm run config set password",
    );
    process.exit(1);
  }
}

/** Read one line from stdin without echoing it (for the password). */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(query);
    let muted = true;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function readOr(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function cmdSet(field: string, values: string[]): Promise<void> {
  if (!field || !(field in FIELDS)) usage();

  // `set location` with no id → list what's available (needs login).
  if (field === "location" && values.length === 0) {
    ensureCreds(mergedEnv());
    const { cfg } = localConfig();
    console.log(`Logging in as ${cfg.userName}…`);
    const { session } = await acquireSession(cfg, fileStore);
    console.log("\nYour Apollo punch locations:\n");
    console.log(formatLocations(await getLocations(session, cfg)));
    console.log("\nSet one with:  npm run config set location <PunchesLocationId>");
    return;
  }

  // Password is always entered via the hidden prompt — never taken from argv
  // (which would land it in shell history / process listings).
  if (field === "password") {
    if (values.length > 0) console.error("(ignoring the inline value — password is entered via hidden prompt)");
    const pw = await promptHidden("New password (hidden): ");
    if (!pw) {
      console.error("No password entered; nothing changed.");
      process.exit(1);
    }
    values = [pw];
  }

  if (BOOLEAN_FIELDS.has(field) && values.length === 1) {
    try {
      values = [normalizeBool(values[0])];
    } catch (e) {
      console.error((e as Error).message);
      usage();
    }
  }

  let entries: Record<string, string>;
  try {
    entries = buildEntries(field, values);
  } catch (e) {
    console.error((e as Error).message);
    usage();
  }

  // The password is the one secret → .dev.vars (mode 0600). Everything else is
  // non-secret → wrangler.toml [vars] (the single source shared with the Worker).
  const toDevVars = field === "password";
  const path = toDevVars ? DEV_VARS_PATH : WRANGLER_PATH;
  const updated = toDevVars
    ? upsertEnvVars(readOr(DEV_VARS_PATH), entries)
    : upsertTomlVars(readOr(WRANGLER_PATH), entries);
  writeFileSync(path, updated, toDevVars ? { mode: 0o600 } : undefined);
  if (toDevVars) chmodSync(path, 0o600); // enforce secret perms even if the file pre-existed

  const shown = Object.entries(entries)
    .map(([k, v]) => `${k}=${toDevVars ? "••••••" : v}`)
    .join("  ");
  console.log(`✓ Set ${shown} in ${path}`);
}

/**
 * One-shot upgrade: move every non-secret key out of .dev.vars into
 * wrangler.toml [vars], so there is a single source. The password stays put.
 * Idempotent — a no-op once .dev.vars holds only the password.
 */
async function cmdMigrate(): Promise<void> {
  const keys = migrateDevVars();
  if (keys.length === 0) {
    console.log("Nothing to migrate — .dev.vars already holds only the password (or is empty).");
    return;
  }
  console.log(`✓ Moved ${keys.join(", ")} from .dev.vars → ${WRANGLER_PATH} [vars].`);
  console.log("  .dev.vars now holds only the password.");
}

function cmdList(): void {
  const env = mergedEnv();
  // loadConfig requires creds; stub them just to read location/pos/timezone.
  const cfg = loadConfig({ MAYO_USERNAME: "x", MAYO_PASSWORD: "x", ...env } as never);

  console.log("Effective config (env > .dev.vars > wrangler.toml > defaults):\n");
  console.log(`  username : ${env.MAYO_USERNAME || "(not set)"}`);
  console.log(`  password : ${env.MAYO_PASSWORD ? "••••••" : "(not set)"}`);
  console.log(`  location : ${cfg.punchesLocationId}`);
  console.log(`  pos      : ${cfg.latitude}, ${cfg.longitude}`);
  console.log(`  timezone : ${cfg.timezone}`);
  console.log(`  calendar : ${cfg.calendarCheck ? "on" : "off"}`);
  console.log(`  session  : ${cfg.sessionCache ? "on" : "off"}`);
  console.log(`\n  non-secret → ${WRANGLER_PATH}`);
  console.log(`  password   → ${DEV_VARS_PATH}`);
}

const [cmd, field, ...values] = process.argv.slice(2);
if (cmd === "set") await cmdSet(field, values);
else if (cmd === "migrate") await cmdMigrate();
else {
  // Anything other than `set`/`migrate` (no args, or an unrecognized word) shows
  // the effective config plus the command help.
  cmdList();
  console.log("\n" + USAGE);
}
