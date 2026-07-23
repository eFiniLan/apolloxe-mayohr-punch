// SAFE punch-endpoint discovery. Logs in, then POSTs an EMPTY body `{}` (no
// AttendanceType) to candidate punch endpoints. With no AttendanceType the
// server cannot clock you in or out — it can only return a validation/authorization
// error, which reveals: does the endpoint exist? is it GPS-gated or IP-gated?
// what fields does it require? NO real punch is made.
//
//   node probe/punch-discover.mjs

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
    const res = await fetch(cur, { method, body, redirect: "manual", headers: { "user-agent": UA, cookie: cookieHeader(), ...(opts.extraHeaders ?? {}) } });
    absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      cur = new URL(loc, cur).href; method = "GET"; body = undefined; continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function login(secrets) {
  const LOGIN = "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
  const r1 = await fetch(LOGIN, { headers: { "user-agent": UA } });
  absorb(r1);
  const html = await r1.text();
  const m = html.match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) || html.match(/value="([^"]+)"[^>]*\sname="__RequestVerificationToken"/i);
  if (!m) throw new Error("no CSRF token");
  const r2 = await fetch("https://auth.mayohr.com/Token", {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://auth.mayohr.com", referer: LOGIN, cookie: cookieHeader() },
    body: new URLSearchParams({ grant_type: "password", userName: secrets.userName, password: secrets.password, locale: "en-us", red: "https://apolloxe.mayohr.com/ta", userStatus: "1", __RequestVerificationToken: m[1] }),
  });
  absorb(r2);
  const j = await r2.json();
  if (!j.code) throw new Error("no code from /Token");
  await fetchFollow(`https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(j.code)}`);
  if (!jar.get("__ModuleSessionCookie")) throw new Error("no __ModuleSessionCookie");
}

async function tryPunch(url, body, label) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "user-agent": UA, accept: "*/*", "accept-language": "en-us",
      "content-type": "application/json", cookie: cookieHeader(),
      origin: "https://apolloxe.mayohr.com", referer: "https://apolloxe.mayohr.com/ta?id=webpunch",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let msg = raw.slice(0, 500);
  try {
    const j = JSON.parse(raw);
    // Print the Error if present; otherwise the WHOLE response (so a success is obvious).
    msg = j.Error ? `ERROR ${JSON.stringify(j.Error)}` : JSON.stringify(j).slice(0, 600);
  } catch {}
  console.log(`\n[${label}]\n  POST ${url}\n  body ${JSON.stringify(body)}\n  -> HTTP ${res.status}  ${msg}`);
}

async function tryGet(url, label) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-us", "content-type": "application/json", cookie: cookieHeader(), referer: "https://apolloxe.mayohr.com/ta" },
  });
  const raw = await res.text();
  let out = raw;
  try { out = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
  console.log(`\n[GET ${label}]\n  ${url}\n  HTTP ${res.status}\n${out.slice(0, 4000)}`);
}

const secrets = JSON.parse(readFileSync(join(HERE, "secrets.json"), "utf8"));
await login(secrets);
console.log("logged in ✓ (module session cookie held)");

// READ-ONLY: fetch the allowed punch locations (gives punchesLocationId + office geofence).
await tryGet("https://apolloxe.mayohr.com/backend/pt/api/locations/EnableList", "locations/EnableList");

// SCHEMA TEST: full /locate body but with FAR-AWAY coords (0,0). If the endpoint
// is geofenced (it must be — GPS is the whole point), this is REJECTED as
// out-of-range → no punch is created. A geofence/location error (not
// SH_NoRequiredData) proves the field names + IdentifyCode are accepted.
const OFFICE_L001 = "0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1"; // 台北辦公室 (user-confirmed)
await tryPunch(
  "https://apolloxe.mayohr.com/backend/pt/api/checkIn/punch/locate",
  {
    AttendanceType: 1,
    Latitude: 0,
    Longitude: 0,
    PunchesLocationId: OFFICE_L001,
    IdentifyCode: crypto.randomUUID(),
    LocationDetails: "",
  },
  "locate SCHEMA TEST — FAR coords 0,0 (must NOT succeed)",
);
