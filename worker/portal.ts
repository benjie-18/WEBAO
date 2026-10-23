// Client portal API: passwordless sign-in, onboarding form, nudges.
//
// Sign-in has two bootstrap paths:
//  1. Magic link: the client enters their email, we mail a one-time link
//     (POST /api/portal/request-link -> /portal#t=<token> ->
//     POST /api/portal/exchange). Mail goes through SMTP2GO (see mailer.ts);
//     the send_email binding cannot address clients.
//  2. Checkout claim: right after paying, the success page hands us the
//     Stripe checkout session id (POST /api/portal/claim); we verify it
//     against Stripe and sign the browser in. No email dependency, so the
//     portal works before SMTP2GO_API_KEY is configured.
//
// A session is a random token in KV (portal-session:<tok>, 30 days) carried
// by an HttpOnly cookie. The onboarding POST saves the client's answers;
// the first time the form is complete the client advances from stage
// "onboarding" to "build" and the inbox is notified.
//
// Nudges (POST /api/internal/onboarding-nudges, shared-secret Bearer auth).
// Clients who have not finished onboarding get a reminder on day 2 and
// day 5; on day 7 the inbox is notified (escalation) instead of a third
// reminder. A daily cron calls this endpoint.

import { getJson, putJson, deleteKey } from "./kv";
import { throttle } from "./auth";
import {
  CLIENTS_INDEX,
  findClientByEmail,
  findClientByCustomer,
  getClient,
  onboardingComplete,
  saveClient,
  type Client,
  type OnboardingData,
} from "./clients";
import { sendClientEmail } from "./mailer";
import { batch, clampStr, clientIp, err, json, originAllowed, randomHex, readJson, timingSafeEqual } from "./util";

const NOTIFY_INBOX = "webao.ca@gmail.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGIN_TTL = 30 * 60; // one-time sign-in link: 30 minutes
const SESSION_TTL = 30 * 24 * 3600; // portal session: 30 days
const COOKIE = "webao_portal";
const DAY_MS = 24 * 3600 * 1000;

