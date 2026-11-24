import type { APIRoute } from "astro";
import { localizedPaths, type Locale } from "../lib/i18n/config";
import { demos } from "../lib/demos";
import { localHeroFor } from "../lib/demo-seo";

// Hidden from the public catalog (matches DemosPage's visibleDemos) —
// excluded from the sitemap too.
const hiddenDemos = new Set(["boba-club"]);

const pagesByLocale: Record<Locale, { key: keyof typeof localizedPaths.en; changefreq: string; priority: string }[]> = {
  en: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
    { key: "audit", changefreq: "monthly", priority: "0.7" },
    { key: "terms", changefreq: "monthly", priority: "0.5" },
    { key: "refunds", changefreq: "yearly", priority: "0.3" },
    { key: "privacy", changefreq: "yearly", priority: "0.3" },
    { key: "support", changefreq: "monthly", priority: "0.5" },
    { key: "serviceDesign", changefreq: "monthly", priority: "0.8" },
    { key: "servicePlans", changefreq: "monthly", priority: "0.8" },
    { key: "serviceHosting", changefreq: "monthly", priority: "0.8" },
    { key: "serviceMontreal", changefreq: "monthly", priority: "0.8" },
    { key: "services", changefreq: "monthly", priority: "0.8" },
    { key: "serviceWebsites", changefreq: "monthly", priority: "0.8" },
    { key: "serviceAds", changefreq: "monthly", priority: "0.8" },
    { key: "serviceAi", changefreq: "monthly", priority: "0.8" },
    { key: "guideCost", changefreq: "monthly", priority: "0.8" },
    { key: "guideBill96", changefreq: "monthly", priority: "0.8" },
    { key: "guideLaw25", changefreq: "monthly", priority: "0.8" },
    { key: "guideIndex", changefreq: "monthly", priority: "0.8" },
    { key: "guideSeo", changefreq: "monthly", priority: "0.8" },
    { key: "guideAdsChannels", changefreq: "monthly", priority: "0.8" },
    { key: "guideAiReceptionist", changefreq: "monthly", priority: "0.8" },
    { key: "guidePrepare", changefreq: "monthly", priority: "0.8" },
    { key: "guideQuoteRequests", changefreq: "monthly", priority: "0.8" },
    { key: "guideRedesign", changefreq: "monthly", priority: "0.8" },
  ],
  fr: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
    { key: "audit", changefreq: "monthly", priority: "0.7" },
    { key: "terms", changefreq: "monthly", priority: "0.5" },
    { key: "refunds", changefreq: "yearly", priority: "0.3" },
    { key: "privacy", changefreq: "yearly", priority: "0.3" },
    { key: "support", changefreq: "monthly", priority: "0.5" },
    { key: "serviceDesign", changefreq: "monthly", priority: "0.8" },
    { key: "servicePlans", changefreq: "monthly", priority: "0.8" },
    { key: "serviceHosting", changefreq: "monthly", priority: "0.8" },
    { key: "serviceMontreal", changefreq: "monthly", priority: "0.8" },
    { key: "services", changefreq: "monthly", priority: "0.8" },
    { key: "serviceWebsites", changefreq: "monthly", priority: "0.8" },
    { key: "serviceAds", changefreq: "monthly", priority: "0.8" },
    { key: "serviceAi", changefreq: "monthly", priority: "0.8" },
    { key: "guideCost", changefreq: "monthly", priority: "0.8" },
    { key: "guideBill96", changefreq: "monthly", priority: "0.8" },
    { key: "guideLaw25", changefreq: "monthly", priority: "0.8" },
    { key: "guideIndex", changefreq: "monthly", priority: "0.8" },
    { key: "guideSeo", changefreq: "monthly", priority: "0.8" },
    { key: "guideAdsChannels", changefreq: "monthly", priority: "0.8" },
    { key: "guideAiReceptionist", changefreq: "monthly", priority: "0.8" },
    { key: "guidePrepare", changefreq: "monthly", priority: "0.8" },
    { key: "guideQuoteRequests", changefreq: "monthly", priority: "0.8" },
    { key: "guideRedesign", changefreq: "monthly", priority: "0.8" },
  ],
};

