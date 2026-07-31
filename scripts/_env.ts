// Shared bootstrap for the local CLI helpers (punch-now, config-cli).
// Builds the same Config the Worker uses, so the scripts can never drift from
// the deployed behaviour.
//
// Config precedence: environment variables > .dev.vars > wrangler.toml [vars] >
// code defaults. `wrangler.toml [vars]` is the SINGLE source for non-secret config
// (shared with the deployed Worker); `.dev.vars` holds the password (and any local
// overrides). Both are gitignored; `.dev.vars` is also what `wrangler dev` reads.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { parseTomlVars, upsertTomlVars } from "./wrangler-vars";
import { removeEnvVars } from "./dev-vars";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Path to the local secrets file. Defaults to `.dev.vars` in the project root;
 * override with APOLLO_DEV_VARS to point the CLI at an alternate file (also used
 * to exercise `config set` against a throwaway file without touching real creds).
 */
export const DEV_VARS_PATH = process.env.APOLLO_DEV_VARS || join(ROOT, ".dev.vars");

/** Path to wrangler.toml (the non-secret config source). Override with APOLLO_WRANGLER. */
export const WRANGLER_PATH = process.env.APOLLO_WRANGLER || join(ROOT, "wrangler.toml");

/** Minimal dotenv parse of .dev.vars: KEY=value, `#` comments, optional quotes. */
export function readDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(DEV_VARS_PATH, "utf8");
  } catch {
    return out; // absent is fine — env vars may supply everything
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Parse wrangler.toml's [vars] table (non-secret config). Absent file → {}. */
export function readWranglerVars(): Record<string, string> {
  try {
    return parseTomlVars(readFileSync(WRANGLER_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Move any non-secret keys out of .dev.vars into wrangler.toml [vars] (the single
 * source), leaving only the password. Returns the moved keys ([] = nothing to do).
 * Idempotent. The password never moves — wrangler.toml [vars] is uploaded plaintext.
 */
export function migrateDevVars(): string[] {
  const moved = Object.fromEntries(Object.entries(readDevVars()).filter(([k]) => k !== "MAYO_PASSWORD"));
  const keys = Object.keys(moved);
  if (keys.length === 0) return [];
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  writeFileSync(WRANGLER_PATH, upsertTomlVars(read(WRANGLER_PATH), moved));
  writeFileSync(DEV_VARS_PATH, removeEnvVars(read(DEV_VARS_PATH), keys), { mode: 0o600 });
  chmodSync(DEV_VARS_PATH, 0o600);
  return keys;
}

let migrated = false;
/** Run migrateDevVars once per process, announcing (on stderr) what moved. */
function autoMigrate(): void {
  if (migrated) return;
  migrated = true;
  let keys: string[] = [];
  try {
    keys = migrateDevVars();
  } catch {
    return; // a migration hiccup must never block a punch
  }
  if (keys.length) {
    console.error(`apollo: moved ${keys.join(", ")} from .dev.vars → wrangler.toml [vars] (single source)`);
  }
}

/**
 * Merged env for a CLI run: env > .dev.vars > wrangler.toml [vars]. First auto-
 * migrates any stray non-secret keys out of .dev.vars so the two never diverge.
 */
export function mergedEnv(): Record<string, string> {
  autoMigrate();
  return {
    ...readWranglerVars(),
    ...readDevVars(),
    ...(process.env as Record<string, string>),
  };
}

/**
 * Config for a local CLI run, plus where the credentials came from (for display).
 * Exits with a helpful message if no credentials are available.
 */
export function localConfig(): { cfg: Config; credsFrom: string } {
  const env = mergedEnv();

  if (!env.MAYO_USERNAME || !env.MAYO_PASSWORD) {
    console.error(
      "Missing login. Non-secret config lives in wrangler.toml [vars]; the password\n" +
        "lives in .dev.vars (gitignored). Set them with:\n" +
        "  npm run config set username you@company.com   # → wrangler.toml\n" +
        "  npm run config set password                   # → .dev.vars (hidden prompt)\n" +
        "…or supply them as environment variables.",
    );
    process.exit(1);
  }

  const credsFrom = process.env.MAYO_USERNAME ? "environment" : ".dev.vars / wrangler.toml";
  return { cfg: loadConfig(env as never), credsFrom };
}
