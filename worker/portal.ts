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
  adsMinMonthlyBudget,
  adsOnboardingComplete,
  findClientByEmail,
  findClientByCustomer,
  getClient,
  hasAdsPack,
  normalizeDomain,
  onboardingComplete,
  saveClient,
  type AdsOnboarding,
  type Client,
  type OnboardingData,
} from "./clients";
import { adsLeadKey, listAdsLeads } from "./ads";
import { TRADE_IDS } from "./ads-templates";
import { assignDomain } from "./tenants";
import { notifyInbox as notifyInboxShared, sendClientEmail } from "./mailer";
import { getBuildState, publishBuild } from "./builds";
import { monthKey, tenantViews } from "./reports";
import { EMAIL_RE, batch, clampStr, clientIp, err, json, originAllowed, randomHex, readJson, timingSafeEqual } from "./util";

const LOGIN_TTL = 30 * 60; // one-time sign-in link: 30 minutes
const SESSION_TTL = 30 * 24 * 3600; // portal session: 30 days
const COOKIE = "webao_portal";
const DAY_MS = 24 * 3600 * 1000;

type PortalEnv = Env & { STRIPE_SECRET_KEY?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function startSession(
  env: Env,
  client: Client,
  opts?: { viaAdmin?: boolean; ttlSeconds?: number },
): Promise<Response> {
  const token = randomHex(32);
  const ttl = opts?.ttlSeconds ?? SESSION_TTL;
  await putJson(
    env.WEBAO_KV,
    "portal-session:" + token,
    { clientId: client.id, createdAt: Date.now(), ...(opts?.viaAdmin ? { viaAdmin: true } : {}) },
    ttl,
  );
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, ttl) });
}

const ADMIN_VIEW_TTL = 24 * 3600; // admin "view as client" sessions: 24 hours

/**
 * Mint a portal session as if the client had signed in, for the admin
 * panel's "view as client". The session record is flagged viaAdmin so the
 * portal can banner it and /me can report it, and it lives 24 hours
 * instead of the usual 30 days.
 */
export async function startAdminViewSession(env: Env, client: Client): Promise<Response> {
  return startSession(env, client, { viaAdmin: true, ttlSeconds: ADMIN_VIEW_TTL });
}

