// Pure read/write of the `[vars]` table in wrangler.toml — the single source for
// NON-secret config, shared by the CLI and the deployed Worker. No `node:` import
// → unit-testable in the Workers pool (config-cli.ts does the file I/O). The
// password never lives here (wrangler uploads [vars] as plaintext on deploy).

/** Parse the active `KEY = "value"` entries under `[vars]` (ignores comments). */
export function parseTomlVars(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inVars = false;
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const q = m[2].match(/^"([^"]*)"/); // quoted string (our values always are)
    out[m[1]] = q ? q[1] : m[2].replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/**
 * Set `KEY = "value"` inside the `[vars]` table: replace the key's active line in
 * place, else insert it just under `[vars]`. Creates a `[vars]` table if absent.
 * Only touches the `[vars]` section; other tables/comments are preserved. Always
 * returns text ending in exactly one newline.
 */
export function upsertTomlVar(contents: string, key: string, value: string): string {
  const lines = contents === "" ? [] : contents.replace(/\n$/, "").split("\n");
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^\\s*${esc}\\s*=`);
  const newLine = `${key} = "${value}"`;

  let varsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "[vars]") {
      varsIdx = i;
      break;
    }
  }
  if (varsIdx === -1) {
    const sep = lines.length && lines[lines.length - 1].trim() !== "" ? [""] : [];
    return [...lines, ...sep, "[vars]", newLine].join("\n") + "\n";
  }

  // Section runs until the next table header, or EOF.
  let end = lines.length;
  for (let i = varsIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = varsIdx + 1; i < end; i++) {
    if (lines[i].trim().startsWith("#")) continue;
    if (keyRe.test(lines[i])) {
      lines[i] = newLine;
      return lines.join("\n") + "\n";
    }
  }
  lines.splice(varsIdx + 1, 0, newLine);
  return lines.join("\n") + "\n";
}

/** Apply upsertTomlVar for each entry (e.g. `pos`'s two coordinate keys). */
export function upsertTomlVars(contents: string, entries: Record<string, string>): string {
  let out = contents;
  for (const [k, v] of Object.entries(entries)) out = upsertTomlVar(out, k, v);
  return out;
}
