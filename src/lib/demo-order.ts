/**
 * Shared per-visitor demo order.
 *
 * The site is statically prerendered, so the HTML keeps the canonical fallback
 * order and stays cacheable. This module runs only in the browser: it reads one
 * session seed, derives the same shuffled visible-demo order for the homepage
 * carousel and the catalog, and reorders the existing DOM nodes before each
 * surface binds its controls.
 *
 * The shuffle is Fisher-Yates driven by mulberry32. It never uses a
 * random-comparator sort, and it never adds or removes demos.
 *
 * One-week pin: while PINNED_DEMOS_UNTIL is in the future, the pinned demos
 * move to the front of the shuffled order on both surfaces. The pin is
 * date-driven, so it expires on its own with no code change.
 */

export const DEMO_ORDER_STORAGE_KEY = "webao.demo-order.seed.v1";

/**
 * One-week showcase pin: the two new moving demos lead both surfaces until
 * 2026-11-16 00:00 EST, then the pin expires on its own and every demo
 * shuffles with the rest. No second deploy or code change resets it: the
 * client shuffle checks the visitor's clock, and the static fallback checks
 * the build date, so any build after the expiry renders the unpinned order.
 */
export const PINNED_DEMO_IDS: readonly string[] = ["boreal", "rive-nord"];
export const PINNED_DEMOS_UNTIL = "2026-11-16T05:00:00Z";

export function isDemoPinActive(now: Date = new Date()): boolean {
  return now.getTime() < Date.parse(PINNED_DEMOS_UNTIL);
}

/**
 * Rank for the prerendered carousel fallback. While the pin is active the
 * moving demos lead, then the standing pins, with nora last. After the
 * expiry the standing order returns.
 */
export function demoFallbackRank(id: string, now: Date = new Date()): number {
  if (isDemoPinActive(now)) {
    if (id === "boreal") return 0;
    if (id === "rive-nord") return 1;
    if (id === "noctua") return 2;
    if (id === "lisiere") return 3;
    if (id === "studio-reve") return 4;
    if (id === "nora") return 99;
    return 50;
  }
  return id === "noctua" ? 0 : id === "lisiere" ? 1 : id === "studio-reve" ? 2 : id === "nora" ? 99 : 50;
}

/**
 * Display order for the prerendered catalog fallback and its ItemList:
 * pinned demos first while the pin is active, otherwise canonical order.
 * The input is untouched.
 */
export function sortCatalogForFallback<T extends { id: string }>(demos: readonly T[], now: Date = new Date()): T[] {
  if (!isDemoPinActive(now)) return demos.slice();
  const pinned = PINNED_DEMO_IDS.map((id) => demos.find((d) => d.id === id)).filter(
    (d): d is T => d !== undefined,
  );
  const rest = demos.filter((d) => !PINNED_DEMO_IDS.includes(d.id));
  return [...pinned, ...rest];
}

/** Window-level fallback so blocked storage still shares one seed per load. */
const WINDOW_SEED_KEY = "__webaoDemoOrderSeed";

type SeedWindow = Window & { [WINDOW_SEED_KEY]?: number };

/** Mulberry32: small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unbiased Fisher-Yates shuffle. Returns a new array; the input is untouched. */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const shuffled = items.slice();
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled;
}

