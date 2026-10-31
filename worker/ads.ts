// Ads Pack operations: lead intake, outcomes, spend records, the launch
// packet and the readiness gate.
//
// Actual campaign creation on Meta waits on WEBAO's app review
// (ads_management). Everything around it lives here: a lead that arrives
// from any source (Meta lead sync, a landing page, a manual entry) is
// stored against the client, emailed to the client instantly, shown in
// their portal, and can be marked booked or not a fit with one tap, which
// is what makes cost-per-booked-job reporting possible later.

import {
  adsMinMonthlyBudget,
  adsOnboardingComplete,
  getClient,
  hasAdsPack,
  type Client,
} from "./clients";
import { getJson, putJson } from "./kv";
import { notifyInbox, sendClientEmail } from "./mailer";
import { fillTemplate, tradeTemplate } from "./ads-templates";
import { err, json, readJson, timingSafeEqual } from "./util";

export interface AdsEnv {
  WEBAO_KV: KVNamespace;
  SMTP2GO_API_KEY?: string;
  EMAIL?: SendEmailBinding;
  INTERNAL_CRON_SECRET?: string;
}

export interface AdsLead {
  id: string;
  clientId: string;
  at: number;
  name: string;
  phone?: string;
  email?: string;
  service?: string;
  message?: string;
  source?: string;
  outcome?: "booked" | "not-fit" | null;
  outcomeAt?: number;
}

export const adsLeadKey = (id: string): string => `adslead:${id}`;
export const adsLeadsIndexKey = (clientId: string): string => `adsleads:${clientId}`;
export const adsSpendKey = (clientId: string, month: string): string =>
  `adsspend:${clientId}:${month}`;

const MAX_LEADS_PER_CLIENT = 500;

function newLeadId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "al_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function recordAdsLead(
  kv: KVNamespace,
  clientId: string,
  data: Omit<AdsLead, "id" | "clientId" | "at" | "outcome"> & { at?: number },
): Promise<AdsLead> {
  const lead: AdsLead = {
    id: newLeadId(),
    clientId,
    at: data.at ?? Date.now(),
    name: data.name,
    phone: data.phone,
    email: data.email,
    service: data.service,
    message: data.message,
    source: data.source,
    outcome: null,
  };
  await putJson(kv, adsLeadKey(lead.id), lead);
  const index = (await getJson<string[]>(kv, adsLeadsIndexKey(clientId))) || [];
  index.unshift(lead.id);
  await putJson(kv, adsLeadsIndexKey(clientId), index.slice(0, MAX_LEADS_PER_CLIENT));
  return lead;
}

export async function listAdsLeads(
  kv: KVNamespace,
  clientId: string,
  limit: number = 20,
): Promise<AdsLead[]> {
  const index = (await getJson<string[]>(kv, adsLeadsIndexKey(clientId))) || [];
  const leads: AdsLead[] = [];
  for (const id of index.slice(0, limit)) {
    const lead = await getJson<AdsLead>(kv, adsLeadKey(id));
    if (lead) leads.push(lead);
  }
  return leads;
}

/** All lead ids for a client (newest first), for reporting counts. */
export async function adsLeadIds(kv: KVNamespace, clientId: string): Promise<string[]> {
  return (await getJson<string[]>(kv, adsLeadsIndexKey(clientId))) || [];
}

export async function recordAdsSpend(
  kv: KVNamespace,
  clientId: string,
  month: string,
  amountCents: number,
): Promise<void> {
  await putJson(kv, adsSpendKey(clientId, month), { amountCents, at: Date.now() });
}

export async function adsSpend(
  kv: KVNamespace,
  clientId: string,
  month: string,
): Promise<number | null> {
  const rec = await getJson<{ amountCents: number }>(kv, adsSpendKey(clientId, month));
  return rec ? rec.amountCents : null;
}

// ---------------------------------------------------------------------------
// Readiness + launch packet
// ---------------------------------------------------------------------------

export interface ReadinessCheck {
  id: string;
  ok: boolean;
  labelEn: string;
  labelFr: string;
}

export function adsReadiness(client: Client): ReadinessCheck[] {
  const o = client.ads?.onboarding;
  const landing = Boolean(o?.websiteUrl?.trim() || client.domain);
  return [
    {
      id: "pack",
      ok: hasAdsPack(client),
      labelEn: "Ads Pack purchased",
      labelFr: "Forfait publicitaire acheté",
    },
    {
      id: "onboarding",
      ok: adsOnboardingComplete(client),
      labelEn: "Ads onboarding complete (trade, area, budget, lead contact)",
      labelFr: "Formulaire publicitaire complet (métier, zone, budget, contact)",
    },
    {
      id: "budget",
      ok: typeof o?.monthlyBudget === "number" && o.monthlyBudget >= adsMinMonthlyBudget(client),
      labelEn: `Monthly ad budget at least $${adsMinMonthlyBudget(client)} on the client's card`,
      labelFr: `Budget publicitaire mensuel d'au moins ${adsMinMonthlyBudget(client)} $ sur la carte du client`,
    },
    {
      id: "landing",
      ok: landing,
      labelEn: "Landing page known (their site or the WEBAO domain)",
      labelFr: "Page d'arrivée connue (leur site ou le domaine Webao)",
    },
    {
      id: "account",
      ok: Boolean(client.ads?.adAccountId),
      labelEn: "Client ad account connected (partner access granted)",
      labelFr: "Compte publicitaire du client connecté (accès partenaire accordé)",
    },
  ];
}

