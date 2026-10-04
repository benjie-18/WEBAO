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
    leduc: "Father-and-son plumbers. Fast emergency fixes.",
    boise: "Landscape design and care, from plan to mulch.",
    sora: "Physio and wellness, book online.",
    forma: "Interior architecture, editorial portfolio.",
    "toit-fils": "Roofers, membrane and metal, guaranteed work.",
    verte: "Bulk, local, zero waste, online basket.",
    lune: "Crossfit and coaching, schedule and trial.",
    "maison-lune": "4-room lakeside inn, book direct.",
    "finition-r": "Renovation and finishing, fast quote.",
    pouf: "3D character and toy design. Soft, squishy, playful.",
    hexline: "Neural interface security. HUD-grade protection.",
    "papier-ciseaux": "Artisan stationery: journals, washi, pens.",
    "studio-reve": "Surreal brand experiences. Dreams you can walk through.",
    cyberdoll: "Y2K fashion label. Glitter is a neutral.",
    pixelforge: "Indie game studio. 8-bit worlds, modern hearts.",
    "vhs-dreams": "Synthwave record label. Midnight drives on vinyl.",
    prism: "Modern banking app. Money, in frosted glass.",
    tactile: "Smart home controls. Soft UI you can feel.",
    lattice: "Modular productivity SaaS. Everything in its box.",
    maximal: "Maximalist creative collective. No beige allowed.",
    "atelier-caractere": "High-end type foundry. Letters with posture.",
    esquisse: "Architecture concept studio. Napkin to blueprint.",
    brume: "Fragrance house. Perfume like weather.",
    "sahara-sage": "Bohemian home goods. Woven, thrown, knotted.",
    aeris: "Clean-tech company. Dewy optimism, engineered.",
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
    pouf: "Design de personnages et jouets 3D. Doux, moelleux, ludique.",
    hexline: "Sécurité des interfaces neuronales. Protection niveau HUD.",
    "papier-ciseaux": "Papeterie artisanale : carnets, washi, stylos.",
    "studio-reve": "Expériences de marque surréalistes. Des rêves à traverser.",
    cyberdoll: "Label de mode Y2K. Le glitter est une couleur neutre.",
    pixelforge: "Studio de jeux indépendant. Mondes 8-bit, cœurs modernes.",
    "vhs-dreams": "Label synthwave. Virées de minuit en vinyle.",
    prism: "Application bancaire moderne. L'argent, en verre dépoli.",
    tactile: "Contrôles maison intelligente. Une UI douce au toucher.",
    lattice: "SaaS de productivité modulaire. Tout à sa place.",
    maximal: "Collectif créatif maximaliste. Le beige est interdit.",
    "atelier-caractere": "Fonderie typographique haut de gamme. Des lettres avec du maintien.",
    esquisse: "Studio de concepts d'architecture. De la serviette au plan.",
    brume: "Maison de parfum. Du parfum comme la météo.",
    "sahara-sage": "Articles bohèmes pour la maison. Tissé, tourné, noué.",
    aeris: "Entreprise de technologies propres. Optimisme rosé, ingénierie.",
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
    Technology: "Technology",
    Fashion: "Fashion",
    Music: "Music",
    Finance: "Finance",
    Gaming: "Gaming",
    Design: "Design",
    Beauty: "Beauty",
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
    Technology: "Technologie",
    Fashion: "Mode",
    Music: "Musique",
    Finance: "Finance",
    Gaming: "Jeux",
    Design: "Design",
    Beauty: "Beauté",
  },
};
