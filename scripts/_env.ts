// Shared bootstrap for the local CLI helpers (punch-now, list-locations).
// Builds the same Config the Worker uses, so the scripts can never drift from
// the deployed behaviour.
//
// Credential precedence: environment variables > .dev.vars > code defaults.
// .dev.vars is gitignored and is also what `wrangler dev` reads, so there is
// exactly one place local secrets live.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal dotenv parse of .dev.vars: KEY=value, `#` comments, optional quotes. */
function readDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(join(ROOT, ".dev.vars"), "utf8");
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

/**
 * Config for a local CLI run, plus where the credentials came from (for display).
 * Exits with a helpful message if no credentials are available.
 */
export function localConfig(): { cfg: Config; credsFrom: string } {
  const dev = readDevVars();
  const env: Record<string, string> = {
    // loadConfig requires these; the CLI helpers never send email, so stub them.
    RESEND_API_KEY: "unused",
    NOTIFY_TO: "unused@example.com",
    NOTIFY_FROM: "unused@example.com",
    ...dev,
    ...(process.env as Record<string, string>),
  };

  if (!env.MAYO_USERNAME || !env.MAYO_PASSWORD) {
    console.error(
      "No credentials.\n" +
        "Create .dev.vars (gitignored) in the project root:\n" +
        "  MAYO_USERNAME=you@company.com\n" +
        "  MAYO_PASSWORD=your-password\n" +
        "…or set those as environment variables.",
    );
    process.exit(1);
  }

  const credsFrom = process.env.MAYO_USERNAME ? "environment" : ".dev.vars";
  return { cfg: loadConfig(env as never), credsFrom };
}