export function adsReady(client: Client): boolean {
  return adsReadiness(client).every((c) => c.ok);
}

export interface LaunchPacket {
  business: string;
  trade: string;
  platform: "meta" | "google" | "both";
  monthlyBudget: number | null;
  dailyBudget: number | null;
  serviceArea: string;
  radiusKm: number;
  landingPage: string;
  leadDelivery: { email?: string; phone?: string };
  services: string[];
  headlines: string[];
  primaryTexts: string[];
  formQuestions: string[];
  readiness: ReadinessCheck[];
  ready: boolean;
}

/** Everything an operator needs to launch this client's first campaign. */
export function buildLaunchPacket(client: Client): LaunchPacket {
  const o = client.ads?.onboarding;
  const fr = client.lang === "fr";
  const tpl = tradeTemplate(o?.trade);
  const business = client.business || "";
  const area = o?.serviceArea || "";
  const monthly = typeof o?.monthlyBudget === "number" ? o.monthlyBudget : null;
  const fill = (s: string) => fillTemplate(s, business, area);
  return {
    business,
    trade: fr ? tpl.labelFr : tpl.labelEn,
    platform: client.ads?.platform ?? "meta",
    monthlyBudget: monthly,
    dailyBudget: monthly ? Math.round((monthly / 30) * 100) / 100 : null,
    serviceArea: area,
    radiusKm: o?.radiusKm || tpl.defaultRadiusKm,
    landingPage: o?.websiteUrl?.trim()
      ? o.websiteUrl.trim()
      : client.domain
        ? `https://${client.domain}/`
        : "",
    leadDelivery: { email: o?.leadEmail, phone: o?.leadPhone },
    services: fr ? tpl.servicesFr : tpl.servicesEn,
    headlines: tpl.angles.map((a) => fill(fr ? a.headlineFr : a.headlineEn)),
    primaryTexts: tpl.angles.map((a) => fill(fr ? a.textFr : a.textEn)),
    formQuestions: fr ? tpl.formQuestionsFr : tpl.formQuestionsEn,
    readiness: adsReadiness(client),
    ready: adsReady(client),
  };
}

// ---------------------------------------------------------------------------
// Lead intake (internal, shared-secret): POST /api/internal/ads-lead
// ---------------------------------------------------------------------------

export async function handleAdsLeadIntake(req: Request, env: AdsEnv): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Lead intake is not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
  } catch (e) {
    return err((e as Error).message);
  }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!clientId || !name) return err("clientId and name are required", 400);
  const client = await getClient(env.WEBAO_KV, clientId);
  if (!client) return err("Client not found", 404);
  if (!hasAdsPack(client)) return err("Client has no Ads Pack", 409);

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined);
  const lead = await recordAdsLead(env.WEBAO_KV, clientId, {
    name: name.slice(0, 200),
    phone: str(body.phone),
    email: str(body.email),
    service: str(body.service),
    message: str(body.message),
    source: str(body.source) || "meta",
  });

  const to = client.ads?.onboarding?.leadEmail || client.email;
  const fr = client.lang === "fr";
  const emailed = await sendClientEmail(env, {
    to,
    subject: fr ? `Nouveau prospect : ${lead.name}` : `New lead: ${lead.name}`,
    text: [
      fr ? `Nouveau prospect pour ${client.business || ""} :` : `New lead for ${client.business || ""}:`,
      ``,
      `${fr ? "Nom" : "Name"}: ${lead.name}`,
      lead.phone ? `${fr ? "Téléphone" : "Phone"}: ${lead.phone}` : "",
      lead.email ? `Email: ${lead.email}` : "",
      lead.service ? `Service: ${lead.service}` : "",
      lead.message ? `${fr ? "Message" : "Message"}: ${lead.message}` : "",
      ``,
      fr
        ? `Répondez vite, les prospects contactent souvent le premier qui rappelle.`
        : `Reply fast, leads usually book whoever calls back first.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  await notifyInbox(env, `New ads lead: ${lead.name} (${client.business || client.email})`, [
    `Client: ${client.business || ""} <${client.email}>`,
    `Lead: ${lead.name} ${lead.phone || ""} ${lead.email || ""}`,
    lead.service ? `Service: ${lead.service}` : "",
    `Source: ${lead.source || "meta"}`,
  ]);
  // The instant lead email is the product's real-time promise: a silent
  // failure used to still answer ok:true. Surface it, and alert the inbox
  // (the lead itself is already recorded and copied above, so nothing is
  // lost — but the owner should know the instant path failed).
  if (!emailed) {
    await notifyInbox(env, `Ads lead email failed: ${lead.name} (${client.business || client.email})`, [
      `The instant lead email to ${to} did not go out. The lead is recorded`,
      `in the portal and copied above; check the mailer configuration.`,
    ]);
  }
  return json({ ok: true, leadId: lead.id, emailed });
}
