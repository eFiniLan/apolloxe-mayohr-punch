import { describe, it, expect, vi } from "vitest";
import { login } from "../src/auth";

const cfg: any = {
  userName: "me@example.com",
  password: "hunter2",
  userAgent: "test-agent/1.0",
};

const LOGIN_URL =
  "https://auth.mayohr.com/HRM/Account/Login?original_target=https%3A%2F%2Fapolloxe.mayohr.com%2Fta&lang=en-us";
const TOKEN_URL = "https://auth.mayohr.com/Token";
const TICKET_URL_PREFIX = "https://authcommon.mayohr.com/api/auth/checkticket";

function htmlWithToken(token: string) {
  return `<html><body><form><input type="hidden" name="__RequestVerificationToken" value="${token}" /></form></body></html>`;
}

describe("login", () => {
  it("happy path: completes the 3-step flow and returns a session with __ModuleSessionCookie", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u === LOGIN_URL) {
        return new Response(htmlWithToken("csrftoken123"), {
          status: 200,
          headers: { "set-cookie": "__RequestVerificationToken=csrfcookie; Path=/" },
        });
      }
      if (u === TOKEN_URL) {
        return new Response(JSON.stringify({ code: "THECODE" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.startsWith(TICKET_URL_PREFIX)) {
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__ModuleSessionCookie=MODVAL; Path=/" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const session = await login(cfg, f as any);

    expect(session.cookie).toContain("__ModuleSessionCookie=MODVAL");

    // Verify step2 (POST /Token) body carried grant_type=password + scraped token.
    const tokenCall = calls.find((c) => c.url === TOKEN_URL);
    expect(tokenCall).toBeTruthy();
    const bodyStr =
      tokenCall!.init.body instanceof URLSearchParams
        ? tokenCall!.init.body.toString()
        : String(tokenCall!.init.body);
    const params = new URLSearchParams(bodyStr);
    expect(params.get("grant_type")).toBe("password");
    expect(params.get("__RequestVerificationToken")).toBe("csrftoken123");
    expect(params.get("userName")).toBe("me@example.com");
    expect(params.get("password")).toBe("hunter2");

    // Verify step2 was called with the __RequestVerificationToken cookie from step1.
    const tokenCookieHeader =
      tokenCall!.init.headers.cookie ?? tokenCall!.init.headers.Cookie;
    expect(tokenCookieHeader).toContain("__RequestVerificationToken=csrfcookie");
  });

  it("rejects with a clear error when the CSRF token is missing from step1 HTML; step2 never called", async () => {
    const f = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === LOGIN_URL) {
        return new Response("<html><body>no token here</body></html>", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    await expect(login(cfg, f as any)).rejects.toThrow(/token/i);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects with an error mentioning the status on bad credentials (step2 400); step3 never called", async () => {
    const f = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === LOGIN_URL) {
        return new Response(htmlWithToken("csrftoken123"), {
          status: 200,
          headers: { "set-cookie": "__RequestVerificationToken=csrfcookie; Path=/" },
        });
      }
      if (u === TOKEN_URL) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (u.startsWith(TICKET_URL_PREFIX)) {
        throw new Error("step3 should not be called");
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    await expect(login(cfg, f as any)).rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rejects when step3 sets no __ModuleSessionCookie", async () => {
    const f = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === LOGIN_URL) {
        return new Response(htmlWithToken("csrftoken123"), {
          status: 200,
          headers: { "set-cookie": "__RequestVerificationToken=csrfcookie; Path=/" },
        });
      }
      if (u === TOKEN_URL) {
        return new Response(JSON.stringify({ code: "THECODE" }), { status: 200 });
      }
      if (u.startsWith(TICKET_URL_PREFIX)) {
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    await expect(login(cfg, f as any)).rejects.toThrow(/ModuleSessionCookie/);
  });

  it("checkticket is called WITHOUT response_type param", async () => {
    const f = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === LOGIN_URL) {
        return new Response(htmlWithToken("csrftoken123"), {
          status: 200,
          headers: { "set-cookie": "__RequestVerificationToken=csrfcookie; Path=/" },
        });
      }
      if (u === TOKEN_URL) {
        return new Response(JSON.stringify({ code: "THECODE" }), { status: 200 });
      }
      if (u.startsWith(TICKET_URL_PREFIX)) {
        expect(u).not.toContain("response_type");
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__ModuleSessionCookie=MODVAL; Path=/" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    await login(cfg, f as any);
  });
});
