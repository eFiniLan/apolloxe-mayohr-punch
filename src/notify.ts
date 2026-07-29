import type { Config } from "./config";

interface Notification { level: "success" | "failure"; subject: string; body: string }

export async function notify(
  cfg: Config,
  n: Notification,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (n.level === "success" && !cfg.notifyOnSuccess) return;
  if (n.level === "failure" && !cfg.notifyOnFailure) return;

  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: cfg.notifyFrom,
      to: cfg.notifyTo,
      subject: n.subject,
      text: n.body,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
