// Pure .dev.vars editing helpers. No `node:` import → unit-testable in the
// Workers pool. The CLI entrypoint (config-cli.ts) does the actual file I/O.

/** Friendly field name → the .dev.vars env key(s) it maps to. */
export const FIELDS: Record<string, string[]> = {
  username: ["MAYO_USERNAME"],
  password: ["MAYO_PASSWORD"],
  location: ["PUNCHES_LOCATION_ID"],
  pos: ["PUNCH_LATITUDE", "PUNCH_LONGITUDE"],
  calendar: ["CALENDAR_CHECK"],
  session: ["SESSION_CACHE"],
};

/** Fields whose value is an on/off boolean (normalized before writing). */
export const BOOLEAN_FIELDS = new Set(["calendar", "session"]);

/** Normalize an on/off token to "true"/"false"; throws on anything else. */
export function normalizeBool(v: string): string {
  const t = v.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return "true";
  if (["off", "false", "0", "no"].includes(t)) return "false";
  throw new Error(`expected on/off (got "${v}")`);
}

/** Map a friendly field + values to env entries. Throws on unknown field or wrong arity. */
export function buildEntries(field: string, values: string[]): Record<string, string> {
  const keys = FIELDS[field];
  if (!keys) {
    throw new Error(`unknown field "${field}" (expected: ${Object.keys(FIELDS).join(", ")})`);
  }
  if (values.length !== keys.length) {
    throw new Error(`"${field}" needs ${keys.length} value(s), got ${values.length}`);
  }
  const out: Record<string, string> = {};
  keys.forEach((k, i) => (out[k] = values[i]));
  return out;
}

/**
 * Set `KEY=value` in dotenv text: replace the key's line in place (skipping
 * comments; exact-key match so `KEY_X` is not touched) or append it. Preserves
 * other lines/comments; always returns text ending in exactly one newline.
 */
export function upsertEnvVar(contents: string, key: string, value: string): string {
  const newLine = `${key}=${value}`;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^\\s*${esc}\\s*=`);

  // Drop a single trailing newline so split doesn't leave a phantom "" element.
  const lines = contents === "" ? [] : contents.replace(/\n$/, "").split("\n");

  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#")) continue;
    if (keyRe.test(lines[i])) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(newLine);
  }
  return lines.join("\n") + "\n";
}

/** Apply upsertEnvVar for each entry (e.g. `pos`'s two coordinate keys). */
export function upsertEnvVars(contents: string, entries: Record<string, string>): string {
  let out = contents;
  for (const [k, v] of Object.entries(entries)) out = upsertEnvVar(out, k, v);
  return out;
}
