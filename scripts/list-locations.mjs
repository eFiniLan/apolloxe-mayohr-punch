// Setup helper: lists your Apollo punch locations so you can choose which one
// the Worker should use, then set PUNCHES_LOCATION_ID in wrangler.toml.
// Read-only — logs in and GETs locations/EnableList. Makes no punch.
//
// Credentials (login email + password) are read from, in order:
//   1. env vars MAYO_USERNAME / MAYO_PASSWORD
//   2. probe/secrets.json  { "userName": "...", "password": "..." }
//
//   MAYO_USERNAME=you@co.com MAYO_PASSWORD=... node scripts/list-locations.mjs
//   # or, if probe/secrets.json is filled in:
//   node scripts/list-locations.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function creds() {
  if (process.env.MAYO_USERNAME && process.env.MAYO_PASSWORD) {
    return { userName: process.env.MAYO_USERNAME, password: process.env.MAYO_PASSWORD };
  }
  try {
    const s = JSON.parse(readFileSync(join(HERE, "..", "probe", "secrets.json"), "utf8"));
    if (s.userName && s.password && !String(s.userName).startsWith("REPLACE")) return s;
  } catch {}
  console.error("No credentials. Set MAYO_USERNAME + MAYO_PASSWORD env vars, or fill probe/secrets.json.");
  process.exit(1);
}

const jar = new Map();
const absorb = (res) => {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const f = line.split(";", 1)[0];
    const i = f.indexOf("=");
    if (i > 0) jar.set(f.slice(0, i).trim(), f.slice(i + 1).trim());
  }
};
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function fetchFollow(url) {
  let cur = url;
  for (let i = 0; i < 8; i++) {
    const res = await fetch(cur, { redirect: "manual", headers: { "user-agent": UA, cookie: cookieHeader() } });
    absorb(res);
    if (res.status >= 300 && res.status < 400) { const l = res.headers.get("location"); if (!l) return res; cur = new URL(l, cur).href; continue; }
    return res;
  }
  throw new Error("too many redirects");
}
async function login(s) {
  const LOGIN = "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
  const r1 = await fetch(LOGIN, { headers: { "user-agent": UA } }); absorb(r1);
  const html = await r1.text();
  const m = html.match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) || html.match(/value="([^"]+)"[^>]*\sname="__RequestVerificationToken"/i);
  if (!m) throw new Error("could not scrape CSRF token");
  const r2 = await fetch("https://auth.mayohr.com/Token", {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://auth.mayohr.com", referer: LOGIN, cookie: cookieHeader() },
    body: new URLSearchParams({ grant_type: "password", userName: s.userName, password: s.password, locale: "en-us", red: "https://apolloxe.mayohr.com/ta", userStatus: "1", __RequestVerificationToken: m[1] }),
  });
  absorb(r2);
  const j = await r2.json();
  if (!j.code) throw new Error("login failed (no code) — check credentials");
  await fetchFollow(`https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(j.code)}`);
  if (!jar.get("__ModuleSessionCookie")) throw new Error("login failed (no session cookie)");
}

await login(creds());
const res = await fetch("https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate".replace("checkIn/punch/locate", "locations/EnableList"), {
  headers: { "user-agent": UA, accept: "*/*", "content-type": "application/json", cookie: cookieHeader(), referer: "https://apolloxe.mayohr.com/ta" },
});
const data = (await res.json())?.Data ?? [];
if (!data.length) { console.error("No locations returned."); process.exit(1); }

console.log("\nYour Apollo punch locations:\n");
console.log("  " + "PunchesLocationId".padEnd(38) + "Code".padEnd(8) + "Name");
console.log("  " + "-".repeat(70));
for (const loc of data) {
  console.log("  " + String(loc.PunchesLocationId).padEnd(38) + String(loc.LocationCode).padEnd(8) + loc.LocationName);
}
console.log(
  "\nPick the office you punch from and set it in wrangler.toml:\n" +
  '  [vars]\n  PUNCHES_LOCATION_ID = "<the PunchesLocationId above>"\n',
);
