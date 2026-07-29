// Config CLI: set credentials/location/coords into .dev.vars without hand-editing,
// and show the effective config. Reuses the same src/ modules the punch uses.
//
//   npm run config set username <email>
//   npm run config set password            # prompted, hidden (never echoed / in shell history)
//   npm run config set location <id>       # or run with no id to list your locations
//   npm run config set pos <lat> <lng>
//   npm run config list
//
// Writes to .dev.vars (or APOLLO_DEV_VARS) at mode 0600. No id/value validation.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import * as readline from "node:readline";
import { buildEntries, upsertEnvVars, FIELDS } from "./dev-vars";
import { readDevVars, DEV_VARS_PATH, localConfig } from "./_env";
import { loadConfig } from "../src/config";
import { login } from "../src/auth";
import { getLocations, formatLocations } from "../src/locations";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  npm run config set username <email>\n" +
      "  npm run config set password            # prompted, hidden\n" +
      "  npm run config set location [<PunchesLocationId>]   # no id = list your locations\n" +
      "  npm run config set pos <lat> <lng>\n" +
      "  npm run config list",
  );
  process.exit(1);
}

function mergedEnv(): Record<string, string> {
  return { ...readDevVars(), ...(process.env as Record<string, string>) };
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

function writeDevVars(contents: string): void {
  writeFileSync(DEV_VARS_PATH, contents, { mode: 0o600 });
  chmodSync(DEV_VARS_PATH, 0o600); // enforce secret perms even if the file pre-existed
}

async function cmdSet(field: string, values: string[]): Promise<void> {
  if (!field || !(field in FIELDS)) usage();

  // `set location` with no id → list what's available (needs login).
  if (field === "location" && values.length === 0) {
    const env = mergedEnv();
    ensureCreds(env);
    const { cfg } = localConfig();
    console.log(`Logging in as ${cfg.userName}…`);
    const session = await login(cfg);
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

  let entries: Record<string, string>;
  try {
    entries = buildEntries(field, values);
  } catch (e) {
    console.error((e as Error).message);
    usage();
  }

  const existed = existsSync(DEV_VARS_PATH);
  const current = existed ? readFileSync(DEV_VARS_PATH, "utf8") : "";
  writeDevVars(upsertEnvVars(current, entries));

  const shown = Object.entries(entries)
    .map(([k, v]) => `${k}=${field === "password" ? "••••••" : v}`)
    .join("  ");
  console.log(`✓ Set ${shown} in ${DEV_VARS_PATH}`);
  if (!existed) {
    console.log("  (created the file — MAYO_USERNAME and MAYO_PASSWORD are both required to punch)");
  }
}

function cmdList(): void {
  const env = mergedEnv();
  // loadConfig requires creds; stub them just to read location/pos/timezone
  // defaults. Real creds status is reported separately from `env`.
  const cfg = loadConfig({
    RESEND_API_KEY: "x",
    NOTIFY_TO: "x@x",
    NOTIFY_FROM: "x@x",
    MAYO_USERNAME: "x",
    MAYO_PASSWORD: "x",
    ...env,
  } as never);

  console.log("Effective config (env > .dev.vars > defaults):\n");
  console.log(`  username : ${env.MAYO_USERNAME || "(not set)"}`);
  console.log(`  password : ${env.MAYO_PASSWORD ? "••••••" : "(not set)"}`);
  console.log(`  location : ${cfg.punchesLocationId}`);
  console.log(`  pos      : ${cfg.latitude}, ${cfg.longitude}`);
  console.log(`  timezone : ${cfg.timezone}`);
  console.log(`\n  source   : ${DEV_VARS_PATH}`);
}

const [cmd, field, ...values] = process.argv.slice(2);
if (cmd === "set") await cmdSet(field, values);
else if (cmd === "list") cmdList();
else usage();
