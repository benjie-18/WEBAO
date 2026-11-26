// Pure admin aggregations, shared by the live handlers (worker/admin.ts)
// and the rebuild job (worker/sessions.ts) so the precomputed aggregates
// the rebuild writes are byte-for-byte what the live paths compute.
//
// Stats and charts aggregates are written by the rebuild into one KV key
// per range (`stats:agg:<range>`, `charts:agg:<range>`); the handlers
// serve the stored JSON when present and fresh, and fall back to live
// aggregation when missing or stale. No compression: the ceiling is the
// subrequest count, not the bytes, and Cloudflare already gzips the
// HTTP response — stored values stay plain JSON.
//
// Freshness: an aggregate counts as fresh for 36 h (AGG_STALE_MS), the
// same bound as the day-bundles. The daily incremental rebuild refreshes
// the stats aggregates and the charts loop refreshes the charts ones, so
// in steady state the handlers serve aggregates at most a day old. A
// stale or missing aggregate never fails a load: the handler falls back
// to live aggregation.

import { addDays, dayKey } from "./util";
import type { Lead } from "./leads";
import type { Session } from "./track";

export type RangeName = "day" | "week" | "month" | "year" | "all";

/** One precomputed aggregate per range, per tab. */
export const STATS_AGG_PREFIX = "stats:agg:";
/** One precomputed aggregate per range, per tab. */
export const CHARTS_AGG_PREFIX = "charts:agg:";
/** Charts rebuild staging: merged-so-far partials, deleted on completion. */
export const CHARTS_AGG_STAGING_KEY = "charts:agg:staging";
/** An aggregate older than this is stale: handlers fall back to live aggregation. */
export const AGG_STALE_MS = 36 * 3600 * 1000;
/** The ranges the rebuild precomputes, in panel order. */
export const AGG_RANGES: RangeName[] = ["day", "week", "month", "year", "all"];

export const statsAggregateKey = (range: RangeName): string => STATS_AGG_PREFIX + range;
export const chartsAggregateKey = (range: RangeName): string => CHARTS_AGG_PREFIX + range;

/** True when an aggregate's builtAt is a number no older than AGG_STALE_MS. */
export function isFreshAggregate(builtAt: unknown): boolean {
  return typeof builtAt === "number" && Date.now() - builtAt <= AGG_STALE_MS;
}

export function rangeDays(range: Exclude<RangeName, "all">, today: string): string[] {
  const n = range === "day" ? 1 : range === "week" ? 7 : range === "month" ? 30 : 365;
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Aggregate a set of sessions into the stats series. Pure over its
 * inputs, so the bundle path (whole store), the slice path (one slice
 * of the scan) and the rebuild all share it. A slice's aggregates are
 * exact partials — views, visitors, devices and countries sum across
 * slices, top pages/countries re-sort after the merge — so a caller
 * looping slices counts every session exactly once.
 */
export function aggregateStats(
  allSessions: Session[],
  range: RangeName,
  pageFilter: string | null,
  today: string,
): {
  labels: string[];
  views: number[];
  visitors: number[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; tablet: number; desktop: number };
  countries: { code: string; count: number }[];
} {
  // Days covered: the fixed window per range, or — for "all" — every
  // day from the earliest stored page or session start to today.
  let days: string[];
  if (range === "all") {
    let minDay = today;
    for (const s of allSessions) {
      const sd = dayKey(s.startedAt);
      if (sd < minDay) minDay = sd;
      for (const p of s.pages || []) {
        if (typeof p.at !== "number") continue;
        const pd = dayKey(p.at);
        if (pd < minDay) minDay = pd;
      }
    }
    days = [];
    for (let d = minDay; ; d = addDays(d, 1)) {
      days.push(d);
      if (d === today) break;
    }
  } else {
    days = rangeDays(range, today);
  }
  const daySet = new Set(days);

  const startTs = Date.parse(days[0] + "T00:00:00Z");
  const endTs = Date.parse(today + "T00:00:00Z") + 24 * 3600 * 1000;

  // Views: bucket every stored page by the day it happened, so a
  // session that started before the range still contributes the pages
  // it served inside the range.
  const perPath = new Map<string, number>();
  const viewsByDay = new Map<string, number>();
  for (const s of allSessions) {
    for (const p of s.pages || []) {
      if (typeof p.at !== "number" || typeof p.path !== "string") continue;
      const d = dayKey(p.at);
      if (!daySet.has(d)) continue;
      perPath.set(p.path, (perPath.get(p.path) || 0) + 1);
      if (!pageFilter || p.path === pageFilter) viewsByDay.set(d, (viewsByDay.get(d) || 0) + 1);
    }
  }
  for (const d of days) if (!viewsByDay.has(d)) viewsByDay.set(d, 0);

  // Visitors/devices/countries: sessions started in the range.
  const sessions = allSessions.filter((s) => s.startedAt >= startTs && s.startedAt < endTs);

  const visitorsByDay = new Map<string, number>();
  const devices = { mobile: 0, tablet: 0, desktop: 0 };
  const countryCounts = new Map<string, number>();
  for (const s of sessions) {
    const d = dayKey(s.startedAt);
    visitorsByDay.set(d, (visitorsByDay.get(d) || 0) + 1);
    devices[s.device] = (devices[s.device] || 0) + 1;
    const cc = (s.country || "XX").toUpperCase();
    countryCounts.set(cc, (countryCounts.get(cc) || 0) + 1);
  }

  // Shape the response (day/week/month => daily buckets, year/all => monthly).
  let labels: string[];
  let views: number[];
  let visitors: number[];
  if (range === "year" || range === "all") {
    const months: string[] = [];
    for (const d of days) {
      const m = d.slice(0, 7);
      if (months[months.length - 1] !== m) months.push(m);
    }
    labels = months;
    views = months.map((m) =>
      days.filter((d) => d.startsWith(m)).reduce((a, d) => a + (viewsByDay.get(d) || 0), 0),
    );
    visitors = months.map((m) =>
      days.filter((d) => d.startsWith(m)).reduce((a, d) => a + (visitorsByDay.get(d) || 0), 0),
    );
  } else {
    labels = days;
    views = days.map((d) => viewsByDay.get(d) || 0);
    visitors = days.map((d) => visitorsByDay.get(d) || 0);
  }

  const topPages = [...perPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, v]) => ({ path, views: v }));

  const countries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([code, count]) => ({ code, count }));

  return { labels, views, visitors, topPages, devices, countries };
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export interface ChartsAggregate {
  ok: true;
  range: RangeName;
  labels: string[];
  forms: {
    total: number[];
    byType: { contact: number[]; support: number[]; pricing: number[] };
  };
  leads: { sent: number[]; clicked: number[]; replied: number[] };
  leadStages: { replied: number; clicked: number; none: number; optout: number; bounced: number };
  clickDests: { demos: number; home: number; pricing: number; start: number };
  leadsTotal: number;
  formsTotal: number;
}

