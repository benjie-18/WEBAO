// Demo shortlist (#50): up to 3 demos a visitor can keep and carry into
// /contact and /start. Stored in localStorage as an array of demo slugs;
// unknown slugs (a removed demo) are dropped on read so a stale list
// never shows a dead entry.
import { demos } from "./demos";

export const SHORTLIST_KEY = "webao_shortlist_v1";
export const SHORTLIST_MAX = 3;

const knownIds = new Set(demos.map((d) => d.id));

export function readShortlist(win: Window | null | undefined): string[] {
  if (!win) return [];
  try {
    const raw = win.localStorage.getItem(SHORTLIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of parsed) {
      if (typeof id !== "string" || !knownIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= SHORTLIST_MAX) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function writeShortlist(win: Window | null | undefined, ids: string[]): void {
  if (!win) return;
  try {
    win.localStorage.setItem(SHORTLIST_KEY, JSON.stringify(ids.slice(0, SHORTLIST_MAX)));
  } catch {
    // Storage unavailable (private mode): the in-memory list still works
    // for the current page, it just does not survive navigation.
  }
}

/** Toggle one demo. Returns the new list and whether the demo is now in it. */
export function toggleShortlist(
  win: Window | null | undefined,
  id: string,
): { ids: string[]; added: boolean; full: boolean } {
  const ids = readShortlist(win);
  const at = ids.indexOf(id);
  if (at !== -1) {
    ids.splice(at, 1);
    writeShortlist(win, ids);
    return { ids, added: false, full: false };
  }
  if (ids.length >= SHORTLIST_MAX) return { ids, added: false, full: true };
  ids.push(id);
  writeShortlist(win, ids);
  return { ids, added: true, full: false };
}

export function shortlistNames(ids: string[]): string[] {
  const byId = new Map(demos.map((d) => [d.id, d.name]));
  return ids.map((id) => byId.get(id)).filter((name): name is string => typeof name === "string");
}