type PortalEnv = Env & { STRIPE_SECRET_KEY?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeHeader(text: string): string {
  return "=?UTF-8?B?" + base64Utf8(text) + "?=";
}

/** Best-effort inbox notification via the send_email binding. */
async function notifyInbox(env: Env, subject: string, lines: string[]): Promise<void> {
  if (!env.EMAIL) return;
  try {
    const raw = [
      `From: "WEBAO" <start@webao.ca>`,
      `To: ${NOTIFY_INBOX}`,
      `Subject: ${encodeHeader(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Utf8(lines.join("\n")),
    ].join("\r\n");
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage("start@webao.ca", NOTIFY_INBOX, raw));
  } catch (e) {
    console.error("portal: inbox notification failed", e);
  }
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = rest.join("=").trim();
      return /^[a-f0-9]{32,}$/.test(value) ? value : null;
    }
  }
  return null;
}

async function clientForSession(req: Request, env: Env): Promise<Client | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const session = await getJson<{ clientId: string }>(env.WEBAO_KV, "portal-session:" + token);
  if (!session?.clientId) return null;
  return getClient(env.WEBAO_KV, session.clientId);
}

async function startSession(env: Env, client: Client): Promise<Response> {
  const token = randomHex(32);
  await putJson(
    env.WEBAO_KV,
    "portal-session:" + token,
    { clientId: client.id, createdAt: Date.now() },
    SESSION_TTL,
  );
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_TTL) });
}

/** Same-origin + per-IP throttle gate shared by the public portal posts. */
async function gate(req: Request, env: Env, scope: string, limit: number): Promise<Response | null> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  if (!(await throttle(env.WEBAO_KV, scope, clientIp(req), limit))) return err("Too many attempts", 429);
  return null;
}

function portalView(client: Client) {
  return {
    email: client.email,
    name: client.name,
    business: client.business,
    lang: client.lang,
    stage: client.stage,
    billingStatus: client.billingStatus,
    items: client.items,
    previewUrl: client.previewUrl,
    createdAt: client.createdAt,
    onboarding: client.onboarding || {},
    onboardingComplete: onboardingComplete(client),
  };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** POST /api/portal/request-link { email } — mail a one-time sign-in link. */
export async function handlePortalRequestLink(req: Request, env: Env): Promise<Response> {
  const denied = await gate(req, env, "portal-link", 5);
  if (denied) return denied;
  let body: { email?: unknown };
  try {
    body = (await readJson(req)) as { email?: unknown };
  } catch (e) {
    return err((e as Error).message);
  }
  const email = clampStr(body.email, 200).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return err("Valid email is required");

  const client = await findClientByEmail(env.WEBAO_KV, email);
  // Unknown emails get the same answer as known ones (no client enumeration);
  // the mail simply never goes out.
  if (!client) return json({ ok: true });
  if (!env.SMTP2GO_API_KEY) {
    return err("Portal email is not configured yet. Use the access link from your checkout, or contact support@webao.ca.", 503);
  }

  const token = randomHex(24);
  await putJson(env.WEBAO_KV, "portal-login:" + token, { clientId: client.id }, LOGIN_TTL);
  const fr = client.lang === "fr";
  const link = `https://webao.ca${fr ? "/fr/portail" : "/portal"}#t=${token}`;
  const sent = await sendClientEmail(env, {
    to: client.email,
    subject: fr ? "Votre lien d'accès au portail WEBAO" : "Your WEBAO portal sign-in link",
    text: fr
      ? [
          "Bonjour,",
          "",
          "Voici votre lien pour ouvrir votre portail client WEBAO. Il est valide 30 minutes et ne fonctionne qu'une seule fois :",
          "",
          link,
          "",
          "Si vous n'avez pas demandé ce lien, ignorez ce courriel.",
          "",
          "L'équipe Webao",
        ].join("\n")
      : [
          "Hi,",
          "",
          "Here is your link to open your WEBAO client portal. It is valid for 30 minutes and works once:",
          "",
          link,
          "",
          "If you did not ask for this link, ignore this email.",
          "",
          "The Webao team",
        ].join("\n"),
  });
  if (!sent) {
    await deleteKey(env.WEBAO_KV, "portal-login:" + token);
    return err("The sign-in email could not be sent. Please try again shortly.", 502);
  }
  return json({ ok: true });
}

/** POST /api/portal/exchange { token } — trade a one-time token for a session. */
export async function handlePortalExchange(req: Request, env: Env): Promise<Response> {
  const denied = await gate(req, env, "portal-exchange", 10);
  if (denied) return denied;
  let body: { token?: unknown };
  try {
    body = (await readJson(req)) as { token?: unknown };
  } catch (e) {
    return err((e as Error).message);
  }
  const token = clampStr(body.token, 100).trim();
  if (!/^[a-f0-9]{32,}$/.test(token)) return err("Invalid or expired link", 401);
  const record = await getJson<{ clientId: string }>(env.WEBAO_KV, "portal-login:" + token);
  if (!record?.clientId) return err("Invalid or expired link", 401);
  await deleteKey(env.WEBAO_KV, "portal-login:" + token);
  const client = await getClient(env.WEBAO_KV, record.clientId);
  if (!client) return err("Invalid or expired link", 401);
  return startSession(env, client);
}

/**
 * POST /api/portal/claim { sessionId } — sign in from the checkout success
 * page. The Stripe session is verified server-side; only a paid session
 * whose customer resolves to a client record signs anyone in.
 */
export async function handlePortalClaim(req: Request, env: PortalEnv): Promise<Response> {
  const denied = await gate(req, env, "portal-claim", 10);
  if (denied) return denied;
  if (!env.STRIPE_SECRET_KEY) return err("Portal claim is not configured yet", 503);
  let body: { sessionId?: unknown };
  try {
    body = (await readJson(req)) as { sessionId?: unknown };
  } catch (e) {
    return err((e as Error).message);
  }
  const sessionId = clampStr(body.sessionId, 200).trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return err("Invalid checkout session");

  let session: {
    payment_status?: string;
    status?: string;
    customer?: string | null;
    customer_email?: string | null;
    customer_details?: { email?: string | null } | null;
  };
  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) return err("Checkout session not found", 404);
    session = (await res.json()) as typeof session;
  } catch {
    return err("Could not verify the checkout session", 502);
  }
  if (session.payment_status !== "paid" && session.status !== "complete") {
    return err("That checkout is not complete", 403);
  }
  let client: Client | null = null;
  if (session.customer) client = await findClientByCustomer(env.WEBAO_KV, session.customer);
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase();
  if (!client && email) client = await findClientByEmail(env.WEBAO_KV, email);
  if (!client) return err("No client account matches that checkout", 404);
  return startSession(env, client);
}

/** POST /api/portal/logout — drop the session. */
export async function handlePortalLogout(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const token = readSessionToken(req);
  if (token) await deleteKey(env.WEBAO_KV, "portal-session:" + token);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

// ---------------------------------------------------------------------------
// Portal data
// ---------------------------------------------------------------------------

/** GET /api/portal/me — the signed-in client's view of their record. */
export async function handlePortalMe(req: Request, env: Env): Promise<Response> {
  const client = await clientForSession(req, env);
  if (!client) return err("Not signed in", 401);
  return json({ ok: true, client: portalView(client) });
}

const TEXT_FIELDS = [
  "businessName",
  "contactName",
  "phone",
  "services",
  "serviceArea",
  "hours",
  "about",
  "brandNotes",
  "domainValue",
  "styleNotes",
  "extraNotes",
] as const;

/** POST /api/portal/onboarding { ...fields } — save onboarding answers. */
export async function handlePortalOnboarding(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const client = await clientForSession(req, env);
  if (!client) return err("Not signed in", 401);
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
  } catch (e) {
    return err((e as Error).message);
  }

  const data: OnboardingData = { ...(client.onboarding || {}) };
  for (const field of TEXT_FIELDS) {
    if (typeof body[field] === "string") data[field] = clampStr(body[field], 2000).trim() || undefined;
  }
  if (typeof body.hasLogo === "boolean") data.hasLogo = body.hasLogo;
  if (typeof body.photosReady === "boolean") data.photosReady = body.photosReady;
  if (body.domainMode === "new" || body.domainMode === "existing") data.domainMode = body.domainMode;
  if (Array.isArray(body.styleDemos)) {
    data.styleDemos = body.styleDemos
      .filter((d): d is string => typeof d === "string")
      .map((d) => clampStr(d, 64))
      .filter((d) => /^[a-z0-9-]+$/.test(d))
      .slice(0, 12);
  }
  client.onboarding = data;
  if (data.businessName && !client.business) client.business = data.businessName;
  if (data.contactName && !client.name) client.name = data.contactName;

  const wasComplete = !!client.onboardingCompletedAt;
  if (!wasComplete && onboardingComplete(client)) {
    client.onboardingCompletedAt = Date.now();
    if (client.stage === "onboarding") client.stage = "build";
    await saveClient(env.WEBAO_KV, client);
    await notifyInbox(env, `Onboarding complete: ${data.businessName || client.email}`, [
      `A client finished the onboarding form; the build can start.`,
      ``,
      `Business: ${data.businessName || ""}`,
      `Contact: ${data.contactName || ""} <${client.email}> ${data.phone || ""}`,
      `Services: ${data.services || ""}`,
      `Area: ${data.serviceArea || ""}`,
      `Domain (${data.domainMode || ""}): ${data.domainValue || ""}`,
      `Style demos: ${(data.styleDemos || []).join(", ") || "(none picked)"}`,
      ``,
      `Record: client:${client.id}, stage: ${client.stage}.`,
    ]);
  } else {
    await saveClient(env.WEBAO_KV, client);
  }
  return json({ ok: true, client: portalView(client) });
}

// ---------------------------------------------------------------------------
// Onboarding nudges + escalation (called daily by a cron, shared-secret auth)
// ---------------------------------------------------------------------------

/** POST /api/internal/onboarding-nudges — day 2 / day 5 reminders, day 7 escalation. */
export async function handleOnboardingNudges(req: Request, env: Env): Promise<Response> {
  const secret = env.INTERNAL_CRON_SECRET;
  if (!secret) return err("Not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, `Bearer ${secret}`)) return err("Unauthorized", 401);

  const kv = env.WEBAO_KV;
  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const clients = await batch(index.slice(0, 200), 25, (k) => getJson<Client>(kv, k));
  const now = Date.now();
  let nudged = 0;
  let escalated = 0;
  let skippedNoMail = 0;

  for (const client of clients) {
    if (!client || client.stage !== "onboarding" || client.onboardingCompletedAt) continue;
    const ageDays = Math.floor((now - client.createdAt) / DAY_MS);
    if (ageDays >= 7 && !client.nudgesEscalatedAt) {
      client.nudgesEscalatedAt = now;
      await saveClient(kv, client);
      escalated++;
      await notifyInbox(env, `Onboarding stalled (7 days): ${client.business || client.email}`, [
        `This client paid ${Math.floor((now - client.createdAt) / DAY_MS)} days ago and has not finished the onboarding form.`,
        ``,
        `Email: ${client.email}`,
        `Business: ${client.business || "(not given yet)"}`,
        `Items: ${client.items.join(", ") || "(none recorded)"}`,
        `Nudges sent: ${client.nudgeCount || 0}`,
        ``,
        `Record: client:${client.id}. A personal follow-up is due.`,
      ]);
      continue;
    }
    // Once escalated, the file is with the owner; no more automated mail.
    if (client.nudgesEscalatedAt) continue;
    const due =
      (ageDays >= 2 && (client.nudgeCount || 0) === 0) ||
      (ageDays >= 5 && (client.nudgeCount || 0) === 1);
    if (!due) continue;
    const fr = client.lang === "fr";
    const link = `https://webao.ca${fr ? "/fr/portail" : "/portal"}`;
    const sent = await sendClientEmail(env, {
      to: client.email,
      subject: fr
        ? "Il ne manque que quelques détails pour démarrer votre site"
        : "Just a few details missing to start your website",
      text: fr
        ? [
            "Bonjour,",
            "",
            "Votre commande WEBAO est bien reçue. Pour démarrer la conception de votre site, il ne manque que vos réponses au court formulaire de démarrage : vos services, votre secteur, vos heures et le nom de domaine que vous voulez.",
            "",
            `Ouvrez votre portail et entrez le courriel de votre commande pour recevoir un lien d'accès : ${link}`,
            "",
            "Dès que le formulaire est complet, la conception commence.",
            "",
            "L'équipe Webao",
          ].join("\n")
        : [
            "Hi,",
            "",
            "Your WEBAO order is in. To start building your website we just need your answers on the short start-up form: your services, your service area, your hours, and the domain name you want.",
            "",
            `Open your portal and enter your order email to get a sign-in link: ${link}`,
            "",
            "As soon as the form is complete, the build starts.",
            "",
            "The Webao team",
          ].join("\n"),
    });
    if (sent) {
      client.nudgeCount = (client.nudgeCount || 0) + 1;
      client.lastNudgeAt = now;
      await saveClient(kv, client);
      nudged++;
    } else {
      skippedNoMail++;
    }
  }
  return json({ ok: true, nudged, escalated, skippedNoMail });
}
