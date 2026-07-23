import type { Config } from "./config";

export interface Session {
  cookie: string; // Cookie header value to send on all subsequent API calls
}

const LOGIN_URL =
  "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
const TOKEN_URL = "https://auth.mayohr.com/Token";
const CHECKTICKET_URL = "https://authcommon.mayohr.com/api/auth/checkticket";
const RED = "https://apolloxe.mayohr.com/ta";

const TOKEN_RE_1 = /name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/i;
const TOKEN_RE_2 = /value="([^"]+)"[^>]*\sname="__RequestVerificationToken"/i;

/**
 * Perform the 3-step MayoHR/Apollo cookie-session login and return a
 * Session carrying the accumulated Cookie jar (including
 * __ModuleSessionCookie) to send on all subsequent API calls.
 *
 * Ported from the proven probe/probe.mjs; see docs/api-facts.md "Auth flow".
 */
export async function login(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<Session> {
  const jar = new Map<string, string>();

  function absorb(res: Response): void {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const first = line.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  // Follow redirects manually so we absorb Set-Cookie at every hop.
  async function fetchFollow(url: string, maxHops = 8): Promise<Response> {
    let current = url;
    for (let i = 0; i < maxHops; i++) {
      const res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": cfg.userAgent, cookie: cookieHeader() },
      });
      absorb(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return res;
        current = new URL(loc, current).href;
        continue;
      }
      return res;
    }
    throw new Error("login: too many redirects following checkticket");
  }

  // ---- Step 1: GET login page -> CSRF token + cookie -----------------------
  const loginRes = await fetchImpl(LOGIN_URL, { headers: { "user-agent": cfg.userAgent } });
  absorb(loginRes);
  const html = await loginRes.text();
  const m = html.match(TOKEN_RE_1) || html.match(TOKEN_RE_2);
  const formToken = m ? m[1] : null;
  if (!formToken || !jar.get("__RequestVerificationToken")) {
    throw new Error("login: could not obtain __RequestVerificationToken (form token or cookie missing)");
  }

  // ---- Step 2: POST /Token -> code ------------------------------------------
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "user-agent": cfg.userAgent,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: "https://auth.mayohr.com",
      referer: LOGIN_URL,
      cookie: cookieHeader(),
    },
    body: new URLSearchParams({
      grant_type: "password",
      userName: cfg.userName,
      password: cfg.password,
      locale: "en-us",
      red: RED,
      userStatus: "1",
      __RequestVerificationToken: formToken,
    }),
  });
  absorb(tokenRes);
  const tokenRaw = await tokenRes.text();
  let tokenJson: any = null;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch {
    // non-JSON body, handled below
  }
  if (!tokenRes.ok || !tokenJson?.code) {
    throw new Error(`login: /Token failed with HTTP ${tokenRes.status}: ${tokenRaw.slice(0, 400)}`);
  }
  const code = tokenJson.code as string;

  // ---- Step 3: GET checkticket (cookie path, NO response_type) -------------
  await fetchFollow(`${CHECKTICKET_URL}?code=${encodeURIComponent(code)}`);
  if (!jar.get("__ModuleSessionCookie")) {
    throw new Error("login: checkticket did not set __ModuleSessionCookie");
  }

  return { cookie: cookieHeader() };
}
