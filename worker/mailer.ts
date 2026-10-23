// Transactional email to clients (arbitrary recipients) via the SMTP2GO API.
//
// The send_email binding can only deliver to the WEBAO inbox (its destination
// is pinned in wrangler.jsonc), so anything addressed to a client — portal
// sign-in links, the welcome email, onboarding nudges — goes through SMTP2GO,
// the same provider the Gmail aliases already send through. Needs the
// SMTP2GO_API_KEY worker secret; without it every send is a no-op returning
// false, and callers degrade gracefully.

export interface ClientEmail {
  to: string;
  subject: string;
  text: string;
}

const NOTIFY_INBOX = "webao.ca@gmail.com";

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Best-effort notification to the WEBAO inbox through the send_email
 * binding (the one channel that can only ever reach the inbox). Same
 * pattern as portal.ts; kept here so worker modules that must not import
 * the portal can still notify.
 */
export async function notifyInbox(
  env: { EMAIL?: SendEmailBinding },
  subject: string,
  lines: string[],
): Promise<void> {
  if (!env.EMAIL) return;
  try {
    const raw = [
      `From: "WEBAO" <start@webao.ca>`,
      `To: ${NOTIFY_INBOX}`,
      `Subject: =?UTF-8?B?${base64Utf8(subject)}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Utf8(lines.join("\n")),
    ].join("\r\n");
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage("start@webao.ca", NOTIFY_INBOX, raw));
  } catch (e) {
    console.error("mailer: inbox notification failed", e);
  }
}

export async function sendClientEmail(
  env: { SMTP2GO_API_KEY?: string },
  mail: ClientEmail,
): Promise<boolean> {
  const apiKey = env.SMTP2GO_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: [mail.to],
        sender: "start@webao.ca",
        subject: mail.subject,
        text_body: mail.text,
      }),
    });
    if (!res.ok) {
      console.error("smtp2go send failed", res.status);
      return false;
    }
    const data = (await res.json().catch(() => null)) as {
      data?: { succeeded?: number; failed?: number };
    } | null;
    // The API answers 200 with a per-recipient tally; treat a parseable
    // failure tally as failure, anything else 200 as sent.
    if (data?.data && typeof data.data.succeeded === "number") {
      return data.data.succeeded >= 1;
    }
    return true;
  } catch (e) {
    console.error("smtp2go send error", (e as Error)?.message);
    return false;
  }
}
