import type { Config } from "./config";

// "urgent" is the manual-punch safety alarm — it is NEVER suppressed by the
// success/failure toggles, since its whole purpose is to save you from being late.
export interface Notification { level: "success" | "failure" | "urgent"; subject: string; body: string }

export async function notify(
  cfg: Config,
  n: Notification,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (n.level === "success" && !cfg.notifyOnSuccess) return;
  if (n.level === "failure" && !cfg.notifyOnFailure) return;
  // level === "urgent" always sends.

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
