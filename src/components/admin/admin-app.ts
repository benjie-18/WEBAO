// WEBAO admin panel client app.
// Login gate + three tabs (Stats / Forms / Config) talking to the Worker API
// described in worker/API.md. All user-controlled strings are HTML-escaped
// before rendering. Auth token lives in sessionStorage (never in the URL).

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
  const tabLoaded: Record<string, boolean> = { stats: false, forms: false, config: false };

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
      else if (name === "config") void loadConfig();
    }
  }

  /* ── Stats tab ── */
  type Range = "day" | "week" | "month" | "year";
  let range: Range = "week";
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

  async function loadStats(): Promise<void> {
    setStatsLoading();
    try {
      const data = (await api(
        `/api/admin/stats?range=${range}&page=${encodeURIComponent(pageFilter)}`
      )) as unknown as StatsResponse;
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
    const deviceMax = Math.max(1, ...deviceRows.map((r) => r.value));
    const countries = d.countries || [];
    const countryMax = Math.max(1, ...countries.map((c) => c.count));
    const topMax = Math.max(1, ...d.topPages.map((p) => p.views));

    body.innerHTML =
      `<div class="admin-kpis">${kpis}</div>` +
      `<div class="admin-card"><div class="admin-card-head"><h2>${esc(I18N.stats.chartTitle)}</h2>` +
      `<div class="admin-legend"><span><i class="dot dot--views"></i>${esc(I18N.stats.chartViews)}</span>` +
      `<span><i class="dot dot--visitors"></i>${esc(I18N.stats.chartVisitors)}</span></div></div>` +
      `<div class="admin-chart">${totalViews === 0 ? `<div class="admin-empty">${esc(I18N.stats.noData)}</div>` : buildChart(d.labels, d.views, d.visitors)}</div></div>` +
      `<div class="admin-grid-3">` +
      `<div class="admin-card"><h2>${esc(I18N.stats.topPages)}</h2>${barList(d.topPages.map((p) => ({ label: p.path, value: p.views })), topMax)}</div>` +
      `<div class="admin-card"><h2>${esc(I18N.stats.devices)}</h2>${barList(deviceRows, deviceMax)}</div>` +
      `<div class="admin-card"><h2>${esc(I18N.stats.countries)}</h2>${barList(countries.map((c) => ({ label: `${countryName(c.code)} · ${c.code}`, value: c.count })), countryMax)}</div>` +
      `</div>`;
  }

  /** Round the chart's top gridline up to a "nice" number. */
  function niceCeil(v: number): number {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return nice * base;
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

  /** Custom SVG line/area chart — no dependencies, theme-aware via CSS classes. */
  function buildChart(labels: string[], views: number[], visitors: number[]): string {
    const W = 720;
    const H = 250;
    const padL = 40;
    const padR = 14;
    const padT = 16;
    const padB = 30;
    const n = labels.length;
    const top = niceCeil(Math.max(1, ...views, ...visitors));
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
    const dots = views
      .map(
        (v, i) =>
          `<circle class="chart-dot" cx="${f(X(i))}" cy="${f(Y(v))}" r="3.5">` +
          `<title>${esc(fmtLabel(labels[i]))}: ${nf.format(v)}</title></circle>`
      )
      .join("");

    return (
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(I18N.stats.chartTitle)}">` +
      grid +
      `<path class="chart-area" d="${area}"/>` +
      `<path class="chart-line-vis" d="${line(visitors)}"/>` +
      `<path class="chart-line" d="${line(views)}"/>` +
      ticks +
      dots +
      `</svg>`
    );
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
    if (nextVal.length < 5) {
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
    if (t.closest("[data-forms-retry]")) {
      void loadForms(true);
      return;
    }
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
