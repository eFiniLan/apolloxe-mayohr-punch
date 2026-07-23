// Manual end-to-end test: login -> read today's calendar -> REAL punch via /locate.
// Run this yourself at your clock-in (or clock-out) time to verify the flow works
// unattended, before deploying the Worker. This makes a REAL punch to your record.
//
//   node scripts/punch-now.mjs in     # clock in  (AttendanceType 1)
//   node scripts/punch-now.mjs out    # clock out (AttendanceType 2)
//
// Credentials: env MAYO_USERNAME/MAYO_PASSWORD, else probe/secrets.json.
// Location/coords: env PUNCH_LATITUDE/PUNCH_LONGITUDE/PUNCHES_LOCATION_ID/GPS_JITTER_METERS,
// else the same defaults as the Worker (Taipei L001).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = (process.argv[2] || "").toLowerCase();
if (dir !== "in" && dir !== "out") {
  console.error("Usage: node scripts/punch-now.mjs in|out");
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const LAT = parseFloat(process.env.PUNCH_LATITUDE ?? "25.0781415");
const LNG = parseFloat(process.env.PUNCH_LONGITUDE ?? "121.5703676");
const LOC = process.env.PUNCHES_LOCATION_ID ?? "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1"; // 台北辦公室
const JIT = Number(process.env.GPS_JITTER_METERS ?? "12");
const TZ = process.env.TIMEZONE ?? "Asia/Taipei";

function creds() {
  if (process.env.MAYO_USERNAME && process.env.MAYO_PASSWORD) return { userName: process.env.MAYO_USERNAME, password: process.env.MAYO_PASSWORD };
  try {
    const s = JSON.parse(readFileSync(join(HERE, "..", "probe", "secrets.json"), "utf8"));
    if (s.userName && s.password && !String(s.userName).startsWith("REPLACE")) return s;
  } catch {}
  console.error("No credentials: set MAYO_USERNAME + MAYO_PASSWORD, or fill probe/secrets.json.");
  process.exit(1);
}

const jar = new Map();
const absorb = (res) => { for (const l of res.headers.getSetCookie?.() ?? []) { const f = l.split(";", 1)[0]; const i = f.indexOf("="); if (i > 0) jar.set(f.slice(0, i).trim(), f.slice(i + 1).trim()); } };
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function follow(url) { let c = url; for (let i = 0; i < 8; i++) { const r = await fetch(c, { redirect: "manual", headers: { "user-agent": UA, cookie: cookie() } }); absorb(r); if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; c = new URL(loc, c).href; continue; } return r; } throw new Error("too many redirects"); }
async function login(s) {
  const L = "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
  const r1 = await fetch(L, { headers: { "user-agent": UA } }); absorb(r1);
  const m = (await r1.text()).match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) || [];
  if (!m[1]) throw new Error("no CSRF token");
  const r2 = await fetch("https://auth.mayohr.com/Token", { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://auth.mayohr.com", referer: L, cookie: cookie() }, body: new URLSearchParams({ grant_type: "password", userName: s.userName, password: s.password, locale: "en-us", red: "https://apolloxe.mayohr.com/ta", userStatus: "1", __RequestVerificationToken: m[1] }) });
  absorb(r2); const j = await r2.json(); if (!j.code) throw new Error("login failed (bad credentials?)");
  await follow(`https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(j.code)}`);
  if (!jar.get("__ModuleSessionCookie")) throw new Error("login failed (no session)");
}
function jitter(lat, lng, meters) { const r = meters * Math.sqrt(Math.random()), t = Math.random() * 2 * Math.PI; return { lat: +(lat + (r * Math.cos(t)) / 111320).toFixed(7), lng: +(lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180))).toFixed(7) }; }
const hhmm = (iso) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "--:--";

await login(creds());
console.log("login ✓");

// Today's calendar (same check the Worker does).
const now = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((p) => [p.type, p.value]));
const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
const cal = await (await fetch(`https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling?year=${+parts.month === 0 ? parts.year : parts.year}&month=${+parts.month}`, { headers: { "user-agent": UA, accept: "*/*", "content-type": "application/json", cookie: cookie(), referer: "https://apolloxe.mayohr.com/ta/personal/shiftschedule" } })).json();
const day = (cal?.data?.calendars ?? []).find((d) => String(d.date).startsWith(dateKey));
const ss = day?.shiftSchedule;
const isWorkday = ss?.workOnTime != null;
console.log(`today ${dateKey}: workday=${isWorkday}` + (isWorkday ? `  shift ${hhmm(ss.originalWorkOnTime ?? ss.workOnTime)}–${hhmm(ss.originalWorkOffTime ?? ss.workOffTime)}` : "  (weekend/holiday — the Worker would skip)"));
if (!isWorkday) { console.log("Not a workday — the Worker would NOT punch. Exiting without punching."); process.exit(0); }

const { lat, lng } = jitter(LAT, LNG, JIT);
const body = { AttendanceType: dir === "in" ? 1 : 2, Latitude: lat, Longitude: lng, PunchesLocationId: LOC, IdentifyCode: crypto.randomUUID(), LocationDetails: "" };
console.log(`clock-${dir.toUpperCase()} at coords ${lat},${lng} (office ${LAT},${LNG} ±${JIT}m) …`);
const res = await fetch("https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate", { method: "POST", headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-us", "content-type": "application/json", cookie: cookie(), origin: "https://apolloxe.mayohr.com", referer: "https://apolloxe.mayohr.com/ta?id=webpunch" }, body: JSON.stringify(body) });
const j = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}`);
if (j?.Meta?.HttpStatusCode === "200" && j?.Data?.AttendanceHistoryId) console.log(`✅ SUCCESS — Mayo recorded ${j.Data.punchDate} @ ${j.Data.LocationName}`);
else if (/^PT_TodayHas.*Records$/.test(j?.Error?.Status ?? "")) console.log(`✅ already clocked ${dir} today (${j.Error.Title}) — nothing to do`);
else console.log(`❌ FAILED:`, JSON.stringify(j?.Error ?? j));