/**
 * Aggregate one slice of form submissions and outreach leads into the
 * charts series. Pure over its inputs: the handler calls it per slice
 * (leadOffset/formOffset) and the rebuild calls it per slice too, so
 * both produce the same numbers from the same records. `totals` are
 * the whole-store counts (leadsTotal / formsTotal), not the slice
 * counts — a partial's totals describe the store, so merging partials
 * keeps them.
 *
 * The records a caller passes decide the scope: the handler passes the
 * newest 1,000 leads / 1,000 forms for the fixed ranges (its live cap)
 * and the slice's records for "all"; the rebuild passes the same
 * scoping (fixed ranges: records ranked under 1,000 in index/list
 * order; "all": every record), so a precomputed aggregate matches the
 * live response exactly.
 */
export function aggregateCharts(
  formRecs: ({ form?: string; at?: number } | null)[],
  leadRecs: (Lead | null)[],
  range: RangeName,
  today: string,
  totals: { leadsTotal: number; formsTotal: number },
): ChartsAggregate {
  // Days covered: the fixed window per range, or — for "all" — every
  // day from the earliest stored event in this slice to today. Each
  // slice buckets into monthly labels from its own span; the panel
  // merges slices by month label, so slices may span different months.
  let days: string[];
  if (range === "all") {
    let minTs: number | undefined;
    const consider = (ts: number | undefined): void => {
      if (typeof ts === "number" && (minTs === undefined || ts < minTs)) minTs = ts;
    };
    for (const rec of formRecs) consider(rec?.at);
    for (const lead of leadRecs) {
      if (!lead) continue;
      consider(lead.sentAt);
      consider(lead.firstClickAt);
      consider(lead.repliedAt);
      for (const c of lead.clicks || []) consider(c.at);
    }
    const minDay = minTs === undefined ? today : dayKey(minTs);
    days = [];
    for (let d = minDay; ; d = addDays(d, 1)) {
      days.push(d);
      if (d === today) break;
    }
  } else {
    days = rangeDays(range, today);
  }
  const startTs = Date.parse(days[0] + "T00:00:00Z");
  const endTs = Date.parse(today + "T00:00:00Z") + 24 * 3600 * 1000;

  // Label positions: daily buckets, or one bucket per month for the
  // year and all-time ranges.
  let labels: string[];
  const bucketOf = new Map<string, number>();
  if (range === "year" || range === "all") {
    const months: string[] = [];
    for (const d of days) {
      const m = d.slice(0, 7);
      if (months[months.length - 1] !== m) months.push(m);
    }
    labels = months;
    months.forEach((m, i) => bucketOf.set(m, i));
  } else {
    labels = days;
    days.forEach((d, i) => bucketOf.set(d, i));
  }
  const series = (): number[] => labels.map(() => 0);
  const bump = (arr: number[], ts: number | undefined): void => {
    if (typeof ts !== "number" || ts < startTs || ts >= endTs) return;
    const key = range === "year" || range === "all" ? dayKey(ts).slice(0, 7) : dayKey(ts);
    const i = bucketOf.get(key);
    if (i !== undefined) arr[i] += 1;
  };

  const formsTotal = series();
  const formsByType = { contact: series(), support: series(), pricing: series() };
  for (const rec of formRecs) {
    if (!rec || typeof rec.at !== "number") continue;
    bump(formsTotal, rec.at);
    if (rec.form === "contact" || rec.form === "support" || rec.form === "pricing")
      bump(formsByType[rec.form], rec.at);
  }

  const leadsSent = series();
  const leadsClicked = series();
  const leadsReplied = series();
  const leadStages = { replied: 0, clicked: 0, none: 0, optout: 0, bounced: 0 };
  const clickDests = { demos: 0, home: 0, pricing: 0, start: 0 };
  for (const lead of leadRecs) {
    if (!lead) continue;
    bump(leadsSent, lead.sentAt);
    bump(leadsClicked, lead.firstClickAt);
    bump(leadsReplied, lead.repliedAt);
    if (lead.sentAt >= startTs && lead.sentAt < endTs) {
      if (lead.bouncedAt) leadStages.bounced += 1;
      else if (lead.optOutAt) leadStages.optout += 1;
      else if (lead.repliedAt) leadStages.replied += 1;
      else if ((lead.clickCount || 0) > 0) leadStages.clicked += 1;
      else leadStages.none += 1;
    }
    for (const c of lead.clicks || []) {
      if (c.suspect || c.at < startTs || c.at >= endTs) continue;
      if (c.dest === "demos" || c.dest === "home" || c.dest === "pricing" || c.dest === "start")
        clickDests[c.dest] += 1;
    }
  }

  return {
    ok: true,
    range,
    labels,
    forms: { total: formsTotal, byType: formsByType },
    leads: { sent: leadsSent, clicked: leadsClicked, replied: leadsReplied },
    leadStages,
    clickDests,
    leadsTotal: totals.leadsTotal,
    formsTotal: totals.formsTotal,
  };
}

