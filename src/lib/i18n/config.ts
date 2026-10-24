export const locales = ["en", "fr"] as const;
export type Locale = typeof locales[number];
export const defaultLocale: Locale = "en";

export type PageKey = "home" | "pricing" | "contact" | "demos" | "notfound" | "start" | "terms" | "refunds" | "sources" | "support" | "privacy" | "portal" | "serviceDesign" | "servicePlans" | "serviceHosting" | "serviceMontreal" | "guideCost" | "guideBill96" | "guideLaw25";

export const localizedPaths: Record<Locale, Record<PageKey, string>> = {
  en: {
    home: "/",
    pricing: "/pricing",
    contact: "/contact",
    demos: "/demos",
    notfound: "/404",
    start: "/start",
    terms: "/terms",
    privacy: "/privacy",
    refunds: "/refunds",
    sources: "/sources",
    support: "/support",
    portal: "/portal",
    serviceDesign: "/services/small-business-website-design",
    servicePlans: "/services/monthly-website-plans",
    serviceHosting: "/services/website-hosting-maintenance",
    serviceMontreal: "/services/montreal-web-design",
    guideCost: "/guides/website-cost-canada",
    guideBill96: "/guides/quebec-bill-96-website",
    guideLaw25: "/guides/quebec-law-25-website",
  },
  fr: {
    home: "/fr",
    pricing: "/fr/tarifs",
    contact: "/fr/contact",
    demos: "/fr/demos",
    notfound: "/fr/404",
    start: "/fr/commencer",
    terms: "/fr/conditions",
    privacy: "/fr/confidentialite",
    refunds: "/fr/remboursements",
    sources: "/fr/sources",
    support: "/fr/soutien",
    portal: "/fr/portail",
    serviceDesign: "/fr/services/conception-site-web-pme",
    servicePlans: "/fr/services/forfaits-mensuels-site-web",
    serviceHosting: "/fr/services/hebergement-entretien-site-web",
    serviceMontreal: "/fr/services/conception-site-web-montreal",
    guideCost: "/fr/guides/cout-site-web-canada",
    guideBill96: "/fr/guides/loi-96-site-web-quebec",
    guideLaw25: "/fr/guides/loi-25-site-web-quebec",
  },
};

// Reverse map for lookup: path -> pageKey + locale
export function getPageKeyFromPath(pathname: string): { locale: Locale; pageKey: PageKey | null } {
  const clean = pathname.replace(/\/$/, "") || "/";
  // Exact matches first
  for (const locale of locales) {
    for (const [key, p] of Object.entries(localizedPaths[locale]) as [PageKey, string][]) {
      const normalized = p.replace(/\/$/, "") || "/";
      if (clean === normalized) {
        return { locale, pageKey: key };
      }
      // also allow /fr/ as home
      if (locale === "fr" && (clean === "/fr" || clean === "/fr/")) {
        return { locale: "fr", pageKey: "home" };
      }
    }
  }
  // Prefix detection
  if (clean.startsWith("/fr")) {
    // if /fr/tarifs -> pricing
    for (const [key, p] of Object.entries(localizedPaths.fr) as [PageKey, string][]) {
      if (clean === p.replace(/\/$/, "") || clean === p) return { locale: "fr", pageKey: key };
    }
    // fallback: if starts with /fr, treat as french
    return { locale: "fr", pageKey: null };
  }
  return { locale: "en", pageKey: null };
}

export function getLocaleFromUrl(url: URL | string): Locale {
  // Accept a URL object, a pathname ("/fr/tarifs") or a full URL string
  // ("https://webao.ca/fr/tarifs") — the string form used to be treated as a
  // pathname, so a full URL silently answered "en".
  let pathname: string;
  if (typeof url === "string") {
    try {
      pathname = new URL(url, "https://webao.ca").pathname;
    } catch {
      pathname = url;
    }
  } else {
    pathname = url.pathname;
  }
  const { locale } = getPageKeyFromPath(pathname);
  return locale;
}

export function getLocalizedPath(pageKey: PageKey, locale: Locale): string {
  return localizedPaths[locale][pageKey];
}

export function getAlternatePath(currentPath: string, targetLocale: Locale): string {
  const { pageKey, locale: currentLocale } = getPageKeyFromPath(currentPath);
  if (pageKey) {
    return getLocalizedPath(pageKey, targetLocale);
  }
  // If unknown page (e.g., /demos? or subpath), try prefix logic
  const clean = currentPath.replace(/\/$/, "");
  if (targetLocale === "fr") {
    if (currentLocale === "en") {
      // /pricing -> /fr/tarifs if known, else /fr + path
      if (clean === "" || clean === "/") return "/fr";
      return `/fr${clean}`;
    }
    return currentPath; // already fr
  } else {
    // target en
    if (currentLocale === "fr") {
      if (clean === "/fr" || clean === "/fr/") return "/";
      // strip /fr prefix, then map if known
      const stripped = clean.replace(/^\/fr/, "") || "/";
      // check if stripped matches a fr localized path
      for (const [key, frPath] of Object.entries(localizedPaths.fr) as [PageKey, string][]) {
        if (clean === frPath || clean === frPath.replace(/\/$/, "")) {
          return localizedPaths.en[key];
        }
      }
      return stripped || "/";
    }
    return currentPath;
  }
}

export function getAlternateUrls(currentPath: string, site: string): Record<Locale, string> {
  const base = site.replace(/\/$/, "");
  const result = {} as Record<Locale, string>;
  for (const locale of locales) {
    const altPath = getAlternatePath(currentPath, locale);
    // The site serves directory-style URLs with a trailing slash
    // (e.g. /pricing/); hreflang must match the canonical form exactly.
    const slashPath = altPath === "/" ? "/" : altPath.replace(/\/$/, "") + "/";
    result[locale] = `${base}${slashPath}`;
  }
  return result;
}
