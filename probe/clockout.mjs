// Makes ONE real clock-out (AttendanceType 2) via the GPS /locate endpoint,
// using the confirmed schema + real Taipei office coords with a small random
// jitter. Reuses the proven login flow. Prints the server response.
//
//   node probe/clockout.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const jar = new Map();
function absorb(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const f = line.split(";", 1)[0];
    const i = f.indexOf("=");
    if (i > 0) jar.set(f.slice(0, i).trim(), f.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function fetchFollow(url, opts = {}, maxHops = 8) {
  let cur = url, method = opts.method ?? "GET", body = opts.body;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(cur, { method, body, redirect: "manual", headers: { "user-agent": UA, cookie: cookieHeader() } });
    absorb(res);
    if (res.status >= 300 && res.status < 400) { const l = res.headers.get("location"); if (!l) return res; cur = new URL(l, cur).href; method = "GET"; body = undefined; continue; }
    return res;
  }
  throw new Error("too many redirects");
}
async function login(s) {
  const LOGIN = "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
  const r1 = await fetch(LOGIN, { headers: { "user-agent": UA } }); absorb(r1);
  const html = await r1.text();
  const m = html.match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) || html.match(/value="([^"]+)"[^>]*\sname="__RequestVerificationToken"/i);
  if (!m) throw new Error("no CSRF token");
  const r2 = await fetch("https://auth.mayohr.com/Token", { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://auth.mayohr.com", referer: LOGIN, cookie: cookieHeader() }, body: new URLSearchParams({ grant_type: "password", userName: s.userName, password: s.password, locale: "en-us", red: "https://apolloxe.mayohr.com/ta", userStatus: "1", __RequestVerificationToken: m[1] }) });
  absorb(r2); const j = await r2.json(); if (!j.code) throw new Error("no code");
  await fetchFollow(`https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(j.code)}`);
  if (!jar.get("__ModuleSessionCookie")) throw new Error("no module cookie");
}

// Uniform random point within `meters` of (lat,lng).
function jitter(lat, lng, meters) {
  const r = meters * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(t)) / 111320;
  const dLng = (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: +(lat + dLat).toFixed(7), lng: +(lng + dLng).toFixed(7) };
}

const s = JSON.parse(readFileSync(join(HERE, "secrets.json"), "utf8"));
await login(s);
console.log("logged in ✓");

const OFFICE_LAT = 25.0781415, OFFICE_LNG = 121.5703676;
const { lat, lng } = jitter(OFFICE_LAT, OFFICE_LNG, 12);
const body = {
  AttendanceType: 2, // clock-out
  Latitude: lat,
  Longitude: lng,
  PunchesLocationId: "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1", // 台北辦公室 L001
  IdentifyCode: crypto.randomUUID(),
  LocationDetails: "",
};
console.log("clock-OUT with jittered coords:", lat, lng, `(office ${OFFICE_LAT}, ${OFFICE_LNG})`);

const res = await fetch("https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate", {
  method: "POST",
  headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-us", "content-type": "application/json", cookie: cookieHeader(), origin: "https://apolloxe.mayohr.com", referer: "https://apolloxe.mayohr.com/ta?id=webpunch" },
  body: JSON.stringify(body),
});
const raw = await res.text();
console.log(`HTTP ${res.status}`);
try { console.log(JSON.stringify(JSON.parse(raw), null, 2)); } catch { console.log(raw.slice(0, 800)); }
