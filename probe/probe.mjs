// Read-only login + calendar probe for MayoHR / Apollo (apolloxe).
// Runs the full auth flow, obtains the __ModuleSessionCookie, then reads the
// personal scheduling calendar. Performs NO punch and writes nothing.
//
// Usage:
//   1. Put real credentials in probe/secrets.json (gitignored).
//   2. node probe/probe.mjs
// Never prints the password. Session tokens shown redacted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const LOGIN_URL =
  "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
const TOKEN_URL = "https://auth.mayohr.com/Token";
const RED = "https://apolloxe.mayohr.com/ta";

// ---- cookie jar ------------------------------------------------------------
const jar = new Map();
function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const first = line.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const redact = (s) => (!s ? "(absent)" : `present, length=${s.length}, starts "${String(s).slice(0, 4)}…"`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

// Follow redirects manually so we absorb Set-Cookie at every hop.
async function fetchFollow(url, opts = {}, maxHops = 8) {
  let current = url;
  let method = opts.method ?? "GET";
  let body = opts.body;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, {
      method,
      body,
      redirect: "manual",
      headers: { "user-agent": UA, cookie: cookieHeader(), ...(opts.extraHeaders ?? {}) },
    });
    absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).href;
      method = "GET";
      body = undefined;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function main() {
  let secrets;
  try {
    secrets = JSON.parse(readFileSync(join(HERE, "secrets.json"), "utf8"));
  } catch (e) {
    bad(`Could not read probe/secrets.json: ${e.message}`);
    process.exit(1);
  }
  if (!secrets.userName || !secrets.password || String(secrets.userName).startsWith("REPLACE")) {
    bad("Fill in userName and password in probe/secrets.json first.");
    process.exit(1);
  }

  // ---- Step 1: login page -> CSRF token + cookie -------------------------
  console.log("\nStep 1: GET login page");
  const loginRes = await fetch(LOGIN_URL, { headers: { "user-agent": UA } });
  absorb(loginRes);
  const html = await loginRes.text();
  const m =
    html.match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i) ||
    html.match(/value="([^"]+)"[^>]*\sname="__RequestVerificationToken"/i);
  const formToken = m ? m[1] : null;
  console.log(`  HTTP ${loginRes.status}`);
  formToken ? ok("scraped CSRF form token") : bad("no CSRF form token");
  if (!formToken || !jar.get("__RequestVerificationToken")) return void bad("Step 1 failed");

  // ---- Step 2: POST /Token -> code ---------------------------------------
  console.log("\nStep 2: POST /Token");
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: "https://auth.mayohr.com",
      referer: LOGIN_URL,
      cookie: cookieHeader(),
    },
    body: new URLSearchParams({
      grant_type: "password",
      userName: secrets.userName,
      password: secrets.password,
      locale: "en-us",
      red: RED,
      userStatus: "1",
      __RequestVerificationToken: formToken,
    }),
  });
  absorb(tokenRes);
  const tokenRaw = await tokenRes.text();
  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch {}
  console.log(`  HTTP ${tokenRes.status}`);
  if (!tokenRes.ok || !tokenJson?.code) {
    bad("login failed");
    console.log("  body:", tokenRaw.slice(0, 400));
    return;
  }
  ok(`got code (${redact(tokenJson.code)})`);
  const code = tokenJson.code;

  // ---- Step 3: checkticket (cookie path, no response_type) ----------------
  console.log("\nStep 3: GET checkticket (cookie path) — expect __ModuleSessionCookie");
  const before = new Set(jar.keys());
  const ticketRes = await fetchFollow(
    `https://authcommon.mayohr.com/api/auth/checkticket?code=${encodeURIComponent(code)}`,
  );
  console.log(`  final HTTP ${ticketRes.status}`);
  const newCookies = [...jar.keys()].filter((k) => !before.has(k));
  if (newCookies.length) console.log(`  new cookies set: ${newCookies.join(", ")}`);
  const moduleCookie = jar.get("__ModuleSessionCookie");
  moduleCookie ? ok(`__ModuleSessionCookie: ${redact(moduleCookie)}`) : bad("no __ModuleSessionCookie");
  if (!moduleCookie) {
    bad("Cannot read calendar without the module session cookie.");
    console.log("  cookies held:", [...jar.keys()].join(", "));
    return;
  }

  // ---- Step 4: read the scheduling calendar (cookie auth) -----------------
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const calUrl = `https://apolloxe.mayohr.com/backend/platform-bff/api/calendars/employees/scheduling?year=${y}&month=${mo}`;
  console.log(`\nStep 4: GET calendar  (year=${y} month=${mo})`);
  const calRes = await fetch(calUrl, {
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "accept-language": "en-us",
      "content-type": "application/json",
      cookie: cookieHeader(),
      referer: "https://apolloxe.mayohr.com/ta/personal/shiftschedule",
    },
  });
  console.log(`  HTTP ${calRes.status}`);
  const calRaw = await calRes.text();
  let calJson = null;
  try {
    calJson = JSON.parse(calRaw);
  } catch {}
  if (!calJson) {
    bad("calendar response was not JSON");
    console.log("  body:", calRaw.slice(0, 400));
    return;
  }
  ok(`calendar read OK`);
  const twTime = (iso) =>
    iso
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Taipei",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(iso))
      : "--:--";
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const days = calJson?.data?.calendars ?? [];
  console.log(`\n----- PER-DAY SUMMARY (${days.length} days) -----`);
  console.log("date        dow shift on(TW) off(TW) orig_on leave trip event");
  for (const d of days) {
    const date = String(d.date).slice(0, 10);
    const dow = DOW[new Date(d.date).getUTCDay()];
    const ss = d.shiftSchedule;
    console.log(
      `${date}  ${dow}   ${ss ? "Y" : "N"}    ${twTime(ss?.workOnTime)}  ${twTime(ss?.workOffTime)}   ${twTime(
        ss?.originalWorkOnTime,
      )}    ${d.leaveSheets?.length ?? 0}     ${d.tripSheets?.length ?? 0}    ${d.calendarEvent ? "Y" : ""}`,
    );
  }

  // Dump the telling days in full: a weekend, today, and a future workday.
  const todayTW = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const pick = (pred, label) => {
    const d = days.find(pred);
    if (d) {
      console.log(`\n----- FULL DAY (${label}: ${String(d.date).slice(0, 10)}) -----`);
      console.log(JSON.stringify(d, null, 2));
    }
  };
  pick((d) => [0, 6].includes(new Date(d.date).getUTCDay()), "a weekend day");
  pick((d) => String(d.date).slice(0, 10) === todayTW, `today ${todayTW}`);
  pick((d) => String(d.date).slice(0, 10) > todayTW && d.shiftSchedule, "a future workday");
  pick((d) => (d.leaveSheets?.length ?? 0) > 0, "a day with leaveSheets");

  console.log("\n\x1b[32m==== DONE (login + module cookie + calendar all OK) ====\x1b[0m");
}

main().catch((e) => {
  bad(`Unexpected error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
