// Manual end-to-end test (VERBOSE): login -> read today's calendar -> REAL punch
// via /locate. Run at your clock-in/out time to verify the flow before deploying.
// This makes a REAL punch to your record.
//
//   node scripts/punch-now.mjs in     # clock in  (AttendanceType 1)
//   node scripts/punch-now.mjs out    # clock out (AttendanceType 2)
//
// Credentials: env MAYO_USERNAME/MAYO_PASSWORD, else probe/secrets.json.
// Location/coords: env PUNCH_LATITUDE/PUNCH_LONGITUDE/PUNCHES_LOCATION_ID/GPS_JITTER_METERS,
// else Worker defaults (Taipei L001).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const redact = (v) => (v ? `present (len=${String(v).length}, "${String(v).slice(0, 6)}…")` : "MISSING");

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
  if (process.env.MAYO_USERNAME && process.env.MAYO_PASSWORD) return { userName: process.env.MAYO_USERNAME, password: process.env.MAYO_PASSWORD, _src: "env" };
  try {
    const s = JSON.parse(readFileSync(join(HERE, "..", "probe", "secrets.json"), "utf8"));
    if (s.userName && s.password && !String(s.userName).startsWith("REPLACE")) return { ...s, _src: "probe/secrets.json" };
  } catch {}
  console.error("No credentials: set MAYO_USERNAME + MAYO_PASSWORD, or fill probe/secrets.json.");
  process.exit(1);
}

const jar = new Map();
const absorb = (res) => { for (const l of res.headers.getSetCookie?.() ?? []) { const f = l.split(";", 1)[0]; const i = f.indexOf("="); if (i > 0) jar.set(f.slice(0, i).trim(), f.slice(i + 1).trim()); } };
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function follow(url) { let c = url, hops = 0; for (let i = 0; i < 8; i++) { const r = await fetch(c, { redirect: "manual", headers: { "user-agent": UA, cookie: cookie() } }); absorb(r); if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return { r, hops }; c = new URL(loc, c).href; hops++; continue; } return { r, hops }; } throw new Error("too many redirects"); }
const hhmm = (iso) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "--:--";

// ---- config banner ----
const c = creds();
const nowStr = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
log("\x1b[1mApollo punch-now (verbose)\x1b[0m");
log(`  direction : clock-${dir.toUpperCase()} (AttendanceType ${dir === "in" ? 1 : 2})`);
log(`  now       : ${nowStr} (${TZ})`);
log(`  account   : ${c.userName}  (creds from ${c._src})`);
log(`  location  : ${LOC}`);
log(`  coords    : ${LAT}, ${LNG}  (± ${JIT} m jitter)`);

// ---- login ----
step("Step 1/4 — GET login page (scrape CSRF token)");
const L = "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
const r1 = await fetch(L, { headers: { "user-agent": UA } }); absorb(r1);
log(`  HTTP ${r1.status}`);
const m = (await r1.text()).match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) || [];
if (!m[1]) { console.error("  ✗ could not scrape CSRF token"); process.exit(1); }
ok(`CSRF form token ${redact(m[1])}`);
ok(`CSRF cookie ${redact(jar.get("__RequestVerificationToken"))}`);