/** Whether the request's portal session was minted by an admin (view-as). */
export async function sessionViaAdmin(req: Request, env: Env): Promise<boolean> {
  const token = readSessionToken(req);
  if (!token) return false;
  const session = await getJson<{ viaAdmin?: boolean }>(env.WEBAO_KV, "portal-session:" + token);
  return session?.viaAdmin === true;
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
    paymentActionRequired: client.paymentActionRequired || null,
    items: client.items,
    previewUrl: client.previewUrl,
    domain: client.domain,
    domainStatus: client.domainStatus || "none",
    reviewDecision: client.reviewDecision,
    revisionCount: client.revisionCount || 0,
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
  // the mail simply never goes out. That promise holds even when the mailer
  // is unconfigured or a send fails: those paths used to answer 503/502 for
  // known emails only, leaking exactly which addresses are clients.
  if (!client) return json({ ok: true });
  if (!env.SMTP2GO_API_KEY) {
    console.error("portal: sign-in link requested but mail is not configured");
    return json({ ok: true });
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
    // Same ok:true as the unknown-email path: a send failure must not
    // reveal that this address is a client. The failure is logged above.
    return json({ ok: true });
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
  // A checkout counts only once Stripe reports payment. The old OR also
  // accepted a merely "complete" session with payment unpaid, which would
  // sign a browser into the portal before any money moved (reachable today
  // only if an async payment method is ever enabled in Stripe).
  if (session.payment_status !== "paid") {
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

/** GET /api/portal/me — the signed-in client's view of their record.
    Signed-out visits are the normal case (the portal page loads this on
    boot), so they get a clean 200 { authenticated: false } instead of a
    401 — no console error for a visitor who simply isn't signed in. */
export async function handlePortalMe(req: Request, env: Env): Promise<Response> {
  const client = await clientForSession(req, env);
  if (!client) return json({ authenticated: false }, 200);
  const view = portalView(client) as Record<string, unknown>;
  if (await sessionViaAdmin(req, env)) view.viaAdmin = true;
  if (client.stage === "live") {
    const stats = await tenantViews(env.WEBAO_KV, client.id, monthKey(Date.now()));
    view.siteViewsThisMonth = stats.views;
  }
  if (hasAdsPack(client)) {
    view.ads = {
      status: client.ads?.status || "onboarding",
      onboarding: client.ads?.onboarding,
      complete: adsOnboardingComplete(client),
      minBudget: adsMinMonthlyBudget(client),
      leads: await listAdsLeads(env.WEBAO_KV, client.id),
    };
  }
  return json({ ok: true, client: view });
}

/**
 * POST /api/portal/review { decision: "approved" | "changes", note? } —
 * the client's call on the build in review. Approval publishes the site
 * (the QA gate already passed; this is the client's sign-off). A changes
 * request needs a note and sends the record back to the build stage.
 */
export async function handlePortalReview(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const client = await clientForSession(req, env);
  if (!client) return err("Not signed in", 401);
  if (client.stage !== "review") return err("Nothing is in review right now", 409);
  let body: { decision?: unknown; note?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  const state = await getBuildState(env.WEBAO_KV, client.id);
  if (!state.draftBuildId) return err("No build is waiting for review", 409);
  const name = client.business || client.email;

  if (body.decision === "approved") {
    const result = await publishBuild(env, client);
    if (!result.ok) return err(result.error || "Publish failed", 400);
    client.reviewDecision = {
      decision: "approved",
      at: Date.now(),
      buildId: state.draftBuildId,
    };
    await saveClient(env.WEBAO_KV, client);
    // publishBuild already notified the inbox that the site is live.
    return json({ ok: true, client: portalView(client) });
  }

  if (body.decision === "changes") {
    const note = typeof body.note === "string" ? clampStr(body.note, 2000).trim() : "";
    if (!note) return err("Tell us what to change", 400);
    client.reviewDecision = {
      decision: "changes",
      note,
      at: Date.now(),
      buildId: state.draftBuildId,
    };
    client.revisionCount = (client.revisionCount || 0) + 1;
    client.stage = "build";
    await saveClient(env.WEBAO_KV, client);
    await notifyInboxShared(env, `Changes requested: ${name}`, [
      `${name} <${client.email}> asked for changes on build ${state.draftBuildId} (revision ${client.revisionCount}).`,
      ``,
      note,
      ``,
      `Rebuild from the admin Clients tab when ready; a clean QA sends it back to review.`,
    ]);
    await sendClientEmail(env, {
      to: client.email,
      subject:
        client.lang === "fr" ? "Nous avons bien reçu vos changements" : "We received your changes",
      text:
        client.lang === "fr"
          ? `Bonjour,\n\nMerci, nous avons bien reçu vos demandes de changements. Votre site retourne en conception; vous recevrez un nouvel aperçu à réviser.\n\nWebao`
          : `Hello,\n\nThank you, we received your change requests. Your website goes back into build; you will get a fresh preview to review.\n\nWebao`,
    });
    return json({ ok: true, client: portalView(client) });
  }

  return err("Decision must be approved or changes", 400);
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
    // First completion also claims the client's domain: an existing domain
    // waits on its CNAME, a new one queues for registration. A domain
    // already owned by another client is left for the admin to sort out.
    if (!client.domain) {
      const host = normalizeDomain(data.domainValue);
      if (host) {
        await assignDomain(
          env.WEBAO_KV,
          client,
          host,
          data.domainMode === "new" ? "to-register" : "pending-dns",
        );
      }
    }
    await saveClient(env.WEBAO_KV, client);
    await notifyInboxShared(env, `Onboarding complete: ${data.businessName || client.email}`, [
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
  // A domain change after first completion used to be silently ignored:
  // the new value sat in the form data while client.domain kept the old
  // host. Re-run assignment whenever the saved value differs; on conflict
  // the old mapping survives (assignDomain checks before deleting) and
  // the response flags it so the portal can say so.
  let domainConflict = false;
  const newHost = normalizeDomain(data.domainValue);
  if (newHost && newHost !== client.domain) {
    const result = await assignDomain(
      env.WEBAO_KV,
      client,
      newHost,
      data.domainMode === "new" ? "to-register" : "pending-dns",
    );
    if (!result.ok) domainConflict = true;
    else await saveClient(env.WEBAO_KV, client);
  }
  return json({
    ok: true,
    client: portalView(client),
    ...(domainConflict ? { domainConflict: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// Ads Pack: onboarding + lead outcomes
// ---------------------------------------------------------------------------

const ADS_TEXT_LIMITS: Record<string, number> = {
  services: 1000,
  serviceArea: 200,
  websiteUrl: 300,
  leadEmail: 200,
  leadPhone: 60,
  notes: 1000,
};

/** POST /api/portal/ads-onboarding — saves the ads intake form. */
export async function handlePortalAdsOnboarding(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const client = await clientForSession(req, env);
  if (!client) return err("Not signed in", 401);
  if (!hasAdsPack(client)) return err("No Ads Pack on this account", 409);
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
  } catch (e) {
    return err((e as Error).message);
  }
  if (!client.ads) {
    client.ads = { status: "onboarding", platform: "meta", updatedAt: Date.now() };
  }
  const data: AdsOnboarding = { ...(client.ads.onboarding || {}) };
  for (const [field, limit] of Object.entries(ADS_TEXT_LIMITS)) {
    const value = body[field];
    if (typeof value === "string") {
      (data as Record<string, unknown>)[field] = clampStr(value, limit).trim() || undefined;
    }
  }
  // The lead destination is the whole point of the Ads Pack: a typo'd
  // address would silently swallow every instant lead email. Validate
  // only when the caller actually supplied a value, so a legacy record
  // with a stale address does not block unrelated saves.
  if (
    typeof body.leadEmail === "string" &&
    body.leadEmail.trim() &&
    !EMAIL_RE.test(data.leadEmail || "")
  ) {
    return err("A valid lead email is required", 400);
  }
  if (typeof body.trade === "string") {
    data.trade = (TRADE_IDS as readonly string[]).includes(body.trade) ? body.trade : undefined;
  }
  if (typeof body.radiusKm === "number" && Number.isFinite(body.radiusKm)) {
    data.radiusKm = Math.min(200, Math.max(1, Math.round(body.radiusKm)));
  }
  if (typeof body.monthlyBudget === "number" && Number.isFinite(body.monthlyBudget)) {
    data.monthlyBudget = Math.min(100000, Math.max(0, Math.round(body.monthlyBudget)));
  }
  client.ads.onboarding = data;
  client.ads.updatedAt = Date.now();
  const firstComplete = adsOnboardingComplete(client) && !client.ads.onboardingCompletedAt;
  if (firstComplete) {
    client.ads.onboardingCompletedAt = Date.now();
    if (client.ads.status === "onboarding") client.ads.status = "setup";
  }
  await saveClient(env.WEBAO_KV, client);
  if (firstComplete) {
    await notifyInboxShared(env, `Ads onboarding complete: ${client.business || client.email}`, [
      `Trade: ${data.trade || ""}. Area: ${data.serviceArea || ""} (${data.radiusKm || "?"} km).`,
      `Monthly ad budget: $${data.monthlyBudget || 0}. Landing: ${data.websiteUrl || client.domain || ""}.`,
      `Leads to: ${data.leadEmail || ""} ${data.leadPhone || ""}.`,
      `Build the launch packet from the admin Clients tab.`,
    ]);
  }
  return json({
    ok: true,
    ads: {
      status: client.ads.status,
      onboarding: client.ads.onboarding,
      complete: adsOnboardingComplete(client),
      minBudget: adsMinMonthlyBudget(client),
    },
  });
}

/** POST /api/portal/ads-lead-outcome { leadId, outcome } — one tap, optional. */
export async function handlePortalAdsLeadOutcome(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const client = await clientForSession(req, env);
  if (!client) return err("Not signed in", 401);
  let body: { leadId?: unknown; outcome?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  // Only the two real outcomes plus "" (the portal's explicit "clear"
  // button) are accepted. A malformed or missing outcome used to
  // overwrite a recorded outcome with null instead of being rejected.
  if (body.outcome !== "booked" && body.outcome !== "not-fit" && body.outcome !== "") {
    return err("Invalid outcome", 400);
  }
  const outcome = body.outcome === "" ? null : body.outcome;
  if (!leadId) return err("leadId is required", 400);
  const lead = await getJson<{ clientId: string } & Record<string, unknown>>(
    env.WEBAO_KV,
    adsLeadKey(leadId),
  );
  if (!lead || lead.clientId !== client.id) return err("Lead not found", 404);
  lead.outcome = outcome;
  lead.outcomeAt = Date.now();
  await putJson(env.WEBAO_KV, adsLeadKey(leadId), lead);
  return json({ ok: true, leads: await listAdsLeads(env.WEBAO_KV, client.id) });
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
  const clients = await batch(index.slice(0, 1000), 25, (k) => getJson<Client>(kv, k));
  const now = Date.now();
  let nudged = 0;
  let escalated = 0;
  let skippedNoMail = 0;

  for (const client of clients) {
    // Canceled clients never get "your order is in" reminders: the order
    // is not in anymore. (past_due clients still get nudged: their order
    // stands while payment is retried.)
    if (!client || client.test || client.stage !== "onboarding" || client.onboardingCompletedAt || client.billingStatus === "canceled") continue;
    const ageDays = Math.floor((now - client.createdAt) / DAY_MS);
    if (ageDays >= 7 && !client.nudgesEscalatedAt) {
      client.nudgesEscalatedAt = now;
      await saveClient(kv, client);
      escalated++;
      await notifyInboxShared(env, `Onboarding stalled (7 days): ${client.business || client.email}`, [
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
