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
  // Deliberately untyped traversal (any): a recursive DeepKey type was
  // judged more churn than safety here. The guard is tests/i18n.test.ts,
  // which asserts the en/fr key trees are identical, so en/fr drift
  // fails the suite. It does NOT guard call-site typos: an unknown
  // path still renders the raw path at runtime (see the i18n test's
  // explicit unknown-path case), so a typo'd t() call is a runtime
  // miss, not a suite failure.
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
    debit: "Engineering-grade plumbing. Spec-sheet pricing, test-log proof.",
    "bec-fin": "Bathroom-first plumber. Pastel showroom, diner-style service menu.",
    voltige: "High-voltage electricians. Panels, amperage, zero drama.",
    lueur: "Lighting-design electricians. Warm Scandinavian glow, done right.",
    "21-degres": "Heating & cooling, dialed in. The thermostat is the website.",
    "extreme-climat": "We own both extremes. Cinematic comfort, ice to flame.",
    "confort-76": "Old-school comfort pros. 1970s service with modern systems.",
    zenith: "Roofing from above. Aerial surveys, copper-flashed precision.",
    "toitures-tempete": "Storm-response roofers. When the sky falls, we're already there.",
    "chantier-brut": "General contractors, no varnish. Raw builds, straight talk.",
    "maison-dore": "Luxury renovations. Art-deco glamour, Gatsby-grade finishes.",
    "sneaker-pro": "Sneaker e-commerce. Weekly drops, glass panels, midnight launches.",
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
    debit: "Plomberie d'ingénierie. Tarifs en fiche technique, preuves en journal de test.",
    "bec-fin": "Plombier salle de bain d'abord. Showroom pastel, menu style diner.",
    voltige: "Électriciens haute tension. Panneaux, ampérage, zéro drame.",
    lueur: "Électriciens designers d'éclairage. Douceur scandinave, bien fait.",
    "21-degres": "Chauffage et clim, réglés au quart de tour. Le thermostat, c'est le site.",
    "extreme-climat": "On maîtrise les deux extrêmes. Confort cinématographique, de la glace à la flamme.",
    "confort-76": "Pros du confort à l'ancienne. Service années 70, systèmes modernes.",
    zenith: "Toitures vues du ciel. Relevés aériens, précision cuivrée.",
    "toitures-tempete": "Couvreurs d'intervention tempête. Quand le ciel tombe, on est déjà là.",
    "chantier-brut": "Entrepreneurs généraux, sans vernis. Constructions brutes, franc-parler.",
    "maison-dore": "Rénovations de luxe. Glamour art déco, finitions dignes de Gatsby.",
    "sneaker-pro": "E-commerce de sneakers. Drops de la semaine, panneaux de verre, lancements à minuit.",
  },
};

export function getDemos(locale: Locale): LocalizedDemo[] {
  return baseDemos.map((d) => ({
    ...d,
    localizedDescription: demoDescriptions[locale]?.[d.id] ?? d.description,
  }));
}

