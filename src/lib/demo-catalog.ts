/**
 * Catalog filtering shared by the page script and its unit tests.
 *
 * Filtering only toggles visibility on the existing card nodes. It never
 * reorders them, so a shuffled catalog keeps its session order through search,
 * style filters, trade filters, and clear-filters.
 */

export interface DemoCardFilters {
  style: string;
  trade: string;
  query: string;
}

/** Apply the catalog filters in place and return the visible count. */
export function filterDemoCards(cards: readonly HTMLElement[], filters: DemoCardFilters): number {
  let visible = 0;
  const q = filters.query.trim().toLowerCase();
  for (const card of cards) {
    const family = card.getAttribute("data-demo-family") || "";
    const trade = card.getAttribute("data-demo-trade") || "";
    const text = card.getAttribute("data-search") || "";
    const matchStyle = filters.style === "All" || family === filters.style;
    const matchTrade = filters.trade === "All" || trade === filters.trade;
    const matchQuery = !q || text.includes(q);
    const show = matchStyle && matchTrade && matchQuery;
    card.style.display = show ? "" : "none";
    if (show) visible++;
  }
  return visible;
}