step("Step 2/4 — POST /Token (password grant)");
const r2 = await fetch("https://auth.mayohr.com/Token", { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://auth.mayohr.com", referer: L, cookie: cookie() }, body: new URLSearchParams({ grant_type: "password", userName: c.userName, password: c.password, locale: "en-us", red: "https://apolloxe.mayohr.com/ta", userStatus: "1", __RequestVerificationToken: m[1] }) });
absorb(r2);
log(`  HTTP ${r2.status}`);
const tok = await r2.json().catch(() => ({}));
if (!tok.code) { console.error("  ✗ login failed (bad credentials?):", JSON.stringify(tok).slice(0, 300)); process.exit(1); }
ok(`access_token ${redact(tok.access_token)}, code ${redact(tok.code)}`);

step("Step 3/4 — GET checkticket (obtain __ModuleSessionCookie)");
const { r: r3, hops } = await follow(`https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(tok.code)}`);
log(`  HTTP ${r3.status} (after ${hops} redirect hop(s))`);
if (!jar.get("__ModuleSessionCookie")) { console.error("  ✗ no __ModuleSessionCookie — cannot punch"); process.exit(1); }
ok(`__ModuleSessionCookie ${redact(jar.get("__ModuleSessionCookie"))}`);
ok(`cookies held: ${[...jar.keys()].join(", ")}`);

// ---- calendar (the Worker's workday decision) ----
step("Step 4/4 — read today's calendar, then punch");
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
const calUrl = `https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling?year=${parts.year}&month=${+parts.month}`;
log(`  GET ${calUrl}`);
const cal = await (await fetch(calUrl, { headers: { "user-agent": UA, accept: "*/*", "content-type": "application/json", cookie: cookie(), referer: "https://apolloxe.mayohr.com/ta/personal/shiftschedule" } })).json();
const day = (cal?.data?.calendars ?? []).find((d) => String(d.date).startsWith(dateKey));
if (!day) { console.error(`  ✗ no calendar entry for ${dateKey}`); process.exit(1); }
const ss = day.shiftSchedule;
const isWorkday = ss?.workOnTime != null;
log(`  today ${dateKey}:`);
log(`    workday        : ${isWorkday}`);
log(`    scheduled shift: ${hhmm(ss?.originalWorkOnTime ?? ss?.workOnTime)} – ${hhmm(ss?.originalWorkOffTime ?? ss?.workOffTime)}`);
log(`    current workOn : ${hhmm(ss?.workOnTime)}  workOff: ${hhmm(ss?.workOffTime)}  (blank/updates as you punch)`);
log(`    leaveSheets    : ${day.leaveSheets?.length ?? 0}   tripSheets: ${day.tripSheets?.length ?? 0}`);
if (!isWorkday) { log("\n  Not a workday — the Worker would SKIP. Not punching. Exiting."); process.exit(0); }

// ---- punch ----
const r = JIT * Math.sqrt(Math.random()), t = Math.random() * 2 * Math.PI;
const lat = +(LAT + (r * Math.cos(t)) / 111320).toFixed(7);
const lng = +(LNG + (r * Math.sin(t)) / (111320 * Math.cos((LAT * Math.PI) / 180))).toFixed(7);
const body = { AttendanceType: dir === "in" ? 1 : 2, Latitude: lat, Longitude: lng, PunchesLocationId: LOC, IdentifyCode: crypto.randomUUID(), LocationDetails: "" };
log(`\n  POST https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate`);
log(`  body: ${JSON.stringify(body)}`);
log(`  (jittered ${(Math.hypot((lat - LAT) * 111320, (lng - LNG) * 111320 * Math.cos((LAT * Math.PI) / 180))).toFixed(1)} m from the office point)`);
const res = await fetch("https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate", { method: "POST", headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-us", "content-type": "application/json", cookie: cookie(), origin: "https://apolloxe.mayohr.com", referer: "https://apolloxe.mayohr.com/ta?id=webpunch" }, body: JSON.stringify(body) });
const j = await res.json().catch(() => ({}));
log(`\n  HTTP ${res.status}`);
log(`  response: ${JSON.stringify(j, null, 2)}`);

log("");
if (j?.Meta?.HttpStatusCode === "200" && j?.Data?.AttendanceHistoryId) log(`\x1b[32m✅ SUCCESS — Mayo recorded clock-${dir} at ${j.Data.punchDate} @ ${j.Data.LocationName}\x1b[0m`);
else if (/^PT_TodayHas.*Records$/.test(j?.Error?.Status ?? "")) log(`\x1b[33m✅ Already clocked ${dir} today (${j.Error.Title}) — nothing to do (idempotent).\x1b[0m`);
else log(`\x1b[31m❌ FAILED: ${JSON.stringify(j?.Error ?? j)}\x1b[0m`);
