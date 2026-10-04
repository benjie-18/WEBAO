import en from "./en";
import fr from "./fr";
import { locales, defaultLocale, type Locale, type PageKey, getLocaleFromUrl, getAlternatePath, getAlternateUrls, localizedPaths, getPageKeyFromPath } from "./config";

export type { Locale, PageKey };
export { locales, defaultLocale, getLocaleFromUrl, getAlternatePath, getAlternateUrls, localizedPaths, getPageKeyFromPath };

export const translations = {
  en,
  fr,
} as const;

export function useTranslations(locale: Locale) {
  return translations[locale] ?? translations[defaultLocale];
}

export function t(locale: Locale, path: string): string {
  const keys = path.split(".");
  let cur: any = translations[locale] ?? translations[defaultLocale];
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in cur) {
      cur = cur[k];
    } else {
      // fallback to en
      let fallback: any = translations[defaultLocale];
      for (const kk of keys) {
        if (fallback && typeof fallback === "object" && kk in fallback) {
          fallback = fallback[kk];
        } else {
          return path;
        }
      }
      return typeof fallback === "string" ? fallback : path;
    }
  }
  return typeof cur === "string" ? cur : path;
}

// Localized demos
import { demos as baseDemos, type Demo } from "../demos";

type LocalizedDemo = Demo & { localizedDescription: string };

const demoDescriptions: Record<Locale, Record<string, string>> = {
  en: {
    nora: "Emergency residential + commercial, 24h dispatch.",
    mira: "Wood-fired small plates, natural wine, reservations.",
    "atelier-nord": "Diagnostic précis, detailing & performance.",
    "encre-brute": "Tattoo studio. Walk-ins, flash, bold lines.",
    "boba-club": "Bubble tea. Pearls, ice, repeat.",
    kanso: "Tea house. Quiet bowls, slow afternoons.",
    leduc: "Plombiers de père en fils. Dépannage rapide.",
    boise: "Design, entretien, terrassement: du plan au paillis.",
    sora: "Physio & wellness, rendez-vous en ligne.",
    forma: "Architecture intérieure, portfolio éditorial.",
    "toit-fils": "Couvreurs, membrane & tôle, travail garanti.",
    verte: "Vrac, local, zéro déchet, panier en ligne.",
    lune: "Crossfit & coaching, horaires & essais.",
    "maison-lune": "Gîte 4 chambres, bord du lac, réservez direct.",
    "finition-r": "Rénovation & finition, devis rapide.",
  },
  fr: {
    nora: "Urgence résidentielle + commerciale, répartition 24 h.",
    mira: "Petites assiettes au feu de bois, vin nature, réservations.",
    "atelier-nord": "Diagnostic précis, esthétique et performance.",
    "encre-brute": "Studio de tatouage. Sans rendez-vous, flash, lignes franches.",
    "boba-club": "Thé aux perles. Perles, glace, on recommence.",
    kanso: "Maison de thé. Bols calmes, après-midis lents.",
    leduc: "Plombiers de père en fils. Dépannage rapide.",
    boise: "Design, entretien, terrassement : du plan au paillis.",
    sora: "Physio et mieux-être, rendez-vous en ligne.",
    forma: "Architecture intérieure, portfolio éditorial.",
    "toit-fils": "Couvreurs, membrane et tôle, travail garanti.",
    verte: "Vrac, local, zéro déchet, panier en ligne.",
    lune: "Crossfit et coaching, horaires et essais.",
    "maison-lune": "Gîte 4 chambres, bord du lac, réservez direct.",
    "finition-r": "Rénovation et finition, devis rapide.",
  },
};

export function getDemos(locale: Locale): LocalizedDemo[] {
  return baseDemos.map((d) => ({
    ...d,
    localizedDescription: demoDescriptions[locale]?.[d.id] ?? d.description,
  }));
}

export const categoryTranslations: Record<Locale, Record<string, string>> = {
  en: {
    All: "All",
    Trades: "Trades",
    Restaurant: "Restaurant",
    Automotive: "Automotive",
    Health: "Health",
    Creative: "Creative",
    Retail: "Retail",
    Wellness: "Wellness",
    Hospitality: "Hospitality",
    Landscaping: "Landscaping",
  },
  fr: {
    All: "Tous",
    Trades: "Métiers",
    Restaurant: "Restaurant",
    Automotive: "Automobile",
    Health: "Santé",
    Creative: "Créatif",
    Retail: "Commerce",
    Wellness: "Mieux-être",
    Hospitality: "Hébergement",
    Landscaping: "Aménagement",
  },
};
