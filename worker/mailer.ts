// Transactional email to clients (arbitrary recipients) via the SMTP2GO API.
//
// The send_email binding can only deliver to the WEBAO inbox (its destination
// is pinned in wrangler.jsonc), so anything addressed to a client — portal
// sign-in links, the welcome email, onboarding nudges — goes through SMTP2GO,
// the same provider the Gmail aliases already send through. Needs the
// SMTP2GO_API_KEY worker secret; without it every send is a no-op returning
// false, and callers degrade gracefully.

import { isTestMode } from "./util";

export interface ClientEmail {
  to: string;
  subject: string;
  text: string;
}

export const INBOX_ADDRESS = "webao.ca@gmail.com";

/** Strip CR/LF so a value can never inject extra MIME headers. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * One header-encoding policy for every inbox mail path (the forms path
 * used to pass ASCII through while portal/webhook always encoded, so the
 * same subject rendered differently by path). Plain-ASCII headers pass
 * through; anything else is RFC 2047 encoded.
 */
export function encodeHeader(text: string): string {
  const safe = headerSafe(text);
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${base64Utf8(safe)}?=`;
}

export interface InboxEmail {
  from: string;
  fromName: string;
  subject: string;
  body: string;
  replyTo?: string;
}

/**
 * The single MIME builder for WEBAO inbox mail (mailer, forms, webhook,
 * portal all used to hand-roll this separately and had already drifted).
 * The send_email binding's destination is pinned to the inbox, so `to`
 * is always the inbox address; `from` is the @webao.ca sender identity.
 */
export function buildInboxEmail(mail: InboxEmail): string {
  const lines = [
    `From: "${headerSafe(mail.fromName)}" <${headerSafe(mail.from)}>`,
    `To: ${INBOX_ADDRESS}`,
    ...(mail.replyTo ? [`Reply-To: ${headerSafe(mail.replyTo)}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Utf8(mail.body),
  ];
  return lines.join("\r\n");
}

/**
 * Best-effort notification to the WEBAO inbox through the send_email
 * binding (the one channel that can only ever reach the inbox).
 */
export async function notifyInbox(
  env: { EMAIL?: SendEmailBinding; TEST_MODE?: string },
  subject: string,
  lines: string[],
): Promise<void> {
  if (!env.EMAIL || isTestMode(env)) return;
  try {
    const raw = buildInboxEmail({
      from: "start@webao.ca",
      fromName: "WEBAO",
      subject,
      body: lines.join("\n"),
    });
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage("start@webao.ca", INBOX_ADDRESS, raw));
  } catch (e) {
    console.error("mailer: inbox notification failed", e);
  }
}

export async function sendClientEmail(
  env: { SMTP2GO_API_KEY?: string; TEST_MODE?: string },
  mail: ClientEmail,
): Promise<boolean> {
  const apiKey = env.SMTP2GO_API_KEY;
  if (isTestMode(env)) return false;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: [mail.to],
        // Display name included: SMTP2GO accepts "Name <email>"
        // for the sender, so clients see "Webao" instead of the
        // bare start@webao.ca address. The address itself is
        // unchanged, so DKIM/SPF alignment is unaffected.
        sender: "Webao <start@webao.ca>",
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