// Standalone pages not covered by localizedPaths (no PageKey).
const extraPages: { path: string; changefreq: string; priority: string; alternates: { hreflang: string; href: string }[] }[] = [
  {
    path: "/sources",
    changefreq: "monthly",
    priority: "0.3",
    // Mirror the /fr/sources entry: both sides declare the en/fr pair so the
    // alternates are discoverable from either language.
    alternates: [
      { hreflang: "en", href: "https://webao.ca/sources" },
      { hreflang: "fr", href: "https://webao.ca/fr/sources" },
      { hreflang: "x-default", href: "https://webao.ca/sources" },
    ],
  },
  {
    path: "/fr/sources",
    changefreq: "monthly",
    priority: "0.3",
    alternates: [
      { hreflang: "fr", href: "https://webao.ca/fr/sources" },
      { hreflang: "en", href: "https://webao.ca/sources" },
      { hreflang: "x-default", href: "https://webao.ca/sources" },
    ],
  },  {
    path: "/services/web-design-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-canada" },
    ],
  },
  {
    path: "/fr/services/conception-site-web-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-canada" },
    ],
  },
  {
    path: "/services/web-design-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-quebec" },
    ],
  },
  {
    path: "/fr/services/conception-site-web-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-quebec" },
    ],
  },
  {
    path: "/services/ai-automation-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-canada" },
    ],
  },
  {
    path: "/fr/services/automatisation-ia-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-canada" },
    ],
  },
  {
    path: "/services/ai-automation-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-quebec" },
    ],
  },
  {
    path: "/fr/services/automatisation-ia-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-quebec" },
    ],
  },
  {
    path: "/services/ai-automation-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-montreal" },
    ],
  },
  {
    path: "/fr/services/automatisation-ia-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/automatisation-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-montreal" },
    ],
  },
  {
    path: "/services/ads-agency-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-canada" },
    ],
  },
  {
    path: "/fr/services/agence-publicite-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-canada" },
    ],
  },
  {
    path: "/services/ads-agency-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-quebec" },
    ],
  },
  {
    path: "/fr/services/agence-publicite-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-quebec" },
    ],
  },
  {
    path: "/services/ads-agency-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-montreal" },
    ],
  },
  {
    path: "/fr/services/agence-publicite-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/agence-publicite-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-montreal" },
    ],
  },
  {
    path: "/services/meta-ads-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-canada" },
    ],
  },
  {
    path: "/fr/services/publicites-meta-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-canada" },
    ],
  },
  {
    path: "/services/meta-ads-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-quebec" },
    ],
  },
  {
    path: "/fr/services/publicites-meta-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-quebec" },
    ],
  },
  {
    path: "/services/meta-ads-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-montreal" },
    ],
  },
  {
    path: "/fr/services/publicites-meta-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-meta-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-montreal" },
    ],
  },
  {
    path: "/services/google-ads-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-canada" },
    ],
  },
  {
    path: "/fr/services/publicites-google-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-canada" },
    ],
  },
  {
    path: "/services/google-ads-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-quebec" },
    ],
  },
  {
    path: "/fr/services/publicites-google-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-quebec" },
    ],
  },
  {
    path: "/services/google-ads-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-montreal" },
    ],
  },
  {
    path: "/fr/services/publicites-google-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-google-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-montreal" },
    ],
  },
  {
    path: "/services/ai-receptionist-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-canada" },
    ],
  },
  {
    path: "/fr/services/receptionniste-ia-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-canada" },
    ],
  },
  {
    path: "/services/ai-receptionist-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-quebec" },
    ],
  },
  {
    path: "/fr/services/receptionniste-ia-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-quebec" },
    ],
  },
  {
    path: "/services/ai-receptionist-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-montreal" },
    ],
  },
  {
    path: "/fr/services/receptionniste-ia-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-montreal" },
    ],
  },
  {
    path: "/services/online-receptionist-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-canada" },
    ],
  },
  {
    path: "/fr/services/receptionniste-en-ligne-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-canada" },
    ],
  },
  {
    path: "/services/online-receptionist-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-quebec" },
    ],
  },
  {
    path: "/fr/services/receptionniste-en-ligne-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-quebec" },
    ],
  },
  {
    path: "/services/online-receptionist-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-montreal" },
    ],
  },
  {
    path: "/fr/services/receptionniste-en-ligne-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-montreal" },
    ],
  },
  {
    path: "/services/smart-follow-up-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-canada" },
    ],
  },
  {
    path: "/fr/services/suivi-intelligent-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-canada" },
    ],
  },
  {
    path: "/services/smart-follow-up-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-quebec" },
    ],
  },
  {
    path: "/fr/services/suivi-intelligent-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-quebec" },
    ],
  },
  {
    path: "/services/smart-follow-up-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-montreal" },
    ],
  },
  {
    path: "/fr/services/suivi-intelligent-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-montreal" },
    ],
  },
  {
    path: "/services/local-seo-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-canada" },
    ],
  },
  {
    path: "/fr/services/seo-local-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-canada" },
    ],
  },
  {
    path: "/services/local-seo-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-quebec" },
    ],
  },
  {
    path: "/fr/services/seo-local-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-quebec" },
    ],
  },
  {
    path: "/services/local-seo-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-montreal" },
    ],
  },
  {
    path: "/fr/services/seo-local-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/seo-local-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-montreal" },
    ],
  },
  {
    path: "/services/website-redesign-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-canada" },
    ],
  },
  {
    path: "/fr/services/refonte-site-web-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-canada" },
    ],
  },
  {
    path: "/services/website-redesign-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-quebec" },
    ],
  },
  {
    path: "/fr/services/refonte-site-web-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-quebec" },
    ],
  },
  {
    path: "/services/website-redesign-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-montreal" },
    ],
  },
  {
    path: "/fr/services/refonte-site-web-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-site-web-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-montreal" },
    ],
  },
  {
    path: "/services/small-business-websites-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-canada" },
    ],
  },
  {
    path: "/fr/services/sites-web-pme-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-canada" },
    ],
  },
  {
    path: "/services/small-business-websites-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-quebec" },
    ],
  },
  {
    path: "/fr/services/sites-web-pme-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-quebec" },
    ],
  },
  {
    path: "/services/small-business-websites-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-montreal" },
    ],
  },
  {
    path: "/fr/services/sites-web-pme-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-pme-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-montreal" },
    ],
  },
  {
    path: "/services/monthly-website-plans-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-canada" },
    ],
  },
  {
    path: "/fr/services/forfaits-mensuels-site-web-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-canada" },
    ],
  },
  {
    path: "/services/monthly-website-plans-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-quebec" },
    ],
  },
  {
    path: "/fr/services/forfaits-mensuels-site-web-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-quebec" },
    ],
  },
  {
    path: "/services/monthly-website-plans-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-montreal" },
    ],
  },
  {
    path: "/fr/services/forfaits-mensuels-site-web-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfaits-mensuels-site-web-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-montreal" },
    ],
  },
  {
    path: "/services/b2b-web-services-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-canada" },
    ],
  },
  {
    path: "/fr/services/services-web-b2b-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-canada" },
    ],
  },
  {
    path: "/services/b2b-web-services-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-quebec" },
    ],
  },
  {
    path: "/fr/services/services-web-b2b-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-quebec" },
    ],
  },
  {
    path: "/services/b2b-web-services-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-montreal" },
    ],
  },
  {
    path: "/fr/services/services-web-b2b-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/services-web-b2b-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-montreal" },
    ],
  },
  {
    path: "/services/best-web-design-agency-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-design-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-conception-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-design-agency-canada" },
    ],
  },
  {
    path: "/fr/services/meilleure-agence-conception-web-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-design-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-conception-web-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-design-agency-canada" },
    ],
  },
  {
    path: "/services/best-web-agency-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-agency-quebec" },
    ],
  },
  {
    path: "/fr/services/meilleure-agence-web-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-web-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-agency-quebec" },
    ],
  },
  {
    path: "/services/cheapest-best-web-design-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-web-abordable-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
    ],
  },
  {
    path: "/fr/services/conception-web-abordable-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-web-abordable-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
    ],
  },
  {
    path: "/services/best-ai-automation-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ai-automation-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-automatisation-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ai-automation-montreal" },
    ],
  },
  {
    path: "/fr/services/meilleure-automatisation-ia-montreal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ai-automation-montreal" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-automatisation-ia-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ai-automation-montreal" },
    ],
  },
  {
    path: "/services/best-ads-agency-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ads-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-publicite-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ads-agency-quebec" },
    ],
  },
  {
    path: "/fr/services/meilleure-agence-publicite-quebec",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ads-agency-quebec" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-publicite-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ads-agency-quebec" },
    ],
  },
  {
    path: "/services/affordable-web-design-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/affordable-web-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-web-abordable-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/affordable-web-design-canada" },
    ],
  },
  {
    path: "/fr/services/conception-web-abordable-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/affordable-web-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-web-abordable-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/affordable-web-design-canada" },
    ],
  },
  {
    path: "/services/fastest-website-delivery-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/fastest-website-delivery-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/livraison-site-web-rapide-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/fastest-website-delivery-canada" },
    ],
  },
  {
    path: "/fr/services/livraison-site-web-rapide-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/fastest-website-delivery-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/livraison-site-web-rapide-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/fastest-website-delivery-canada" },
    ],
  },
  {
    path: "/services/high-quality-custom-websites-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-sur-mesure-haute-qualite-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
    ],
  },
  {
    path: "/fr/services/sites-web-sur-mesure-haute-qualite-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/sites-web-sur-mesure-haute-qualite-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
    ],
  },
  {
    path: "/services/tailored-website-design-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/tailored-website-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-sur-mesure-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/tailored-website-design-canada" },
    ],
  },
  {
    path: "/fr/services/conception-site-web-sur-mesure-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/tailored-website-design-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/conception-site-web-sur-mesure-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/tailored-website-design-canada" },
    ],
  },
  {
    path: "/services/best-b2b-web-agency-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-web-b2b-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
    ],
  },
  {
    path: "/fr/services/meilleure-agence-web-b2b-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-web-b2b-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
    ],
  },
  {
    path: "/services/best-small-business-website-agency-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-sites-web-pme-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
    ],
  },
  {
    path: "/fr/services/meilleure-agence-sites-web-pme-canada",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/meilleure-agence-sites-web-pme-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
    ],
  },
  {
    path: "/services/launch-plan",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/launch-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-lancement" },
      { hreflang: "x-default", href: "https://webao.ca/services/launch-plan" },
    ],
  },
  {
    path: "/fr/services/forfait-lancement",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/launch-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-lancement" },
      { hreflang: "x-default", href: "https://webao.ca/services/launch-plan" },
    ],
  },
  {
    path: "/services/grow-plan",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/grow-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/grow-plan" },
    ],
  },
  {
    path: "/fr/services/forfait-croissance",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/grow-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/grow-plan" },
    ],
  },
  {
    path: "/services/scale-plan",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/scale-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-echelle" },
      { hreflang: "x-default", href: "https://webao.ca/services/scale-plan" },
    ],
  },
  {
    path: "/fr/services/forfait-echelle",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/scale-plan" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/forfait-echelle" },
      { hreflang: "x-default", href: "https://webao.ca/services/scale-plan" },
    ],
  },
  {
    path: "/services/lead-pack",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/lead-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-leads" },
      { hreflang: "x-default", href: "https://webao.ca/services/lead-pack" },
    ],
  },
  {
    path: "/fr/services/pack-leads",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/lead-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-leads" },
      { hreflang: "x-default", href: "https://webao.ca/services/lead-pack" },
    ],
  },
  {
    path: "/services/visibility-pack",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/visibility-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-visibilite" },
      { hreflang: "x-default", href: "https://webao.ca/services/visibility-pack" },
    ],
  },
  {
    path: "/fr/services/pack-visibilite",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/visibility-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-visibilite" },
      { hreflang: "x-default", href: "https://webao.ca/services/visibility-pack" },
    ],
  },
  {
    path: "/services/growth-bundle",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-bundle" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/ensemble-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-bundle" },
    ],
  },
  {
    path: "/fr/services/ensemble-croissance",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-bundle" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/ensemble-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-bundle" },
    ],
  },
  {
    path: "/services/growth-engine",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-engine" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/moteur-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-engine" },
    ],
  },
  {
    path: "/fr/services/moteur-croissance",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-engine" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/moteur-croissance" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-engine" },
    ],
  },
  {
    path: "/services/local-seo-management",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-management" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/gestion-seo-local" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-management" },
    ],
  },
  {
    path: "/fr/services/gestion-seo-local",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-management" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/gestion-seo-local" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-management" },
    ],
  },
  {
    path: "/services/review-generation-engine",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/review-generation-engine" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/moteur-generation-avis" },
      { hreflang: "x-default", href: "https://webao.ca/services/review-generation-engine" },
    ],
  },
  {
    path: "/fr/services/moteur-generation-avis",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/review-generation-engine" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/moteur-generation-avis" },
      { hreflang: "x-default", href: "https://webao.ca/services/review-generation-engine" },
    ],
  },
  {
    path: "/services/online-booking",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-booking" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/reservation-en-ligne" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-booking" },
    ],
  },
  {
    path: "/fr/services/reservation-en-ligne",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-booking" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/reservation-en-ligne" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-booking" },
    ],
  },
  {
    path: "/services/diy-blog-page",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/diy-blog-page" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/page-blog-bricolage" },
      { hreflang: "x-default", href: "https://webao.ca/services/diy-blog-page" },
    ],
  },
  {
    path: "/fr/services/page-blog-bricolage",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/diy-blog-page" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/page-blog-bricolage" },
      { hreflang: "x-default", href: "https://webao.ca/services/diy-blog-page" },
    ],
  },
  {
    path: "/services/weekly-seo-blog",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/weekly-seo-blog" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/blogue-seo-hebdomadaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/weekly-seo-blog" },
    ],
  },
  {
    path: "/fr/services/blogue-seo-hebdomadaire",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/weekly-seo-blog" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/blogue-seo-hebdomadaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/weekly-seo-blog" },
    ],
  },
  {
    path: "/services/ecommerce-lite",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ecommerce-lite" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/commerce-en-ligne-leger" },
      { hreflang: "x-default", href: "https://webao.ca/services/ecommerce-lite" },
    ],
  },
  {
    path: "/fr/services/commerce-en-ligne-leger",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ecommerce-lite" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/commerce-en-ligne-leger" },
      { hreflang: "x-default", href: "https://webao.ca/services/ecommerce-lite" },
    ],
  },
  {
    path: "/services/email-marketing",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/email-marketing" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/marketing-courriel" },
      { hreflang: "x-default", href: "https://webao.ca/services/email-marketing" },
    ],
  },
  {
    path: "/fr/services/marketing-courriel",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/email-marketing" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/marketing-courriel" },
      { hreflang: "x-default", href: "https://webao.ca/services/email-marketing" },
    ],
  },
  {
    path: "/services/monthly-growth-report",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-growth-report" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/rapport-croissance-mensuel" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-growth-report" },
    ],
  },
  {
    path: "/fr/services/rapport-croissance-mensuel",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-growth-report" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/rapport-croissance-mensuel" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-growth-report" },
    ],
  },
  {
    path: "/services/extra-page",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/extra-page" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/page-supplementaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/extra-page" },
    ],
  },
  {
    path: "/fr/services/page-supplementaire",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/extra-page" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/page-supplementaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/extra-page" },
    ],
  },
  {
    path: "/services/website-touchup",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-touchup" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/retouche-site-web" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-touchup" },
    ],
  },
  {
    path: "/fr/services/retouche-site-web",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-touchup" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/retouche-site-web" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-touchup" },
    ],
  },
  {
    path: "/services/priority-support",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/priority-support" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/soutien-prioritaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/priority-support" },
    ],
  },
  {
    path: "/fr/services/soutien-prioritaire",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/priority-support" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/soutien-prioritaire" },
      { hreflang: "x-default", href: "https://webao.ca/services/priority-support" },
    ],
  },
  {
    path: "/services/advanced-admin-panel",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/advanced-admin-panel" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/panneau-admin-avance" },
      { hreflang: "x-default", href: "https://webao.ca/services/advanced-admin-panel" },
    ],
  },
  {
    path: "/fr/services/panneau-admin-avance",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/advanced-admin-panel" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/panneau-admin-avance" },
      { hreflang: "x-default", href: "https://webao.ca/services/advanced-admin-panel" },
    ],
  },
  {
    path: "/services/quote-photo-upload",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/quote-photo-upload" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/televersement-photo-devis" },
      { hreflang: "x-default", href: "https://webao.ca/services/quote-photo-upload" },
    ],
  },
  {
    path: "/fr/services/televersement-photo-devis",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/quote-photo-upload" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/televersement-photo-devis" },
      { hreflang: "x-default", href: "https://webao.ca/services/quote-photo-upload" },
    ],
  },
  {
    path: "/services/ai-receptionist",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist" },
    ],
  },
  {
    path: "/fr/services/receptionniste-ia",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-ia" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist" },
    ],
  },
  {
    path: "/services/online-receptionist",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist" },
    ],
  },
  {
    path: "/fr/services/receptionniste-en-ligne",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/receptionniste-en-ligne" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist" },
    ],
  },
  {
    path: "/services/smart-follow-up",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up" },
    ],
  },
  {
    path: "/fr/services/suivi-intelligent",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/suivi-intelligent" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up" },
    ],
  },
  {
    path: "/services/ai-pack",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-ia" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-pack" },
    ],
  },
  {
    path: "/fr/services/pack-ia",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-pack" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/pack-ia" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-pack" },
    ],
  },
  {
    path: "/services/ads-starter",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-starter" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/demarrage-publicites" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-starter" },
    ],
  },
  {
    path: "/fr/services/demarrage-publicites",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-starter" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/demarrage-publicites" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-starter" },
    ],
  },
  {
    path: "/services/ads-single-channel",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-single-channel" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-un-canal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-single-channel" },
    ],
  },
  {
    path: "/fr/services/publicites-un-canal",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-single-channel" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-un-canal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-single-channel" },
    ],
  },
  {
    path: "/services/ads-both-channels",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-both-channels" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-deux-canaux" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-both-channels" },
    ],
  },
  {
    path: "/fr/services/publicites-deux-canaux",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-both-channels" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/publicites-deux-canaux" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-both-channels" },
    ],
  },
  {
    path: "/services/google-business-profile-revamp",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-business-profile-revamp" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-profil-google" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-business-profile-revamp" },
    ],
  },
  {
    path: "/fr/services/refonte-profil-google",
    changefreq: "monthly",
    priority: "0.8",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-business-profile-revamp" },
      { hreflang: "fr", href: "https://webao.ca/fr/services/refonte-profil-google" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-business-profile-revamp" },
    ],
  },
];