/** Fresh unsigned 32-bit seed. Math.random is enough; this is not security. */
export function randomDemoSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/** Accept only canonical unsigned 32-bit decimal strings. */
export function parseDemoSeed(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

/**
 * Read or create the session seed. Storage failures are silent: the caller
 * still gets a usable seed, but it is not persisted across full page loads.
 */
export function readOrCreateDemoSeed(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  generate: () => number = randomDemoSeed,
): number {
  if (storage) {
    try {
      const existing = parseDemoSeed(storage.getItem(DEMO_ORDER_STORAGE_KEY));
      if (existing !== null) return existing;
    } catch {
      // Storage can throw on access, not only on read/write.
    }
  }

  const seed = generate() >>> 0;
  if (storage) {
    try {
      storage.setItem(DEMO_ORDER_STORAGE_KEY, String(seed));
    } catch {
      // Blocked storage: keep the in-memory seed for this load.
    }
  }
  return seed;
}

/**
 * One seed per browser window/load. sessionStorage keeps it across reloads and
 * locale switches; the window property keeps it shared across Astro
 * ClientRouter navigations even when sessionStorage is blocked.
 */
export function getDemoOrderSeed(win: Window | null = typeof window === "undefined" ? null : window): number {
  if (!win) return readOrCreateDemoSeed(null);
  const w = win as SeedWindow;
  const cached = w[WINDOW_SEED_KEY];
  if (typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0 && cached <= 0xffffffff) {
    return cached >>> 0;
  }

  let storage: Storage | null = null;
  try {
    storage = win.sessionStorage;
  } catch {
    storage = null;
  }

  const seed = readOrCreateDemoSeed(storage);
  try {
    w[WINDOW_SEED_KEY] = seed;
  } catch {
    // Some environments freeze window; the local seed still works.
  }
  return seed;
}

/**
 * Reorder existing demo nodes from their canonical catalog index. The index is
 * rendered by the server, so both surfaces shuffle the identical visible list
 * even though the carousel's no-JS fallback has a different pinned order.
 */
export function reorderDemoNodes<T extends HTMLElement>(
  container: HTMLElement,
  selector: string,
  seed: number,
): T[] {
  const nodes = Array.from(container.querySelectorAll<T>(selector));
  const canonical: T[] = [];
  for (const node of nodes) {
    const index = Number(node.dataset.demoIndex);
    if (Number.isInteger(index) && index >= 0) canonical[index] = node;
  }
  // The server renders a dense 0..n-1 index. Fall back to DOM order only if a
  // future caller omits indices, rather than dropping nodes.
  const input = canonical.filter(Boolean) as T[];
  const orderedInput = input.length === nodes.length ? input : nodes;
  const shuffled = shuffleWithSeed(orderedInput, seed);
  const fragment = container.ownerDocument.createDocumentFragment();
  for (const node of shuffled) fragment.appendChild(node);
  container.appendChild(fragment);
  return shuffled;
}

/**
 * Move the pinned demos to the front, in pin order, keeping the shuffled
 * order of the rest. Returns the input untouched once the pin expires.
 */
export function pinDemosFirst<T extends HTMLElement>(nodes: readonly T[], now: Date = new Date()): T[] {
  if (!isDemoPinActive(now)) return nodes as T[];
  const byId = new Map(nodes.map((node) => [node.dataset.demoId, node]));
  const pinned = PINNED_DEMO_IDS.map((id) => byId.get(id)).filter((node): node is T => node !== undefined);
  const rest = nodes.filter((node) => !PINNED_DEMO_IDS.includes(node.dataset.demoId ?? ""));
  return [...pinned, ...rest];
}

/** Carousel: reorder panels, then refresh every position-derived label. */
export function applyDemoOrderToCarousel(track: HTMLElement, seed: number, now: Date = new Date()): HTMLElement[] {
  const panels = reorderDemoNodes<HTMLElement>(track, "[data-proof-panel]", seed);
  const ordered = pinDemosFirst(panels, now);
  if (ordered !== panels) {
    const fragment = track.ownerDocument.createDocumentFragment();
    for (const panel of ordered) fragment.appendChild(panel);
    track.appendChild(fragment);
  }
  ordered.forEach((panel, i) => {
    const index = panel.querySelector(".proof-index");
    if (index) index.textContent = String(i + 1).padStart(2, "0");
    const img = panel.querySelector("img");
    if (img) {
      img.loading = i < 2 ? "eager" : "lazy";
      if (i === 0) img.setAttribute("fetchpriority", "high");
      else img.removeAttribute("fetchpriority");
    }
    // The fracture motif belongs between panels, never before the first one.
    const fracture = panel.querySelector(".proof-fracture");
    if (i === 0) {
      if (fracture) fracture.remove();
    } else if (!fracture) {
      const span = panel.ownerDocument.createElement("span");
      span.className = "proof-fracture";
      span.setAttribute("aria-hidden", "true");
      panel.insertBefore(span, panel.firstChild);
    }
    panel.classList.remove("is-active");
  });
  track.scrollLeft = 0;
  return ordered;
}

/** Catalog: reorder cards, then recompute reveal stagger from the new slot. */
export function applyDemoOrderToCatalog(grid: HTMLElement, seed: number, now: Date = new Date()): HTMLElement[] {
  const cards = reorderDemoNodes<HTMLElement>(grid, "[data-category]", seed);
  const ordered = pinDemosFirst(cards, now);
  if (ordered !== cards) {
    const fragment = grid.ownerDocument.createDocumentFragment();
    for (const card of ordered) fragment.appendChild(card);
    grid.appendChild(fragment);
  }
  ordered.forEach((card, i) => {
    card.style.setProperty("--d", `${(i % 3) * 80}ms`);
  });
  return ordered;
}
