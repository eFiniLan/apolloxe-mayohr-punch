import { describe, it, expect, vi } from "vitest";
import { notify } from "../src/notify";

const cfg: any = { resendApiKey: "re_x", notifyTo: "me@x.com", notifyFrom: "bot@x.com", notifyOnSuccess: true, notifyOnFailure: true };

describe("notify", () => {
  it("posts to Resend with auth + recipients", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await notify(cfg, { level: "success", subject: "S", body: "B" }, f as any);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as any).Authorization).toBe("Bearer re_x");
    expect((init.headers as any)["content-type"]).toBe("application/json");
    const sent = JSON.parse(init.body);
    expect(sent.to).toBe("me@x.com");
    expect(sent.subject).toBe("S");
    expect(sent.from).toBe("bot@x.com");
    expect(sent.text).toBe("B");
  });
  it("suppresses success email when notifyOnSuccess is false", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await notify({ ...cfg, notifyOnSuccess: false }, { level: "success", subject: "S", body: "B" }, f as any);
    expect(f).not.toHaveBeenCalled();
  });
  it("suppresses failure email when notifyOnFailure is false", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await notify({ ...cfg, notifyOnFailure: false }, { level: "failure", subject: "S", body: "B" }, f as any);
    expect(f).not.toHaveBeenCalled();
  });
  it("throws when Resend returns non-2xx status", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 500 }));
    await expect(notify(cfg, { level: "failure", subject: "S", body: "B" }, f as any)).rejects.toThrow(/500/);
  });
});