// Demo names contain characters like "&" that must be escaped in XML text.
const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const GET: APIRoute = () => {
  const site = "https://webao.ca";
  const lastmod = new Date().toISOString().slice(0, 10);
  // Directory-style URLs carry a trailing slash on this site; the sitemap
  // must list the final (post-redirect) URLs.
  const slash = (path: string) => (path === "/" ? `${site}/` : `${site}${path.replace(/\/$/, "")}/`);
  const urls: {
    loc: string;
    changefreq: string;
    priority: string;
    alternates: { hreflang: string; href: string }[];
    images?: { loc: string; title: string }[];
  }[] = [];

  for (const locale of ["en", "fr"] as Locale[]) {
    for (const p of pagesByLocale[locale]) {
      const path = localizedPaths[locale][p.key];
      const loc = slash(path);
      const enPath = localizedPaths.en[p.key];
      const frPath = localizedPaths.fr[p.key];
      urls.push({
        loc,
        changefreq: p.changefreq,
        priority: p.priority,
        alternates: [
          { hreflang: "en", href: slash(enPath) },
          { hreflang: "fr", href: slash(frPath) },
          { hreflang: "x-default", href: slash(enPath) },
        ],
      });
    }
  }

  for (const e of extraPages) {
    urls.push({
      loc: slash(e.path),
      changefreq: e.changefreq,
      priority: e.priority,
      alternates: e.alternates.map((a) => ({ ...a, href: slash(new URL(a.href).pathname) })),
    });
  }

  // Demo detail pages (/demos/<id> + /fr/demos/<id>), one entry per visible demo.
  for (const demo of demos) {
    if (hiddenDemos.has(demo.id)) continue;
    const enPath = `/demos/${demo.id}`;
    const frPath = `/fr/demos/${demo.id}`;
    // Image sitemap entry: the demo's lead image, for image search results.
    const hero = localHeroFor(demo.id);
    const images = hero ? [{ loc: hero, title: demo.name }] : undefined;
    urls.push({
      loc: slash(enPath),
      changefreq: "monthly",
      priority: "0.7",
      alternates: [
        { hreflang: "en", href: slash(enPath) },
        { hreflang: "fr", href: slash(frPath) },
        { hreflang: "x-default", href: slash(enPath) },
      ],
      images,
    });
    urls.push({
      loc: slash(frPath),
      changefreq: "monthly",
      priority: "0.7",
      alternates: [
        { hreflang: "en", href: slash(enPath) },
        { hreflang: "fr", href: slash(frPath) },
        { hreflang: "x-default", href: slash(enPath) },
      ],
      images,
    });
  }

  // Deduplicate by loc
  const seen = new Set<string>();
  const deduped = urls.filter((u) => {
    if (seen.has(u.loc)) return false;
    seen.add(u.loc);
    return true;
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${deduped
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
${u.alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`).join("\n")}
${(u.images ?? []).map((img) => `    <image:image><image:loc>${escapeXml(img.loc)}</image:loc><image:title>${escapeXml(img.title)}</image:title></image:image>`).join("\n")}
    <lastmod>${lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`.trim();

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
