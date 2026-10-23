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