/**
 * Merge two charts aggregates of the same range: union of labels,
 * every series summed per label, stages and destinations summed.
 * Totals are whole-store counts, identical across partials, so the
 * larger wins. Mirrors the panel's mergeCharts, server-side, so the
 * rebuild's sliced accumulation counts every entry exactly once.
 */
export function mergeChartsAggregates(a: ChartsAggregate, b: ChartsAggregate): ChartsAggregate {
  const labels = [...new Set([...a.labels, ...b.labels])].sort();
  const align = (vals: number[], src: string[]): number[] =>
    labels.map((l) => {
      const i = src.indexOf(l);
      return i >= 0 ? vals[i] || 0 : 0;
    });
  const sum = (x: number[], y: number[]): number[] => x.map((v, i) => v + y[i]);
  const sumSeries = (x: number[], xs: string[], y: number[], ys: string[]): number[] =>
    sum(align(x, xs), align(y, ys));
  return {
    ok: true,
    range: a.range,
    labels,
    forms: {
      total: sumSeries(a.forms.total, a.labels, b.forms.total, b.labels),
      byType: {
        contact: sumSeries(a.forms.byType.contact, a.labels, b.forms.byType.contact, b.labels),
        support: sumSeries(a.forms.byType.support, a.labels, b.forms.byType.support, b.labels),
        pricing: sumSeries(a.forms.byType.pricing, a.labels, b.forms.byType.pricing, b.labels),
      },
    },
    leads: {
      sent: sumSeries(a.leads.sent, a.labels, b.leads.sent, b.labels),
      clicked: sumSeries(a.leads.clicked, a.labels, b.leads.clicked, b.labels),
      replied: sumSeries(a.leads.replied, a.labels, b.leads.replied, b.labels),
    },
    leadStages: {
      replied: a.leadStages.replied + b.leadStages.replied,
      clicked: a.leadStages.clicked + b.leadStages.clicked,
      none: a.leadStages.none + b.leadStages.none,
      optout: a.leadStages.optout + b.leadStages.optout,
      bounced: a.leadStages.bounced + b.leadStages.bounced,
    },
    clickDests: {
      demos: a.clickDests.demos + b.clickDests.demos,
      home: a.clickDests.home + b.clickDests.home,
      pricing: a.clickDests.pricing + b.clickDests.pricing,
      start: a.clickDests.start + b.clickDests.start,
    },
    leadsTotal: Math.max(a.leadsTotal, b.leadsTotal),
    formsTotal: Math.max(a.formsTotal, b.formsTotal),
  };
}
