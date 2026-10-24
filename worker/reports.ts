// Tenant traffic + the monthly client report.
//
// Tenant pageviews are counted in the worker when a published client site
// is served (see index.ts), one KV record per client per month:
// tstats:<clientId>:<yyyy-mm> = { views, byDay }. The monthly report job
// emails each live client their real numbers for the previous month;
// a report record per client per month makes the job idempotent.

import { CLIENTS_INDEX, type Client } from "./clients";
import { adsLeadIds, adsLeadKey, adsSpend, type AdsLead } from "./ads";
import { getJson, putJson } from "./kv";
import { notifyInbox, sendClientEmail } from "./mailer";
import { batch, err, isMonthKey, json, timingSafeEqual } from "./util";

export interface ReportEnv {
  WEBAO_KV: KVNamespace;
  SMTP2GO_API_KEY?: string;
  EMAIL?: SendEmailBinding;
  INTERNAL_CRON_SECRET?: string;
}

export interface TenantStats {
  views: number;
  byDay: Record<string, number>;
}

export const tenantStatsKey = (clientId: string, month: string): string =>
  `tstats:${clientId}:${month}`;
export const reportKey = (clientId: string, month: string): string =>
  `report:${clientId}:${month}`;

/** "2026-10" style month key for a timestamp, in UTC. */
export function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month before the one containing `at`. */
export function previousMonthKey(at: number): string {
  const d = new Date(at);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthKey(d.getTime());
}

/** Count one published-site pageview. Best effort; never throws. */
export async function recordTenantView(
  kv: KVNamespace,
  clientId: string,
  at: number = Date.now(),
): Promise<void> {
  try {
    const month = monthKey(at);
    const key = tenantStatsKey(clientId, month);
    const stats = (await getJson<TenantStats>(kv, key)) || { views: 0, byDay: {} };
    const day = String(new Date(at).getUTCDate());
    stats.views += 1;
    stats.byDay[day] = (stats.byDay[day] || 0) + 1;
    await putJson(kv, key, stats);
  } catch (e) {
    console.error("tenant view record failed", (e as Error)?.message);
  }
}

export async function tenantViews(
  kv: KVNamespace,
  clientId: string,
  month: string,
): Promise<TenantStats> {
  return (await getJson<TenantStats>(kv, tenantStatsKey(clientId, month))) || {
    views: 0,
    byDay: {},
  };
}

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function monthLabel(month: string, fr: boolean): string {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  const names = fr ? MONTHS_FR : MONTHS_EN;
  return `${names[(m || 1) - 1]} ${y}`;
}

/**
 * POST /api/internal/monthly-reports — emails every live client their
 * previous month's report. Idempotent per client per month; a client is
 * counted as sent only when the mail actually went out (or was already
 * sent), so a missing SMTP2GO key retries cleanly next run.
 */
export async function handleMonthlyReports(req: Request, env: ReportEnv): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Monthly reports are not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }
  // An explicit { month: "yyyy-mm" } may target a specific month (backfill
  // or tests); the default is the previous month.
  let month = previousMonthKey(Date.now());
  try {
    const body = (await req.json()) as { month?: unknown };
    if (isMonthKey(body?.month)) month = body.month;
  } catch {
    /* empty body is fine */
  }

  const kv = env.WEBAO_KV;
  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const records = await batch(index.slice(0, 1000), 25, (k) => getJson<Client>(kv, k));
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const [yy, mm] = month.split("-").map((s) => parseInt(s, 10));
  const monthStart = Date.UTC(yy, (mm || 1) - 1, 1);
  const monthEnd = Date.UTC(yy, mm || 1, 1);

  for (const client of records) {
    if (!client || client.test) continue;
    const siteLive = client.stage === "live";
    const adsLive = client.ads?.status === "live";
    if (!siteLive && !adsLive) continue;
    const existing = await getJson<{ sentAt: number }>(kv, reportKey(client.id, month));
    if (existing) {
      skipped++;
      continue;
    }
    const fr = client.lang === "fr";
    const label = monthLabel(month, fr);
    const lines: string[] = [fr ? `Bonjour,` : `Hello,`, ``];

    let views = 0;
    if (siteLive) {
      const stats = await tenantViews(kv, client.id, month);
      views = stats.views;
      const activeDays = Object.keys(stats.byDay).length;
      const siteLine = client.domain ? `https://${client.domain}/` : "";
      lines.push(
        fr ? `Voici l'activité de votre site pour ${label} :` : `Here is your website's activity for ${label}:`,
        ...(siteLine ? [siteLine] : []),
        fr ? `Pages vues : ${stats.views}` : `Page views: ${stats.views}`,
        fr ? `Jours avec des visites : ${activeDays}` : `Days with visits: ${activeDays}`,
        ``,
      );
    }

    if (adsLive) {
      const ids = await adsLeadIds(kv, client.id);
      const all = await batch(ids.slice(0, 500), 25, (id) => getJson<AdsLead>(kv, adsLeadKey(id)));
      const inMonth = all.filter(
        (l): l is AdsLead => Boolean(l) && (l as AdsLead).at >= monthStart && (l as AdsLead).at < monthEnd,
      );
      const booked = inMonth.filter((l) => l.outcome === "booked").length;
      lines.push(
        fr ? `Vos publicités pour ${label} :` : `Your ads for ${label}:`,
        fr ? `Prospects reçus : ${inMonth.length}` : `Leads received: ${inMonth.length}`,
        fr ? `Travaux réservés (selon vos suivis) : ${booked}` : `Jobs booked (from your follow-ups): ${booked}`,
      );
      const spendCents = await adsSpend(kv, client.id, month);
      if (spendCents !== null && inMonth.length > 0) {
        const cpl = (spendCents / 100 / inMonth.length).toFixed(2);
        lines.push(fr ? `Coût par prospect : ${cpl} $` : `Cost per lead: $${cpl}`);
        if (booked > 0) {
          const cpb = (spendCents / 100 / booked).toFixed(2);
          lines.push(fr ? `Coût par travail réservé : ${cpb} $` : `Cost per booked job: $${cpb}`);
        }
      }
      lines.push(``);
    }

    lines.push(
      fr
        ? `Une question ou un changement à demander ? Écrivez à support@webao.ca.`
        : `Questions, or a change to request? Write to support@webao.ca.`,
      ``,
      `Webao`,
    );

    const ok = await sendClientEmail(env, {
      to: client.email,
      subject: fr ? `Votre rapport Webao pour ${label}` : `Your Webao report for ${label}`,
      text: lines.filter((l) => l !== undefined).join("\n"),
    });
    if (ok) {
      await putJson(kv, reportKey(client.id, month), {
        sentAt: Date.now(),
        views,
      });
      sent++;
    } else {
      failed++;
    }
  }

  if (sent > 0 || failed > 0) {
    await notifyInbox(env, `Monthly client reports: ${month}`, [
      `Sent: ${sent}. Already sent earlier: ${skipped}. Failed (will retry): ${failed}.`,
    ]);
  }
  return json({ ok: true, month, sent, skipped, failed });
}
