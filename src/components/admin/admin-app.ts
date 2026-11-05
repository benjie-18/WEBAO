// WEBAO admin panel client app.
// Login gate + six tabs (Stats / Forms / Outreach / Audits / Clients / Config)
// talking to the Worker API described in worker/API.md. All user-controlled
// strings are HTML-escaped before rendering. Auth token lives in
// sessionStorage (never in the URL).

import { donutSegments, donutSlicePath, niceCeil } from "./chart-math";

const TOKEN_KEY = "webao.admin.token";

interface StatsResponse {
  ok: boolean;
  range: string;
  page: string;
  labels: string[];
  views: number[];
  visitors: number[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; tablet: number; desktop: number };
  countries: { code: string; count: number }[];
}

interface FormItem {
  id: string;
  form: string;
  fields: Record<string, string>;
  ip: string;
  country: string;
  ua: string;
  at: number;
}

interface FormsResponse {
  ok: boolean;
  items: FormItem[];
  nextCursor: string | null;
}

interface LeadItem {
  id: string;
  business: string;
  email: string;
  city?: string;
  trade?: string;
  subject?: string;
  lang?: string;
  source?: string;
  sentAt: number;
  clicks: { at: number; dest: string; country: string; suspect: boolean }[];
  replies: { at: number; kind: string; from?: string; subject?: string }[];
  clickCount: number;
  firstClickAt?: number;
  lastClickAt?: number;
  repliedAt?: number;
  optOutAt?: number;
  bouncedAt?: number;
}

interface LeadsResponse {
  ok: boolean;
  items: LeadItem[];
  nextCursor: string | null;
}

interface ClientItem {
  id: string;
  email: string;
  lang?: string;
  test?: boolean;
  name?: string;
  business?: string;
  stage: string;
  billingStatus: string;
  items: string[];
  createdAt: number;
  updatedAt: number;
  onboardingComplete: boolean;
  onboarding: Record<string, unknown>;
  onboardingCompletedAt?: number;
  previewUrl?: string;
  domain?: string;
  domainStatus: string;
  domainCheckedAt?: number;
  reviewDecision?: { decision: string; note?: string; at: number; buildId?: string };
  revisionCount: number;
  hasAds: boolean;
  adsStatus?: string;
  adsTrade?: string;
  adsBudget?: number;
  adAccountId?: string;
  buildAt?: number;
  buildQaPassed?: boolean;
  buildQaFailedChecks?: { id: string; detail: string }[];
  hasDraft: boolean;
  isPublished: boolean;
  publishPending: boolean;
  nudgeCount: number;
  nudgesEscalatedAt?: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

interface AbandonedItem {
  sessionId: string;
  email: string;
  name?: string;
  items: string[];
  amountTotal?: number;
  currency?: string;
  lang: string;
  createdAt: number;
  status: string;
}

interface ClientsResponse {
  ok: boolean;
  items: ClientItem[];
  abandoned?: AbandonedItem[];
  nextCursor: string | null;
}

interface ChartsResponse {
  ok: boolean;
  range: string;
  labels: string[];
  forms: {
    total: number[];
    byType: { contact: number[]; support: number[]; pricing: number[] };
  };
  leads: { sent: number[]; clicked: number[]; replied: number[] };
  leadStages: { replied: number; clicked: number; none: number; optout: number; bounced: number };
  clickDests: { demos: number; home: number; pricing: number; start: number };
}

interface Settings {
  defaultTheme: "system" | "light" | "dark";
  trackingEnabled: boolean;
}

// Loose dictionary for the localized strings passed via data-i18n.
type Dict = Record<string, any>;

/** Thrown when the stored token is rejected so callers can stop quietly. */
class ExpiredSession extends Error {}

/** Escape anything interpolated into innerHTML. */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    const m: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return m[c] || c;
  });
}

function initAdmin(): void {
  const root = document.getElementById("admin-root");
  if (!root || root.dataset.adminInit === "1") return;
  root.dataset.adminInit = "1";
  // Non-null handle for use inside nested closures (TS narrowing doesn't
  // cross function boundaries here).
  const rootEl: HTMLElement = root;

  let I18N: Dict = {};
  try {
    I18N = JSON.parse(rootEl.dataset.i18n || "{}") as Dict;
  } catch {
    I18N = {};
  }
  const LOCALE: "en" | "fr" = rootEl.dataset.locale === "fr" ? "fr" : "en";
  const nf = new Intl.NumberFormat(LOCALE === "fr" ? "fr-CA" : "en-CA");

  const qq = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
    rootEl.querySelector<T>(sel);

  // In-memory token fallback for browsers where sessionStorage throws
  // (private mode); the session simply doesn't survive a reload then.
  let memToken: string | null = null;
  const getToken = (): string | null => {
    try {
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (t) return t;
    } catch {
      /* ignore */
    }
    return memToken;
  };
  const setToken = (t: string | null): void => {
    memToken = t;
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  };

  /* ── Authenticated API helper (matches worker/API.md exactly) ── */
  async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Dict> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new Error("network");
    }
    let data: Dict = {};
    try {
      data = (await res.json()) as Dict;
    } catch {
      data = {};
    }
    // Only a bad/expired *token* ends the session. A 401 from
    // POST /api/admin/password means the *current password* was wrong.
    if (res.status === 401 && data.error === "Unauthorized") {
      setToken(null);
      showLogin(I18N.login.expired);
      throw new ExpiredSession("expired");
    }
    if (!res.ok || data.ok === false) {
      throw new Error(typeof data.error === "string" ? data.error : "request failed");
    }
    return data;
  }

  /* ── Views ── */
  const loginView = qq('[data-view="login"]');
  const appView = qq('[data-view="app"]');

  function showLogin(notice?: string): void {
    if (!loginView || !appView) return;
    appView.hidden = true;
    loginView.hidden = false;
    const n = qq("[data-login-notice]");
    if (n) {
      if (notice) {
        n.textContent = notice;
        n.hidden = false;
      } else {
        n.hidden = true;
      }
    }
    const e = qq("[data-login-error]");
    if (e) e.hidden = true;
    // Refresh data on the next login.
    tabLoaded.stats = false;
    tabLoaded.forms = false;
    tabLoaded.leads = false;
    tabLoaded.clients = false;
    tabLoaded.config = false;
  }

  function showApp(): void {
    if (!loginView || !appView) return;
    loginView.hidden = true;
    appView.hidden = false;
    activateTab("stats", true);
  }

  function toast(msg: string, kind: "ok" | "err" = "ok"): void {
    const wrap = qq("[data-toasts]");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "admin-toast" + (kind === "err" ? " admin-toast--err" : "");
    el.textContent = msg;
    wrap.appendChild(el);
    window.setTimeout(() => el.remove(), 4200);
  }

  /* ── Login ── */
  async function onLogin(e: Event): Promise<void> {
    e.preventDefault();
    const input = qq<HTMLInputElement>("[data-login-password]");
    const errEl = qq("[data-login-error]");
    const btn = qq<HTMLButtonElement>("[data-login-submit]");
    if (!input || !errEl) return;
    errEl.hidden = true;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input.value }),
      });
      let data: Dict = {};
      try {
        data = (await res.json()) as Dict;
      } catch {
        data = {};
      }
      if (!res.ok || !data.ok || typeof data.token !== "string") {
        errEl.textContent =
          res.status === 401 ? String(I18N.login.wrong) : String(I18N.login.network);
        errEl.hidden = false;
        return;
      }
      setToken(data.token);
      input.value = "";
      showApp();
    } catch {
      errEl.textContent = String(I18N.login.network);
      errEl.hidden = false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── Tabs ── */
  let activeTab = "";
  const tabLoaded: Record<string, boolean> = { stats: false, forms: false, leads: false, audits: false, clients: false, config: false };

  function activateTab(name: string, force = false): void {
    if (!force && name === activeTab) return;
    activeTab = name;
    const tabs = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-tab]"));
    tabs.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    const panels = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-panel]"));
    panels.forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
    if (!tabLoaded[name]) {
      tabLoaded[name] = true;
      if (name === "stats") void loadStats();
      else if (name === "forms") void loadForms(true);
      else if (name === "leads") void loadLeads(true);
      else if (name === "audits") void loadAudits(true);
      else if (name === "clients") void loadClients(true);
      else if (name === "config") void loadConfig();
    }
    if (name === "forms" && !formsChartsLoaded) void loadFormsCharts();
    if (name === "leads" && !leadsChartsLoaded) void loadLeadsCharts();
  }

  /* ── Stats tab ── */
  type Range = "day" | "week" | "month" | "year";
  let range: Range = "day";
  let pageFilter = "all";

  function setStatsLoading(): void {
    const body = qq("[data-stats-body]");
    if (body) body.innerHTML = `<p class="admin-loading">${esc(I18N.stats.loading)}</p>`;
  }

  function setStatsError(): void {
    const body = qq("[data-stats-body]");
    if (body) {
      body.innerHTML =
        `<div class="admin-retry"><p>${esc(I18N.stats.loadError)}</p>` +
        `<button type="button" class="admin-ghost-btn" data-stats-retry>${esc(I18N.stats.retry)}</button></div>`;
    }
  }

  // Traffic chart customization: type + which series are visible. Kept in
  // state so toggling re-renders from the cached response, no refetch.
  let chartType: "line" | "bars" = "line";
  let showViews = true;
  let showVisitors = true;
  let lastStats: StatsResponse | null = null;

  async function loadStats(): Promise<void> {
    setStatsLoading();
    try {
      const data = (await api(
        `/api/admin/stats?range=${range}&page=${encodeURIComponent(pageFilter)}`
      )) as unknown as StatsResponse;
      lastStats = data;
      renderStats(data);
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      setStatsError();
    }
  }

  function syncPageOptions(paths: string[]): void {
    const sel = qq<HTMLSelectElement>("[data-page-filter]");
    if (!sel) return;
    const keep = new Set<string>(["all", pageFilter, ...paths]);
    sel.innerHTML = "";
    for (const p of keep) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p === "all" ? String(I18N.stats.allPages) : p;
      sel.appendChild(opt);
    }
    sel.value = pageFilter;
  }

  function barList(rows: { label: string; value: number }[], max: number): string {
    if (rows.length === 0 || max <= 0) {
      return `<p class="admin-muted" style="font-size:13px;">${esc(I18N.stats.noData)}</p>`;
    }
    return rows
      .map(
        (r) => `<div class="bar-row">
          <div class="bar-top"><span class="bar-label">${esc(r.label)}</span><span class="bar-value">${nf.format(r.value)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round((r.value / max) * 100))}%"></div></div>
        </div>`
      )
      .join("");
  }

  function countryName(code: string): string {
    try {
      const dn = new Intl.DisplayNames([LOCALE === "fr" ? "fr" : "en"], { type: "region" });
      return dn.of(code) || code;
    } catch {
      return code;
    }
  }

  function renderStats(d: StatsResponse): void {
    const body = qq("[data-stats-body]");
    if (!body) return;
    const totalViews = d.views.reduce((s, v) => s + v, 0);
    const totalVisitors = d.visitors.reduce((s, v) => s + v, 0);
    const perVisitor = totalVisitors > 0 ? (totalViews / totalVisitors).toFixed(1) : "0";

    syncPageOptions(d.topPages.map((p) => p.path));

    const kpis =
      `<div class="admin-kpi"><div class="kpi-value">${nf.format(totalViews)}</div><div class="kpi-label">${esc(I18N.stats.kpis.views)}</div></div>` +
      `<div class="admin-kpi"><div class="kpi-value">${nf.format(totalVisitors)}</div><div class="kpi-label">${esc(I18N.stats.kpis.visitors)}</div></div>` +
      `<div class="admin-kpi"><div class="kpi-value">${esc(perVisitor)}</div><div class="kpi-label">${esc(I18N.stats.kpis.perVisitor)}</div></div>`;

    const devices = d.devices || { mobile: 0, tablet: 0, desktop: 0 };
    const deviceRows = [
      { label: String(I18N.stats.deviceNames.mobile), value: devices.mobile || 0 },
      { label: String(I18N.stats.deviceNames.tablet), value: devices.tablet || 0 },
      { label: String(I18N.stats.deviceNames.desktop), value: devices.desktop || 0 },
    ];
    const deviceTotal = deviceRows.reduce((s, r) => s + r.value, 0);
    const countries = d.countries || [];
    const countryMax = Math.max(1, ...countries.map((c) => c.count));
    const topMax = Math.max(1, ...d.topPages.map((p) => p.views));

    const anyTraffic = (showViews && totalViews > 0) || (showVisitors && totalVisitors > 0);
    const trafficChart = !anyTraffic
      ? `<div class="admin-empty">${esc(I18N.stats.noData)}</div>`
      : chartType === "line"
        ? buildChart(d.labels, d.views, d.visitors)
        : buildBars(
            d.labels,
            [
              ...(showViews
                ? [{ name: String(I18N.stats.chartViews), values: d.views, cls: 0 }]
                : []),
              ...(showVisitors
                ? [{ name: String(I18N.stats.chartVisitors), values: d.visitors, cls: 3 }]
                : []),
            ],
            String(I18N.stats.chartTitle)
          );

    const typeSeg =
      `<div class="admin-seg admin-seg--sm" role="group" aria-label="${esc(I18N.stats.chartTypeLabel)}">` +
      `<button type="button" class="admin-seg-btn${chartType === "line" ? " is-active" : ""}" data-chart-type="line">${esc(I18N.stats.typeLine)}</button>` +
      `<button type="button" class="admin-seg-btn${chartType === "bars" ? " is-active" : ""}" data-chart-type="bars">${esc(I18N.stats.typeBars)}</button>` +
      `</div>`;
    const legend =
      `<div class="admin-legend">` +
      `<button type="button" class="legend-chip${showViews ? "" : " is-off"}" data-series-toggle="views" aria-pressed="${showViews}"><i class="dot seg-dot--0"></i>${esc(I18N.stats.chartViews)}</button>` +
      `<button type="button" class="legend-chip${showVisitors ? "" : " is-off"}" data-series-toggle="visitors" aria-pressed="${showVisitors}"><i class="dot seg-dot--3"></i>${esc(I18N.stats.chartVisitors)}</button>` +
      `</div>`;

    body.innerHTML =
      `<div class="admin-kpis">${kpis}</div>` +
      `<div class="admin-card"><div class="admin-card-head"><h2>${esc(I18N.stats.chartTitle)}</h2>` +
      `<div class="admin-chart-tools">${legend}${typeSeg}</div></div>` +
      `<div class="admin-chart chart-wrap">${trafficChart}</div></div>` +
      `<div class="admin-grid-3">` +
      `<div class="admin-card"><h2>${esc(I18N.stats.topPages)}</h2>${barList(d.topPages.map((p) => ({ label: p.path, value: p.views })), topMax)}</div>` +
      `<div class="admin-card"><h2>${esc(I18N.stats.devices)}</h2>${
        deviceTotal === 0
          ? `<p class="admin-muted" style="font-size:13px;">${esc(I18N.stats.noData)}</p>`
          : buildDonut(deviceRows, nf.format(deviceTotal), String(I18N.stats.kpis.visitors))
      }</div>` +
      `<div class="admin-card"><h2>${esc(I18N.stats.countries)}</h2>${barList(countries.map((c) => ({ label: `${countryName(c.code)} · ${c.code}`, value: c.count })), countryMax)}</div>` +
      `</div>`;
  }

  /** "2026-10-04" → "Oct 4" (locale-aware); "2026-10" → "Oct". */
  function fmtLabel(l: string): string {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(l || "");
    if (!m) return l || "";
    const tag = LOCALE === "fr" ? "fr-CA" : "en-CA";
    const d = new Date(
      Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, m[3] ? parseInt(m[3], 10) : 1)
    );
    try {
      return m[3]
        ? d.toLocaleDateString(tag, { month: "short", day: "numeric", timeZone: "UTC" })
        : d.toLocaleDateString(tag, { month: "short", timeZone: "UTC" });
    } catch {
      return l;
    }
  }

  /**
   * Custom SVG line/area chart — no dependencies, theme-aware via CSS
   * classes. Interactive: an invisible hover band per point drives the
   * shared tooltip + crosshair (wired by the delegated pointer handlers),
   * and the visible series follow the legend toggles.
   */
  function buildChart(labels: string[], views: number[], visitors: number[]): string {
    const W = 720;
    const H = 250;
    const padL = 40;
    const padR = 14;
    const padT = 16;
    const padB = 30;
    const n = labels.length;
    const top = niceCeil(
      Math.max(1, ...(showViews ? views : []), ...(showVisitors ? visitors : []))
    );
    const X = (i: number): number =>
      n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
    const Y = (v: number): number => padT + (1 - v / top) * (H - padT - padB);
    const f = (x: number): string => x.toFixed(1);
    const line = (vals: number[]): string =>
      vals.map((v, i) => `${i === 0 ? "M" : "L"}${f(X(i))},${f(Y(v))}`).join(" ");
    const area = `${line(views)} L${f(X(n - 1))},${f(H - padB)} L${f(X(0))},${f(H - padB)} Z`;

    let grid = "";
    for (let g = 0; g <= 3; g++) {
      const v = (top * g) / 3;
      const y = Y(v);
      grid +=
        `<line class="chart-grid" x1="${padL}" y1="${f(y)}" x2="${W - padR}" y2="${f(y)}"/>` +
        `<text class="chart-tick" x="${padL - 8}" y="${f(y + 3.5)}" text-anchor="end">${nf.format(Math.round(v))}</text>`;
    }
    const tickCount = Math.min(6, n);
    let ticks = "";
    for (let t = 0; t < tickCount; t++) {
      const i = tickCount === 1 ? 0 : Math.round((t * (n - 1)) / (tickCount - 1));
      ticks += `<text class="chart-tick" x="${f(X(i))}" y="${H - 10}" text-anchor="middle">${esc(fmtLabel(labels[i]))}</text>`;
    }
    const dots = showViews
      ? views
          .map(
            (v, i) => `<circle class="chart-dot" cx="${f(X(i))}" cy="${f(Y(v))}" r="3.5"/>`
          )
          .join("")
      : "";

    // One hover band per point; the band carries the tooltip text and the
    // crosshair x for the delegated pointer handlers.
    const bandW = (W - padL - padR) / Math.max(1, n);
    const zones = labels
      .map((l, i) => {
        const parts = [fmtLabel(l)];
        if (showViews) parts.push(`${String(I18N.stats.chartViews)} ${nf.format(views[i])}`);
        if (showVisitors)
          parts.push(`${String(I18N.stats.chartVisitors)} ${nf.format(visitors[i])}`);
        const x = n === 1 ? padL : X(i) - bandW / 2;
        return (
          `<rect class="chart-hover-zone" x="${f(x)}" y="${padT}" width="${f(bandW)}" height="${H - padT - padB}"` +
          ` data-tip="${esc(parts.join(" · "))}" data-cx="${f(X(i))}"/>`
        );
      })
      .join("");

    return (
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(I18N.stats.chartTitle)}">` +
      grid +
      (showViews ? `<path class="chart-area" d="${area}"/><path class="chart-line" d="${line(views)}"/>` : "") +
      (showVisitors ? `<path class="chart-line-vis" d="${line(visitors)}"/>` : "") +
      ticks +
      dots +
      `<line class="chart-cross" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/>` +
      zones +
      `</svg>`
    );
  }

  interface BarSeries {
    name: string;
    values: number[];
    /** Palette slot 0..4 (maps to the --chart-* theme colors). */
    cls: number;
  }

  /** Grouped vertical bar chart with the same frame/axis style as the line chart. */
  function buildBars(labels: string[], series: BarSeries[], ariaLabel: string): string {
    const W = 720;
    const H = 250;
    const padL = 40;
    const padR = 14;
    const padT = 16;
    const padB = 30;
    const n = labels.length;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const top = niceCeil(Math.max(1, ...series.flatMap((s) => s.values)));
    const Y = (v: number): number => padT + (1 - v / top) * plotH;
    const f = (x: number): string => x.toFixed(1);

    let grid = "";
    for (let g = 0; g <= 3; g++) {
      const v = (top * g) / 3;
      const y = Y(v);
      grid +=
        `<line class="chart-grid" x1="${padL}" y1="${f(y)}" x2="${W - padR}" y2="${f(y)}"/>` +
        `<text class="chart-tick" x="${padL - 8}" y="${f(y + 3.5)}" text-anchor="end">${nf.format(Math.round(v))}</text>`;
    }

    const groupW = plotW / Math.max(1, n);
    const barW = Math.max(2, (groupW * 0.72) / Math.max(1, series.length));
    let bars = "";
    let ticks = "";
    const tickEvery = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i++) {
      const gx = padL + i * groupW + (groupW - barW * series.length) / 2;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        const h = Math.max(0, Y(0) - Y(v));
        if (v > 0) {
          bars +=
            `<rect class="bar-rect seg-fill--${s.cls % 5}" x="${f(gx + si * barW)}" y="${f(Y(v))}" ` +
            `width="${f(barW - 1.5)}" height="${f(h)}" rx="2.5" ` +
            `data-tip="${esc(`${fmtLabel(labels[i])} · ${s.name}: ${nf.format(v)}`)}"/>`;
        }
      });
      if (i % tickEvery === 0 || i === n - 1) {
        ticks += `<text class="chart-tick" x="${f(padL + i * groupW + groupW / 2)}" y="${H - 10}" text-anchor="middle">${esc(fmtLabel(labels[i]))}</text>`;
      }
    }

    return (
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">` +
      grid +
      bars +
      ticks +
      `</svg>`
    );
  }

  interface DonutSeg {
    label: string;
    value: number;
  }

  /**
   * Donut chart with a center total and an HTML legend (value + share).
   * Slices and legend rows share data-seg-idx so hovering either one
   * highlights both (delegated pointer handlers).
   */
  function buildDonut(segs: DonutSeg[], centerValue: string, centerLabel: string): string {
    const total = segs.reduce((s, x) => s + Math.max(0, x.value), 0);
    const slices = donutSegments(segs.map((x) => x.value));
    const size = 176;
    const c = size / 2;
    const paths = segs
      .map((x, i) => {
        const d = donutSlicePath(c, c, 84, 55, slices[i].start, slices[i].end);
        if (!d) return "";
        const pct = total > 0 ? Math.round((Math.max(0, x.value) / total) * 100) : 0;
        return (
          `<path class="donut-slice seg-fill--${i % 5}" d="${d}" data-seg-idx="${i}" ` +
          `data-tip="${esc(`${x.label}: ${nf.format(x.value)} (${pct}%)`)}"/>`
        );
      })
      .join("");
    const legend = segs
      .map((x, i) => {
        const pct = total > 0 ? Math.round((Math.max(0, x.value) / total) * 100) : 0;
        return (
          `<div class="donut-row" data-seg-idx="${i}">` +
          `<i class="dot seg-dot--${i % 5}"></i>` +
          `<span class="donut-label">${esc(x.label)}</span>` +
          `<span class="donut-val">${nf.format(x.value)} · ${pct}%</span></div>`
        );
      })
      .join("");
    return (
      `<div class="donut-wrap chart-wrap">` +
      `<svg class="donut-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(centerLabel)}">` +
      paths +
      `<text class="donut-center-value" x="${c}" y="${c - 2}" text-anchor="middle">${esc(centerValue)}</text>` +
      `<text class="donut-center-label" x="${c}" y="${c + 16}" text-anchor="middle">${esc(centerLabel)}</text>` +
      `</svg>` +
      `<div class="donut-legend">${legend}</div></div>`
    );
  }

  /* ── Forms + Outreach charts (one /api/admin/charts fetch per range) ── */
  let formsRange: "day" | "week" | "month" | "year" = "month";
  let leadsRange: "day" | "week" | "month" | "year" = "month";
  let formsChartsLoaded = false;
  let leadsChartsLoaded = false;
  const chartsCache = new Map<string, ChartsResponse>();

  async function fetchCharts(r: string): Promise<ChartsResponse> {
    const hit = chartsCache.get(r);
    if (hit) return hit;
    const data = (await api(`/api/admin/charts?range=${r}`)) as unknown as ChartsResponse;
    chartsCache.set(r, data);
    return data;
  }

  async function loadFormsCharts(): Promise<void> {
    const wrap = qq("[data-forms-charts]");
    if (!wrap) return;
    if (!wrap.innerHTML) wrap.innerHTML = `<p class="admin-loading">${esc(I18N.stats.loading)}</p>`;
    try {
      const d = await fetchCharts(formsRange);
      formsChartsLoaded = true;
      const totalSum = d.forms.total.reduce((s, v) => s + v, 0);
      const typeSegs = [
        { label: String(I18N.forms.filterContact), value: d.forms.byType.contact.reduce((s, v) => s + v, 0) },
        { label: String(I18N.forms.filterSupport), value: d.forms.byType.support.reduce((s, v) => s + v, 0) },
        { label: String(I18N.forms.filterPricing), value: d.forms.byType.pricing.reduce((s, v) => s + v, 0) },
      ];
      const empty = `<div class="admin-empty">${esc(I18N.forms.noData)}</div>`;
      wrap.innerHTML =
        `<div class="admin-grid-2">` +
        `<div class="admin-card"><h2>${esc(I18N.forms.chartTitle)}</h2>` +
        (totalSum === 0
          ? empty
          : `<div class="chart-wrap">${buildBars(d.labels, [{ name: String(I18N.forms.submissions), values: d.forms.total, cls: 0 }], String(I18N.forms.chartTitle))}</div>`) +
        `</div>` +
        `<div class="admin-card"><h2>${esc(I18N.forms.byTypeTitle)}</h2>` +
        (totalSum === 0
          ? empty
          : buildDonut(typeSegs, nf.format(totalSum), String(I18N.forms.submissions))) +
        `</div></div>`;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      wrap.innerHTML =
        `<div class="admin-retry"><p>${esc(I18N.stats.loadError)}</p>` +
        `<button type="button" class="admin-ghost-btn" data-forms-charts-retry>${esc(I18N.stats.retry)}</button></div>`;
    }
  }

  async function loadLeadsCharts(): Promise<void> {
    const wrap = qq("[data-leads-charts]");
    if (!wrap) return;
    if (!wrap.innerHTML) wrap.innerHTML = `<p class="admin-loading">${esc(I18N.stats.loading)}</p>`;
    try {
      const d = await fetchCharts(leadsRange);
      leadsChartsLoaded = true;
      const L = I18N.leads as Dict;
      const sentSum = d.leads.sent.reduce((s, v) => s + v, 0);
      const stageTotal =
        d.leadStages.replied + d.leadStages.clicked + d.leadStages.none + d.leadStages.optout + d.leadStages.bounced;
      const stageSegs = [
        { label: String(L.replied), value: d.leadStages.replied },
        { label: String(L.stageClicked), value: d.leadStages.clicked },
        { label: String(L.awaiting), value: d.leadStages.none },
        { label: String(L.optOut), value: d.leadStages.optout },
        { label: String(L.bounced), value: d.leadStages.bounced },
      ];
      const destRows = [
        { label: String(L.destNames.demos), value: d.clickDests.demos },
        { label: String(L.destNames.home), value: d.clickDests.home },
        { label: String(L.destNames.pricing), value: d.clickDests.pricing },
        { label: String(L.destNames.start), value: d.clickDests.start },
      ];
      const destMax = Math.max(1, ...destRows.map((r) => r.value));
      const destSum = destRows.reduce((s, r) => s + r.value, 0);
      const empty = `<div class="admin-empty">${esc(L.noData)}</div>`;
      wrap.innerHTML =
        `<div class="admin-grid-2">` +
        `<div class="admin-card"><h2>${esc(L.activityTitle)}</h2>` +
        (sentSum === 0 && d.leads.clicked.every((v) => v === 0) && d.leads.replied.every((v) => v === 0)
          ? empty
          : `<div class="chart-wrap">${buildBars(
              d.labels,
              [
                { name: String(L.sent), values: d.leads.sent, cls: 0 },
                { name: String(L.clicked), values: d.leads.clicked, cls: 1 },
                { name: String(L.replied), values: d.leads.replied, cls: 2 },
              ],
              String(L.activityTitle)
            )}</div>`) +
        `</div>` +
        `<div class="admin-card"><h2>${esc(L.outcomesTitle)}</h2>` +
        (stageTotal === 0
          ? empty
          : buildDonut(stageSegs, nf.format(stageTotal), String(L.sent))) +
        `</div></div>` +
        `<div class="admin-card"><h2>${esc(L.destsTitle)}</h2>` +
        (destSum === 0
          ? `<p class="admin-muted" style="font-size:13px;">${esc(L.noData)}</p>`
          : barList(destRows, destMax)) +
        `</div>`;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      wrap.innerHTML =
        `<div class="admin-retry"><p>${esc(I18N.stats.loadError)}</p>` +
        `<button type="button" class="admin-ghost-btn" data-leads-charts-retry>${esc(I18N.stats.retry)}</button></div>`;
    }
  }

  /* ── Forms tab ── */
  let formsCursor: string | null = null;
  let formsFilter: string = "all";

  function prettyKey(k: string): string {
    const map: Record<string, string> = {
      name: String(I18N.forms.name),
      email: String(I18N.forms.email),
      page: String(I18N.forms.page),
    };
    if (map[k]) return map[k];
    return k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }

  function fmtDateTime(ts: number): string {
    try {
      return new Date(ts).toLocaleString(LOCALE === "fr" ? "fr-CA" : "en-CA", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(ts);
    }
  }

  function formCard(item: FormItem): string {
    const f = item.fields || {};
    const name = f.name || f.business || "—";
    const email = f.email || "";
    const page = f.page || "";
    const detailRows = Object.entries(f)
      .map(
        ([k, v]) => `<div class="ff-row"><dt>${esc(prettyKey(k))}</dt><dd>${esc(v)}</dd></div>`
      )
      .join("");
    return (
      `<article class="form-card" data-form-id="${esc(item.id)}">` +
      `<div class="form-card-head"><div><strong>${esc(name)}</strong>` +
      (email ? `<span class="mono">${esc(email)}</span>` : "") +
      `</div><span class="form-badge">${esc(item.form)}</span></div>` +
      `<div class="form-meta">` +
      `<span><b>${esc(I18N.forms.received)}</b> ${esc(fmtDateTime(item.at))}</span>` +
      (page ? `<span><b>${esc(I18N.forms.page)}</b> ${esc(page)}</span>` : "") +
      `<span><b>${esc(I18N.forms.ip)}</b> ${esc(item.ip)}${item.country ? ` (${esc(item.country)})` : ""}</span>` +
      `</div>` +
      `<div class="form-actions">` +
      `<button type="button" class="admin-ghost-btn" data-expand>${esc(I18N.forms.details)}</button>` +
      `<button type="button" class="admin-ghost-btn" data-delete>${esc(I18N.forms.delete)}</button>` +
      `</div>` +
      `<dl class="form-fields" data-form-fields hidden>${detailRows}</dl>` +
      `</article>`
    );
  }

  async function loadForms(reset: boolean): Promise<void> {
    const list = qq("[data-forms-list]");
    const more = qq<HTMLButtonElement>("[data-forms-more]");
    if (!list || !more) return;
    if (reset) {
      list.innerHTML = "";
      formsCursor = null;
    }
    more.hidden = true;
    try {
      const typeParam = formsFilter !== "all" ? `&type=${encodeURIComponent(formsFilter)}` : "";
      const data = (await api(
        `/api/admin/forms?limit=50${formsCursor ? `&cursor=${encodeURIComponent(formsCursor)}` : ""}${typeParam}`
      )) as unknown as FormsResponse;
      if (reset && data.items.length === 0) {
        list.innerHTML = `<div class="admin-empty">${esc(I18N.forms.empty)}</div>`;
        return;
      }
      for (const item of data.items) list.insertAdjacentHTML("beforeend", formCard(item));
      formsCursor = data.nextCursor;
      more.hidden = !formsCursor;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      if (reset) {
        list.innerHTML =
          `<div class="admin-retry"><p>${esc(I18N.stats.loadError)}</p>` +
          `<button type="button" class="admin-ghost-btn" data-forms-retry>${esc(I18N.stats.retry)}</button></div>`;
      } else {
        toast(String(I18N.stats.loadError), "err");
      }
    }
  }

  async function deleteForm(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-form-id]") as HTMLElement | null;
    const id = card?.dataset.formId;
    if (!card || !id) return;
    if (!window.confirm(String(I18N.forms.deleteConfirm))) return;
    btn.setAttribute("disabled", "");
    try {
      await api(`/api/admin/forms/${encodeURIComponent(id)}`, { method: "DELETE" });
      card.remove();
      toast(String(I18N.forms.deleted), "ok");
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      btn.removeAttribute("disabled");
      toast(String(I18N.forms.deleteError), "err");
    }
  }

  /* ── Outreach leads tab ── */
  let leadsCursor: string | null = null;

  function leadCard(item: LeadItem): string {
    const L = I18N.leads as Dict;
    const badges: string[] = [];
    if (item.repliedAt) badges.push(`<span class="form-badge">${esc(L.replied)}</span>`);
    if (item.clickCount > 0)
      badges.push(`<span class="form-badge">${esc(L.clicked)} ×${item.clickCount}</span>`);
    if (item.optOutAt) badges.push(`<span class="form-badge form-badge--warn">${esc(L.optOut)}</span>`);
    if (item.bouncedAt) badges.push(`<span class="form-badge form-badge--warn">${esc(L.bounced)}</span>`);
    if (badges.length === 0) badges.push(`<span class="form-badge">${esc(L.awaiting)}</span>`);

    const meta: string[] = [
      `<span><b>${esc(L.sent)}</b> ${esc(fmtDateTime(item.sentAt))}</span>`,
    ];
    if (item.city) meta.push(`<span><b>${esc(L.city)}</b> ${esc(item.city)}</span>`);
    if (item.trade) meta.push(`<span><b>${esc(L.trade)}</b> ${esc(item.trade)}</span>`);
    if (item.firstClickAt) meta.push(`<span><b>${esc(L.firstClick)}</b> ${esc(fmtDateTime(item.firstClickAt))}</span>`);
    if (item.lastClickAt && item.lastClickAt !== item.firstClickAt)
      meta.push(`<span><b>${esc(L.lastClick)}</b> ${esc(fmtDateTime(item.lastClickAt))}</span>`);
    if (item.replies && item.replies.length > 0)
      meta.push(`<span><b>${esc(L.replies)}</b> ${item.replies.length}</span>`);

    const rows: string[] = [];
    if (item.subject)
      rows.push(`<div class="ff-row"><dt>${esc(L.subject)}</dt><dd>${esc(item.subject)}</dd></div>`);
    const clicks = item.clicks || [];
    const clickList =
      clicks.length === 0
        ? `<p class="admin-muted" style="font-size:13px;">${esc(L.noClicks)}</p>`
        : `<ul class="lead-events">` +
          clicks
            .map(
              (c) =>
                `<li>${esc(fmtDateTime(c.at))} · /${esc(c.dest)}${c.country ? ` · ${esc(c.country)}` : ""}` +
                (c.suspect ? ` <span class="mono">(${esc(L.scanner)})</span>` : "") +
                `</li>`
            )
            .join("") +
          `</ul>`;
    rows.push(`<div class="ff-row"><dt>${esc(L.clickHistory)}</dt><dd>${clickList}</dd></div>`);
    for (const r of item.replies || []) {
      rows.push(
        `<div class="ff-row"><dt>${esc(r.kind === "optout" ? L.optOut : r.kind === "bounce" ? L.bounced : L.replied)}</dt>` +
          `<dd>${esc(fmtDateTime(r.at))}${r.subject ? ` · ${esc(r.subject)}` : ""}</dd></div>`
      );
    }

    return (
      `<article class="form-card" data-lead-id="${esc(item.id)}">` +
      `<div class="form-card-head"><div><strong>${esc(item.business)}</strong>` +
      (item.email ? `<span class="mono">${esc(item.email)}</span>` : "") +
      `</div><div class="lead-badges">${badges.join("")}</div></div>` +
      `<div class="form-meta">${meta.join("")}</div>` +
      `<div class="form-actions">` +
      `<button type="button" class="admin-ghost-btn" data-lead-expand>${esc(L.details)}</button>` +
      `<button type="button" class="admin-ghost-btn" data-lead-delete>${esc(L.delete)}</button>` +
      `</div>` +
      `<dl class="form-fields" data-lead-fields hidden>${rows.join("")}</dl>` +
      `</article>`
    );
  }

  async function loadLeads(reset: boolean): Promise<void> {
    const list = qq("[data-leads-list]");
    const more = qq<HTMLButtonElement>("[data-leads-more]");
    if (!list || !more) return;
    if (reset) {
      list.innerHTML = "";
      leadsCursor = null;
    }
    more.hidden = true;
    try {
      const data = (await api(
        `/api/admin/leads?limit=50${leadsCursor ? `&cursor=${encodeURIComponent(leadsCursor)}` : ""}`
      )) as unknown as LeadsResponse;
      if (reset && data.items.length === 0) {
        list.innerHTML = `<div class="admin-empty">${esc(I18N.leads.empty)}</div>`;
        return;
      }
      for (const item of data.items) list.insertAdjacentHTML("beforeend", leadCard(item));
      leadsCursor = data.nextCursor;
      more.hidden = !leadsCursor;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      if (reset) {
        list.innerHTML =
          `<div class="admin-retry"><p>${esc(I18N.leads.loadError)}</p>` +
          `<button type="button" class="admin-ghost-btn" data-leads-retry>${esc(I18N.leads.retry)}</button></div>`;
      } else {
        toast(String(I18N.leads.loadError), "err");
      }
    }
  }

  /* ── Clients tab ── */
  let clientsCursor: string | null = null;

  function clientCard(item: ClientItem): string {
    const C = I18N.clients as Dict;
    const F = (C.fields || {}) as Dict;
    const stages = (C.stages || {}) as Dict;
    const badge = item.onboardingComplete
      ? `<span class="form-badge">${esc(C.onboardingDone)}</span>`
      : `<span class="form-badge form-badge--warn">${esc(C.onboardingPending)}</span>`;
    const domainBadgeMap = (C.domainStatuses || {}) as Dict;
    const domainBadgeKey =
      item.domainStatus === "to-register"
        ? "toRegister"
        : item.domainStatus === "pending-dns"
          ? "pendingDns"
          : item.domainStatus;
    const domainBadge =
      item.domainStatus && item.domainStatus !== "none"
        ? `<span class="form-badge">${esc(domainBadgeMap[domainBadgeKey] || item.domainStatus)}</span>`
        : "";
    const qaBadge =
      item.buildQaPassed === undefined
        ? `<span class="form-badge">${esc(C.noBuild)}</span>`
        : item.buildQaPassed
          ? `<span class="form-badge">${esc(C.qaPassed)}</span>`
          : `<span class="form-badge form-badge--warn">${esc(C.qaFailed)}</span>`;
    const decisionBadge =
      item.reviewDecision?.decision === "changes"
        ? `<span class="form-badge form-badge--warn">${esc(C.changesRequested)}</span>`
        : item.reviewDecision?.decision === "approved"
          ? `<span class="form-badge">${esc(C.approved)}</span>`
          : "";
    const adsBadge = item.hasAds
      ? `<span class="form-badge">${esc(C.adsBadge)} · ${esc(item.adsStatus || "onboarding")}</span>`
      : "";
    const meta: string[] = [
      `<span><b>${esc(C.billing)}</b> ${esc(item.billingStatus)}</span>`,
      `<span><b>${esc(C.since)}</b> ${esc(fmtDateTime(item.createdAt))}</span>`,
    ];
    if (item.items.length > 0)
      meta.push(`<span><b>${esc(C.items)}</b> ${esc(item.items.join(", "))}</span>`);
    if (item.nudgeCount > 0) meta.push(`<span><b>${esc(C.nudges)}</b> ${item.nudgeCount}</span>`);
    if (item.revisionCount > 0)
      meta.push(`<span><b>${esc(C.revisions)}</b> ${item.revisionCount}</span>`);
    if (item.hasAds && item.adsTrade)
      meta.push(`<span><b>${esc(C.adsTrade)}</b> ${esc(item.adsTrade)}</span>`);
    if (item.hasAds && item.adsBudget)
      meta.push(`<span><b>${esc(C.adsBudget)}</b> $${item.adsBudget}</span>`);
    if (item.nudgesEscalatedAt)
      meta.push(`<span><b>${esc(C.escalated)}</b> ${esc(fmtDateTime(item.nudgesEscalatedAt))}</span>`);

    const o = item.onboarding || {};
    const val = (k: string): string => {
      const v = o[k];
      if (v === undefined || v === null || v === "") return "";
      if (typeof v === "boolean") return String(v ? C.yes : C.no);
      if (Array.isArray(v)) return v.join(", ");
      return String(v);
    };
    const rows: string[] = [];
    const addRow = (label: unknown, value: string): void => {
      if (value) rows.push(`<div class="ff-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`);
    };
    addRow(F.businessName, val("businessName"));
    addRow(F.contactName, val("contactName"));
    addRow(F.phone, val("phone"));
    addRow(F.services, val("services"));
    addRow(F.serviceArea, val("serviceArea"));
    addRow(F.hours, val("hours"));
    addRow(F.about, val("about"));
    addRow(F.hasLogo, val("hasLogo"));
    addRow(F.brandNotes, val("brandNotes"));
    addRow(F.photosReady, val("photosReady"));
    const domain = [o.domainMode ? String(o.domainMode) : "", val("domainValue")].filter(Boolean).join(" · ");
    addRow(F.domain, domain);
    addRow(F.styleDemos, val("styleDemos"));
    addRow(F.styleNotes, val("styleNotes"));
    addRow(F.extraNotes, val("extraNotes"));
    for (const failed of item.buildQaFailedChecks || []) {
      rows.push(
        `<div class="ff-row"><dt>${esc(C.qaTitle)}</dt><dd>${esc(failed.id)}: ${esc(failed.detail)}</dd></div>`
      );
    }
    if (item.reviewDecision?.decision === "changes" && item.reviewDecision.note) {
      rows.push(
        `<div class="ff-row"><dt>${esc(C.changeNote)}</dt><dd>${esc(item.reviewDecision.note)}</dd></div>`
      );
    }

    const stageOptions = ["onboarding", "build", "review", "live", "paused"]
      .map(
        (s) =>
          `<option value="${s}"${item.stage === s ? " selected" : ""}>${esc(stages[s] || s)}</option>`
      )
      .join("");

    const adsStatusOptions = ["onboarding", "setup", "ready", "live", "paused"]
      .map(
        (s) =>
          `<option value="${s}"${item.adsStatus === s ? " selected" : ""}>${s}</option>`
      )
      .join("");
    const adsControls = item.hasAds
      ? `<div class="form-actions" style="gap:10px; flex-wrap:wrap; margin-top:8px;">` +
        `<label style="display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600;">${esc(C.adsStatus)}` +
        `<select data-client-ads-status style="padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);">${adsStatusOptions}</select></label>` +
        `<label style="display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600; flex:1; min-width:200px;">${esc(C.adsAccount)}` +
        `<input type="text" data-client-ads-account value="${esc(item.adAccountId || "")}" placeholder="act_..." style="flex:1; padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);" /></label>` +
        `<input type="text" data-client-ads-spend-month placeholder="${esc(C.adsSpendMonth)}" style="width:90px; padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);" />` +
        `<input type="number" data-client-ads-spend-amount placeholder="${esc(C.adsSpendAmount)}" style="width:110px; padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);" />` +
        `<button type="button" class="admin-ghost-btn" data-client-ads-spend>${esc(C.adsSpendSave)}</button>` +
        `<button type="button" class="admin-ghost-btn" data-client-ads-packet>${esc(C.adsPacket)}</button>` +
        `</div>` +
        `<pre data-client-packet hidden style="white-space:pre-wrap; font-size:12.5px; line-height:1.55; border:1px solid var(--line); border-radius:10px; padding:14px; margin-top:10px; overflow:auto;"></pre>`
      : "";

    return (
      `<article class="form-card" data-client-id="${esc(item.id)}" data-client-lang="${esc(item.lang || "en")}">` +
      `<div class="form-card-head"><div><strong>${esc(item.business || item.email)}</strong>` +
      `<span class="mono">${esc(item.email)}</span></div>` +
      `<div class="lead-badges">${badge}${domainBadge}${qaBadge}${decisionBadge}${adsBadge}${item.test ? `<span class="form-badge form-badge--warn">${esc(C.testBadge)}</span>` : ""}</div></div>` +
      `<div class="form-meta">${meta.join("")}</div>` +
      `<div class="form-actions" style="gap:10px; flex-wrap:wrap;">` +
      `<label style="display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600;">${esc(C.stage)}` +
      `<select data-client-stage style="padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);">${stageOptions}</select></label>` +
      `<label style="display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600; flex:1; min-width:220px;">${esc(C.previewUrl)}` +
      `<input type="url" data-client-preview value="${esc(item.previewUrl || "")}" placeholder="https://" style="flex:1; padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);" /></label>` +
      `<label style="display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600; flex:1; min-width:220px;">${esc(C.domain)}` +
      `<input type="text" data-client-domain value="${esc(item.domain || "")}" placeholder="patplumbing.ca" style="flex:1; padding:7px 9px; border-radius:8px; border:1px solid var(--line-strong); background: var(--paper); color: var(--ink);" /></label>` +
      `<button type="button" class="admin-ghost-btn" data-client-save>${esc(C.save)}</button>` +
      `<button type="button" class="admin-ghost-btn" data-client-build>${esc(C.build)}</button>` +
      `<button type="button" class="admin-ghost-btn" data-client-view-as>${esc(C.viewAs)}</button>` +
      (item.publishPending
        ? `<button type="button" class="admin-ghost-btn" data-client-publish>${esc(C.publish)}</button>`
        : "") +
      `<button type="button" class="admin-ghost-btn" data-client-expand>${esc(C.details)}</button>` +
      `</div>` +
      adsControls +
      `<dl class="form-fields" data-client-fields hidden>` +
      (rows.length > 0 ? rows.join("") : `<p class="admin-muted" style="font-size:13px;">${esc(C.onboardingPending)}</p>`) +
      `</dl>` +
      `</article>`
    );
  }

  async function loadClients(reset: boolean): Promise<void> {
    const list = qq("[data-clients-list]");
    const more = qq<HTMLButtonElement>("[data-clients-more]");
    if (!list || !more) return;
    if (reset) {
      list.innerHTML = "";
      clientsCursor = null;
    }
    more.hidden = true;
    try {
      const data = (await api(
        `/api/admin/clients?limit=50${clientsCursor ? `&cursor=${encodeURIComponent(clientsCursor)}` : ""}`
      )) as unknown as ClientsResponse;
      if (reset && data.items.length === 0 && !(data.abandoned && data.abandoned.length > 0)) {
        list.innerHTML = `<div class="admin-empty">${esc(I18N.clients.empty)}</div>`;
        return;
      }
      for (const item of data.items) list.insertAdjacentHTML("beforeend", clientCard(item));
      if (reset && data.abandoned && data.abandoned.length > 0) {
        const rows = data.abandoned
          .map((a) => {
            const amount =
              typeof a.amountTotal === "number"
                ? ` · $${(a.amountTotal / 100).toFixed(2)}`
                : "";
            const statusLabel =
              (I18N.clients.abandonedStatuses as Record<string, string> | undefined)?.[a.status] || a.status;
            const itemsLabel = a.items.join(", ") || String(I18N.clients.abandonedCheckout || "checkout");
            return (
              `<div class="form-meta"><span>${esc(a.email)}</span>` +
              `<span>${esc(itemsLabel)}${amount} · ${esc(statusLabel)} · ${esc(fmtDateTime(a.createdAt))}</span></div>`
            );
          })
          .join("");
        list.insertAdjacentHTML(
          "beforeend",
          `<div class="form-card"><div class="form-card-head">${esc(I18N.clients.abandonedTitle)}</div>${rows}</div>`,
        );
      }
      clientsCursor = data.nextCursor;
      more.hidden = !clientsCursor;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      if (reset) {
        list.innerHTML =
          `<div class="admin-retry"><p>${esc(I18N.clients.loadError)}</p>` +
          `<button type="button" class="admin-ghost-btn" data-clients-retry>${esc(I18N.clients.retry)}</button></div>`;
      } else {
        toast(String(I18N.clients.loadError), "err");
      }
    }
  }

  async function saveClient(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-client-id]") as HTMLElement | null;
    const id = card?.dataset.clientId;
    if (!card || !id) return;
    const stage = (card.querySelector("[data-client-stage]") as HTMLSelectElement | null)?.value;
    const previewUrl = (card.querySelector("[data-client-preview]") as HTMLInputElement | null)?.value;
    const domain = (card.querySelector("[data-client-domain]") as HTMLInputElement | null)?.value;
    const adsStatus = (card.querySelector("[data-client-ads-status]") as HTMLSelectElement | null)?.value;
    const adAccountId = (card.querySelector("[data-client-ads-account]") as HTMLInputElement | null)?.value;
    btn.setAttribute("disabled", "");
    try {
      await api("/api/admin/clients/update", {
        method: "POST",
        body: {
          id,
          stage,
          previewUrl,
          domain,
          ...(adsStatus !== undefined ? { adsStatus } : {}),
          ...(adAccountId !== undefined ? { adAccountId } : {}),
        },
      });
      toast(String(I18N.clients.saved), "ok");
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.saveError), "err");
    } finally {
      btn.removeAttribute("disabled");
    }
  }

  async function viewAsClient(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-client-id]") as HTMLElement | null;
    const id = card?.dataset.clientId;
    if (!card || !id) return;
    btn.setAttribute("disabled", "");
    try {
      await api("/api/admin/clients/view-as", { method: "POST", body: { id } });
      window.location.href = card.dataset.clientLang === "fr" ? "/fr/portail" : "/portal";
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.actionError), "err");
      btn.removeAttribute("disabled");
    }
  }

  async function createTestClient(): Promise<void> {
    const email = window.prompt(String(I18N.clients.testEmailPrompt), "");
    if (!email) return;
    try {
      await api("/api/admin/clients/create-test", {
        method: "POST",
        body: {
          email: email.trim(),
          lang: document.documentElement.lang.startsWith("fr") ? "fr" : "en",
        },
      });
      toast(String(I18N.clients.testCreated), "ok");
      tabLoaded.clients = false;
      void loadClients(true);
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.actionError), "err");
    }
  }

  async function runClientAction(btn: HTMLElement, action: "build" | "publish"): Promise<void> {
    const card = btn.closest("[data-client-id]") as HTMLElement | null;
    const id = card?.dataset.clientId;
    if (!card || !id) return;
    btn.setAttribute("disabled", "");
    try {
      const data = await api(`/api/admin/clients/${action}`, {
        method: "POST",
        body: { id },
      });
      if (action === "build") {
        toast(
          data.qaPassed ? String(I18N.clients.builtOk) : String(I18N.clients.qaFailed),
          data.qaPassed ? "ok" : "err",
        );
      } else {
        toast(String(I18N.clients.publishedOk), "ok");
      }
      tabLoaded.clients = false;
      void loadClients(true);
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.actionError), "err");
      btn.removeAttribute("disabled");
    }
  }

  async function recordClientAdsSpend(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-client-id]") as HTMLElement | null;
    const id = card?.dataset.clientId;
    if (!card || !id) return;
    const month = (card.querySelector("[data-client-ads-spend-month]") as HTMLInputElement | null)?.value.trim() || "";
    const dollars = Number((card.querySelector("[data-client-ads-spend-amount]") as HTMLInputElement | null)?.value);
    if (!/^\d{4}-\d{2}$/.test(month) || !(dollars >= 0)) {
      toast(String(I18N.clients.actionError), "err");
      return;
    }
    btn.setAttribute("disabled", "");
    try {
      await api("/api/admin/clients/ads-spend", {
        method: "POST",
        body: { id, month, amountCents: Math.round(dollars * 100) },
      });
      toast(String(I18N.clients.saved), "ok");
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.actionError), "err");
    } finally {
      btn.removeAttribute("disabled");
    }
  }

  async function showClientAdsPacket(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-client-id]") as HTMLElement | null;
    const id = card?.dataset.clientId;
    const pre = card?.querySelector("[data-client-packet]") as HTMLElement | null;
    if (!card || !id || !pre) return;
    if (!pre.hidden) {
      pre.hidden = true;
      return;
    }
    btn.setAttribute("disabled", "");
    try {
      const data = await api(`/api/admin/clients/ads-packet?id=${encodeURIComponent(id)}`);
      const p = data.packet as Record<string, unknown>;
      const readiness = (p.readiness as Array<{ ok: boolean; labelEn: string }>) || [];
      const lines = [
        `${p.business} · ${p.trade} · Meta`,
        `Budget: $${p.monthlyBudget}/mo ($${p.dailyBudget}/day) · Area: ${p.serviceArea} · Radius: ${p.radiusKm} km`,
        `Landing: ${p.landingPage || "(none)"}`,
        `Services: ${((p.services as string[]) || []).join(", ")}`,
        ``,
        `Headlines:`,
        ...((p.headlines as string[]) || []).map((h) => `- ${h}`),
        ``,
        `Primary texts:`,
        ...((p.primaryTexts as string[]) || []).map((h) => `- ${h}`),
        ``,
        `Lead form questions:`,
        ...((p.formQuestions as string[]) || []).map((h) => `- ${h}`),
        ``,
        `Readiness: ${p.ready ? "READY" : "NOT READY"}`,
        ...readiness.map((c) => `${c.ok ? "✓" : "✗"} ${c.labelEn}`),
      ];
      pre.textContent = lines.join("\n");
      pre.hidden = false;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      toast(String(I18N.clients.actionError), "err");
    } finally {
      btn.removeAttribute("disabled");
    }
  }

  async function deleteLead(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-lead-id]") as HTMLElement | null;
    const id = card?.dataset.leadId;
    if (!card || !id) return;
    if (!window.confirm(String(I18N.leads.deleteConfirm))) return;
    btn.setAttribute("disabled", "");
    try {
      await api(`/api/admin/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
      card.remove();
      toast(String(I18N.leads.deleted), "ok");
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      btn.removeAttribute("disabled");
      toast(String(I18N.leads.deleteError), "err");
    }
  }

  /* ── Audits tab ── */
  interface AuditItem {
    id: string;
    url: string;
    score: number;
    findings: string[];
    strengths: string[];
    categories: Record<string, number>;
    partial: boolean;
    lang: string;
    at: number;
    email?: string;
    reportRequestedAt?: number;
  }

  interface AuditsResponse {
    ok: boolean;
    items: AuditItem[];
    nextCursor: string | null;
  }

  let auditsCursor: string | null = null;

  function auditCard(item: AuditItem): string {
    const A = I18N.audits as Dict;
    const badges: string[] = [
      `<span class="form-badge">${esc(A.score)} ${item.score}/100</span>`,
    ];
    if (item.partial)
      badges.push(`<span class="form-badge form-badge--warn">${esc(A.partial)}</span>`);
    if (item.reportRequestedAt)
      badges.push(`<span class="form-badge">${esc(A.reportRequested)}</span>`);
    else if (!item.email)
      badges.push(`<span class="form-badge">${esc(A.noEmail)}</span>`);

    const meta: string[] = [
      `<span><b>${esc(A.at)}</b> ${esc(fmtDateTime(item.at))}</span>`,
    ];
    if (item.email) meta.push(`<span><b>${esc(A.email)}</b> ${esc(item.email)}</span>`);

    const rows: string[] = [];
    if (item.strengths.length > 0) {
      rows.push(
        `<div class="ff-row"><dt>${esc(A.strengths)}</dt><dd>${item.strengths.map((s) => esc(s)).join("<br>")}</dd></div>`,
      );
    }
    rows.push(
      `<div class="ff-row"><dt>${esc(A.findings)}</dt><dd><ul>` +
        item.findings.map((f) => `<li>${esc(f)}</li>`).join("") +
        `</ul></dd></div>`,
    );
    rows.push(
      `<div class="ff-row"><dt>${esc(A.url)}</dt><dd><a href="/audits/${esc(item.id)}" target="_blank" rel="noopener">/audits/${esc(item.id)}</a></dd></div>`,
    );

    return (
      `<article class="form-card" data-audit-id="${esc(item.id)}">` +
      `<div class="form-card-head"><div><strong>${esc(item.url)}</strong>` +
      (item.email ? `<span class="mono">${esc(item.email)}</span>` : "") +
      `</div><div class="lead-badges">${badges.join("")}</div></div>` +
      `<div class="form-meta">${meta.join("")}</div>` +
      `<div class="form-actions">` +
      `<button type="button" class="admin-ghost-btn" data-audit-expand>${esc(A.details)}</button>` +
      `<button type="button" class="admin-ghost-btn" data-audit-delete>${esc(A.delete)}</button>` +
      `</div>` +
      `<dl class="form-fields" data-audit-fields hidden>${rows.join("")}</dl>` +
      `</article>`
    );
  }

  async function loadAudits(reset: boolean): Promise<void> {
    const list = qq("[data-audits-list]");
    const more = qq<HTMLButtonElement>("[data-audits-more]");
    if (!list || !more) return;
    if (reset) {
      list.innerHTML = "";
      auditsCursor = null;
    }
    more.hidden = true;
    try {
      const data = (await api(
        `/api/admin/audits?limit=50${auditsCursor ? `&cursor=${encodeURIComponent(auditsCursor)}` : ""}`,
      )) as unknown as AuditsResponse;
      if (reset && data.items.length === 0) {
        list.innerHTML = `<div class="admin-empty">${esc(I18N.audits.empty)}</div>`;
        return;
      }
      for (const item of data.items) list.insertAdjacentHTML("beforeend", auditCard(item));
      auditsCursor = data.nextCursor;
      more.hidden = !auditsCursor;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      if (reset) {
        list.innerHTML =
          `<div class="admin-retry"><p>${esc(I18N.audits.loadError)}</p>` +
          `<button type="button" class="admin-ghost-btn" data-audits-retry>${esc(I18N.audits.retry)}</button></div>`;
      } else {
        toast(String(I18N.audits.loadError), "err");
      }
    }
  }

  async function deleteAudit(btn: HTMLElement): Promise<void> {
    const card = btn.closest("[data-audit-id]") as HTMLElement | null;
    const id = card?.dataset.auditId;
    if (!card || !id) return;
    if (!window.confirm(String(I18N.audits.deleteConfirm))) return;
    btn.setAttribute("disabled", "");
    try {
      await api(`/api/admin/audits/${encodeURIComponent(id)}`, { method: "DELETE" });
      card.remove();
      toast(String(I18N.audits.deleted), "ok");
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      btn.removeAttribute("disabled");
      toast(String(I18N.audits.deleteError), "err");
    }
  }

  /* ── Config tab ── */
  async function loadConfig(): Promise<void> {
    const errEl = qq("[data-settings-error]");
    if (errEl) errEl.hidden = true;
    try {
      const data = await api("/api/admin/config");
      const s = data.settings as Settings;
      const themeSel = qq<HTMLSelectElement>("[data-setting-theme]");
      const trackChk = qq<HTMLInputElement>("[data-setting-tracking]");
      if (themeSel && (s.defaultTheme === "system" || s.defaultTheme === "light" || s.defaultTheme === "dark")) {
        themeSel.value = s.defaultTheme;
      }
      if (trackChk) trackChk.checked = !!s.trackingEnabled;
    } catch (e) {
      if (e instanceof ExpiredSession) return;
      if (errEl) {
        errEl.textContent = String(I18N.config.loadError);
        errEl.hidden = false;
      }
    }
  }

  async function onSettingsSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const errEl = qq("[data-settings-error]");
    if (errEl) errEl.hidden = true;
    const themeSel = qq<HTMLSelectElement>("[data-setting-theme]");
    const trackChk = qq<HTMLInputElement>("[data-setting-tracking]");
    try {
      await api("/api/admin/config", {
        method: "POST",
        body: {
          defaultTheme: themeSel ? themeSel.value : "system",
          trackingEnabled: trackChk ? trackChk.checked : true,
        },
      });
      toast(String(I18N.config.saved), "ok");
    } catch (err) {
      if (err instanceof ExpiredSession) return;
      if (errEl) {
        errEl.textContent = String(I18N.config.saveError);
        errEl.hidden = false;
      } else {
        toast(String(I18N.config.saveError), "err");
      }
    }
  }

  async function onPasswordSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const cur = qq<HTMLInputElement>("[data-pw-current]");
    const next = qq<HTMLInputElement>("[data-pw-next]");
    const conf = qq<HTMLInputElement>("[data-pw-confirm]");
    const errEl = qq("[data-pw-error]");
    if (!cur || !next || !conf || !errEl) return;
    errEl.hidden = true;
    const nextVal = next.value;
    if (nextVal.length < 12) {
      errEl.textContent = String(I18N.config.pwTooShort);
      errEl.hidden = false;
      return;
    }
    if (nextVal !== conf.value) {
      errEl.textContent = String(I18N.config.pwMismatch);
      errEl.hidden = false;
      return;
    }
    try {
      await api("/api/admin/password", {
        method: "POST",
        body: { current: cur.value, next: nextVal },
      });
      cur.value = "";
      next.value = "";
      conf.value = "";
      toast(String(I18N.config.pwChanged), "ok");
    } catch (err) {
      if (err instanceof ExpiredSession) return;
      const msg = err instanceof Error ? err.message : "";
      // The API answers 401 "Current password incorrect" when the *password*
      // is wrong (distinct from an expired token, handled in api()).
      errEl.textContent =
        msg === "Current password incorrect" ? String(I18N.config.pwWrong) : msg || String(I18N.config.pwWrong);
      errEl.hidden = false;
    }
  }

  /* ── Wiring ── */
  qq<HTMLFormElement>("[data-login-form]")?.addEventListener("submit", (e) => void onLogin(e));
  qq("[data-logout]")?.addEventListener("click", () => {
    setToken(null);
    showLogin();
  });

  const tabBtns = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-tab]"));
  tabBtns.forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab || "stats"))
  );
  const tablist = qq('[role="tablist"]');
  tablist?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const idx = tabBtns.findIndex((b) => b.dataset.tab === activeTab);
    const next = (idx + (e.key === "ArrowRight" ? 1 : -1) + tabBtns.length) % tabBtns.length;
    tabBtns[next].focus();
    activateTab(tabBtns[next].dataset.tab || "stats");
  });

  const rangeBtns = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-range]"));
  rangeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const r = b.dataset.range;
      const valid = r === "day" || r === "week" || r === "month" || r === "year";
      if (valid && r !== range) {
        range = r as "day" | "week" | "month" | "year";
        rangeBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        void loadStats();
      }
    })
  );

  const formsRangeBtns = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-forms-range]"));
  formsRangeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const r = b.dataset.formsRange;
      if ((r === "day" || r === "week" || r === "month" || r === "year") && r !== formsRange) {
        formsRange = r;
        formsRangeBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        void loadFormsCharts();
      }
    })
  );

  const leadsRangeBtns = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-leads-range]"));
  leadsRangeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const r = b.dataset.leadsRange;
      if ((r === "day" || r === "week" || r === "month" || r === "year") && r !== leadsRange) {
        leadsRange = r;
        leadsRangeBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        void loadLeadsCharts();
      }
    })
  );

  /* ── Chart hover: one shared tooltip per chart wrap, crosshair for the
        line chart, and slice/legend highlighting for donuts. Pointer
        events cover touch (tap) as well as the mouse. ── */
  function tipEl(wrap: HTMLElement): HTMLElement {
    let tip = wrap.querySelector<HTMLElement>(":scope > .chart-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "chart-tip";
      tip.hidden = true;
      wrap.appendChild(tip);
    }
    return tip;
  }

  function setHot(wrap: HTMLElement, idx: string | null): void {
    wrap.querySelectorAll(".is-hot").forEach((el) => el.classList.remove("is-hot"));
    if (idx !== null) {
      wrap
        .querySelectorAll(`[data-seg-idx="${idx}"]`)
        .forEach((el) => el.classList.add("is-hot"));
    }
  }

  rootEl.addEventListener("pointermove", (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t || !t.closest) return;
    const el = t.closest("[data-tip]") as HTMLElement | null;
    if (!el) return;
    const wrap = el.closest(".chart-wrap") as HTMLElement | null;
    if (!wrap) return;
    const tip = tipEl(wrap);
    tip.textContent = el.dataset.tip || "";
    tip.hidden = false;
    const rect = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 56), Math.max(56, rect.width - 56));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(0, e.clientY - rect.top - 10)}px`;
    const cx = el.dataset.cx;
    if (cx) {
      const cross = el.closest("svg")?.querySelector(".chart-cross");
      if (cross) {
        cross.setAttribute("x1", cx);
        cross.setAttribute("x2", cx);
        cross.classList.add("is-on");
      }
    }
    const segEl = t.closest("[data-seg-idx]") as HTMLElement | null;
    if (segEl && wrap.classList.contains("donut-wrap")) setHot(wrap, segEl.dataset.segIdx ?? null);
  });

  rootEl.addEventListener("pointerout", (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t || !t.closest) return;
    const el = t.closest("[data-tip], [data-seg-idx]") as HTMLElement | null;
    if (!el) return;
    // Still inside the same interactive element: not a real leave.
    if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return;
    const wrap = el.closest(".chart-wrap") as HTMLElement | null;
    if (wrap) {
      const tip = wrap.querySelector<HTMLElement>(":scope > .chart-tip");
      if (tip) tip.hidden = true;
      wrap.querySelector(".chart-cross")?.classList.remove("is-on");
      if (wrap.classList.contains("donut-wrap")) setHot(wrap, null);
    }
  });

  const filterBtns = Array.from(rootEl.querySelectorAll<HTMLElement>("[data-forms-filter]"));
  filterBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const f = b.dataset.formsFilter || "all";
      if (f !== formsFilter) {
        formsFilter = f;
        filterBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        void loadForms(true);
      }
    })
  );
  qq<HTMLSelectElement>("[data-page-filter]")?.addEventListener("change", (e) => {
    pageFilter = (e.target as HTMLSelectElement).value;
    void loadStats();
  });

  qq("[data-forms-more]")?.addEventListener("click", () => void loadForms(false));
  qq("[data-leads-more]")?.addEventListener("click", () => void loadLeads(false));
  qq("[data-audits-more]")?.addEventListener("click", () => void loadAudits(false));
  qq("[data-clients-more]")?.addEventListener("click", () => void loadClients(false));
  qq("[data-clients-create-test]")?.addEventListener("click", () => void createTestClient());
  qq<HTMLFormElement>("[data-settings-form]")?.addEventListener("submit", (e) => void onSettingsSubmit(e));
  qq<HTMLFormElement>("[data-pw-form]")?.addEventListener("submit", (e) => void onPasswordSubmit(e));

  // Delegated clicks for dynamically rendered content (retry / expand / delete).
  rootEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t || !t.closest) return;
    if (t.closest("[data-stats-retry]")) {
      void loadStats();
      return;
    }
    if (t.closest("[data-forms-charts-retry]")) {
      void loadFormsCharts();
      return;
    }
    if (t.closest("[data-leads-charts-retry]")) {
      void loadLeadsCharts();
      return;
    }
    const typeBtn = t.closest("[data-chart-type]") as HTMLElement | null;
    if (typeBtn) {
      const next = typeBtn.dataset.chartType;
      if ((next === "line" || next === "bars") && next !== chartType) {
        chartType = next;
        if (lastStats) renderStats(lastStats);
      }
      return;
    }
    const seriesBtn = t.closest("[data-series-toggle]") as HTMLElement | null;
    if (seriesBtn) {
      if (seriesBtn.dataset.seriesToggle === "views") showViews = !showViews;
      if (seriesBtn.dataset.seriesToggle === "visitors") showVisitors = !showVisitors;
      if (lastStats) renderStats(lastStats);
      return;
    }
    if (t.closest("[data-forms-retry]")) {
      void loadForms(true);
      return;
    }
    if (t.closest("[data-leads-retry]")) {
      void loadLeads(true);
      return;
    }
    if (t.closest("[data-audits-retry]")) {
      void loadAudits(true);
      return;
    }
    if (t.closest("[data-clients-retry]")) {
      void loadClients(true);
      return;
    }
    const clientExpand = t.closest("[data-client-expand]") as HTMLElement | null;
    if (clientExpand) {
      const card = clientExpand.closest("[data-client-id]");
      const fields = card?.querySelector("[data-client-fields]") as HTMLElement | null;
      if (fields) {
        fields.hidden = !fields.hidden;
        clientExpand.textContent = fields.hidden
          ? String(I18N.clients.details)
          : String(I18N.clients.hideDetails);
      }
      return;
    }
    const clientSave = t.closest("[data-client-save]") as HTMLElement | null;
    if (clientSave) {
      void saveClient(clientSave);
      return;
    }
    const clientBuild = t.closest("[data-client-build]") as HTMLElement | null;
    if (clientBuild) {
      void runClientAction(clientBuild, "build");
      return;
    }
    const clientPublish = t.closest("[data-client-publish]") as HTMLElement | null;
    if (clientPublish) {
      void runClientAction(clientPublish, "publish");
      return;
    }
    const clientViewAs = t.closest("[data-client-view-as]") as HTMLElement | null;
    if (clientViewAs) {
      void viewAsClient(clientViewAs);
      return;
    }
    const clientAdsSpend = t.closest("[data-client-ads-spend]") as HTMLElement | null;
    if (clientAdsSpend) {
      void recordClientAdsSpend(clientAdsSpend);
      return;
    }
    const clientAdsPacket = t.closest("[data-client-ads-packet]") as HTMLElement | null;
    if (clientAdsPacket) {
      void showClientAdsPacket(clientAdsPacket);
      return;
    }
    const leadExpand = t.closest("[data-lead-expand]") as HTMLElement | null;
    if (leadExpand) {
      const card = leadExpand.closest("[data-lead-id]");
      const fields = card?.querySelector("[data-lead-fields]") as HTMLElement | null;
      if (fields) {
        fields.hidden = !fields.hidden;
        leadExpand.textContent = fields.hidden
          ? String(I18N.leads.details)
          : String(I18N.leads.hideDetails);
      }
      return;
    }
    const leadDel = t.closest("[data-lead-delete]") as HTMLElement | null;
    if (leadDel) void deleteLead(leadDel);
    const auditExpand = t.closest("[data-audit-expand]") as HTMLElement | null;
    if (auditExpand) {
      const card = auditExpand.closest("[data-audit-id]");
      const fields = card?.querySelector("[data-audit-fields]") as HTMLElement | null;
      if (fields) {
        fields.hidden = !fields.hidden;
        auditExpand.textContent = fields.hidden
          ? String(I18N.audits.details)
          : String(I18N.audits.hideDetails);
      }
      return;
    }
    const auditDel = t.closest("[data-audit-delete]") as HTMLElement | null;
    if (auditDel) void deleteAudit(auditDel);
    const expand = t.closest("[data-expand]") as HTMLElement | null;
    if (expand) {
      const card = expand.closest("[data-form-id]");
      const fields = card?.querySelector("[data-form-fields]") as HTMLElement | null;
      if (fields) {
        fields.hidden = !fields.hidden;
        expand.textContent = fields.hidden
          ? String(I18N.forms.details)
          : String(I18N.forms.hideDetails);
      }
      return;
    }
    const del = t.closest("[data-delete]") as HTMLElement | null;
    if (del) void deleteForm(del);
  });

  // Boot: resume the session if a token is stored, otherwise show the gate.
  if (getToken()) showApp();
  else showLogin();
}

document.addEventListener("astro:page-load", initAdmin);
if (document.readyState !== "loading") initAdmin();
else document.addEventListener("DOMContentLoaded", initAdmin, { once: true });
