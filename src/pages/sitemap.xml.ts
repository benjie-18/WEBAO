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
    path: "/services/ads-agency-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-canada" },
    ],
  },
  {
    path: "/services/ads-agency-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-montreal" },
    ],
  },
  {
    path: "/services/ads-agency-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-agency-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-agency-quebec" },
    ],
  },
  {
    path: "/services/ai-automation-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-canada" },
    ],
  },
  {
    path: "/services/ai-automation-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-montreal" },
    ],
  },
  {
    path: "/services/ai-automation-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-automation-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-automation-quebec" },
    ],
  },
  {
    path: "/services/meta-ads-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-canada" },
    ],
  },
  {
    path: "/services/meta-ads-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-quebec" },
    ],
  },
  {
    path: "/services/web-design-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-canada" },
    ],
  },
  {
    path: "/services/web-design-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/web-design-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/web-design-quebec" },
    ],
  },
  {
    path: "/services/ai-receptionist-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-canada" },
    ],
  },
  {
    path: "/services/ai-receptionist-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-montreal" },
    ],
  },
  {
    path: "/services/ai-receptionist-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist-quebec" },
    ],
  },
  {
    path: "/services/google-ads-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-canada" },
    ],
  },
  {
    path: "/services/google-ads-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-montreal" },
    ],
  },
  {
    path: "/services/google-ads-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-ads-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-ads-quebec" },
    ],
  },
  {
    path: "/services/meta-ads-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/meta-ads-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/meta-ads-montreal" },
    ],
  },
  {
    path: "/services/online-receptionist-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-canada" },
    ],
  },
  {
    path: "/services/online-receptionist-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-montreal" },
    ],
  },
  {
    path: "/services/online-receptionist-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist-quebec" },
    ],
  },
  {
    path: "/services/local-seo-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-canada" },
    ],
  },
  {
    path: "/services/local-seo-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-montreal" },
    ],
  },
  {
    path: "/services/local-seo-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-quebec" },
    ],
  },
  {
    path: "/services/small-business-websites-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-canada" },
    ],
  },
  {
    path: "/services/smart-follow-up-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-canada" },
    ],
  },
  {
    path: "/services/smart-follow-up-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-montreal" },
    ],
  },
  {
    path: "/services/smart-follow-up-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up-quebec" },
    ],
  },
  {
    path: "/services/website-redesign-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-canada" },
    ],
  },
  {
    path: "/services/website-redesign-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-montreal" },
    ],
  },
  {
    path: "/services/website-redesign-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-redesign-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-redesign-quebec" },
    ],
  },
  {
    path: "/services/b2b-web-services-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-canada" },
    ],
  },
  {
    path: "/services/b2b-web-services-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-montreal" },
    ],
  },
  {
    path: "/services/b2b-web-services-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/b2b-web-services-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/b2b-web-services-quebec" },
    ],
  },
  {
    path: "/services/best-web-design-agency-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-design-agency-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-design-agency-canada" },
    ],
  },
  {
    path: "/services/monthly-website-plans-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-canada" },
    ],
  },
  {
    path: "/services/monthly-website-plans-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-montreal" },
    ],
  },
  {
    path: "/services/monthly-website-plans-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-website-plans-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-website-plans-quebec" },
    ],
  },
  {
    path: "/services/small-business-websites-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-montreal" },
    ],
  },
  {
    path: "/services/small-business-websites-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/small-business-websites-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/small-business-websites-quebec" },
    ],
  },
  {
    path: "/services/affordable-web-design-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/affordable-web-design-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/affordable-web-design-canada" },
    ],
  },
  {
    path: "/services/best-ads-agency-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ads-agency-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ads-agency-quebec" },
    ],
  },
  {
    path: "/services/best-ai-automation-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-ai-automation-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-ai-automation-montreal" },
    ],
  },
  {
    path: "/services/best-b2b-web-agency-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-b2b-web-agency-canada" },
    ],
  },
  {
    path: "/services/best-small-business-website-agency-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-small-business-website-agency-canada" },
    ],
  },
  {
    path: "/services/best-web-agency-quebec",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/best-web-agency-quebec" },
      { hreflang: "x-default", href: "https://webao.ca/services/best-web-agency-quebec" },
    ],
  },
  {
    path: "/services/cheapest-best-web-design-montreal",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
      { hreflang: "x-default", href: "https://webao.ca/services/cheapest-best-web-design-montreal" },
    ],
  },
  {
    path: "/services/fastest-website-delivery-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/fastest-website-delivery-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/fastest-website-delivery-canada" },
    ],
  },
  {
    path: "/services/high-quality-custom-websites-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/high-quality-custom-websites-canada" },
    ],
  },
  {
    path: "/services/tailored-website-design-canada",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/tailored-website-design-canada" },
      { hreflang: "x-default", href: "https://webao.ca/services/tailored-website-design-canada" },
    ],
  },
  {
    path: "/services/grow-plan",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/grow-plan" },
      { hreflang: "x-default", href: "https://webao.ca/services/grow-plan" },
    ],
  },
  {
    path: "/services/growth-bundle",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-bundle" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-bundle" },
    ],
  },
  {
    path: "/services/growth-engine",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/growth-engine" },
      { hreflang: "x-default", href: "https://webao.ca/services/growth-engine" },
    ],
  },
  {
    path: "/services/launch-plan",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/launch-plan" },
      { hreflang: "x-default", href: "https://webao.ca/services/launch-plan" },
    ],
  },
  {
    path: "/services/lead-pack",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/lead-pack" },
      { hreflang: "x-default", href: "https://webao.ca/services/lead-pack" },
    ],
  },
  {
    path: "/services/local-seo-management",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/local-seo-management" },
      { hreflang: "x-default", href: "https://webao.ca/services/local-seo-management" },
    ],
  },
  {
    path: "/services/online-booking",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-booking" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-booking" },
    ],
  },
  {
    path: "/services/review-generation-engine",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/review-generation-engine" },
      { hreflang: "x-default", href: "https://webao.ca/services/review-generation-engine" },
    ],
  },
  {
    path: "/services/scale-plan",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/scale-plan" },
      { hreflang: "x-default", href: "https://webao.ca/services/scale-plan" },
    ],
  },
  {
    path: "/services/visibility-pack",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/visibility-pack" },
      { hreflang: "x-default", href: "https://webao.ca/services/visibility-pack" },
    ],
  },
  {
    path: "/services/advanced-admin-panel",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/advanced-admin-panel" },
      { hreflang: "x-default", href: "https://webao.ca/services/advanced-admin-panel" },
    ],
  },
  {
    path: "/services/diy-blog-page",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/diy-blog-page" },
      { hreflang: "x-default", href: "https://webao.ca/services/diy-blog-page" },
    ],
  },
  {
    path: "/services/ecommerce-lite",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ecommerce-lite" },
      { hreflang: "x-default", href: "https://webao.ca/services/ecommerce-lite" },
    ],
  },
  {
    path: "/services/email-marketing",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/email-marketing" },
      { hreflang: "x-default", href: "https://webao.ca/services/email-marketing" },
    ],
  },
  {
    path: "/services/extra-page",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/extra-page" },
      { hreflang: "x-default", href: "https://webao.ca/services/extra-page" },
    ],
  },
  {
    path: "/services/monthly-growth-report",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/monthly-growth-report" },
      { hreflang: "x-default", href: "https://webao.ca/services/monthly-growth-report" },
    ],
  },
  {
    path: "/services/priority-support",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/priority-support" },
      { hreflang: "x-default", href: "https://webao.ca/services/priority-support" },
    ],
  },
  {
    path: "/services/quote-photo-upload",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/quote-photo-upload" },
      { hreflang: "x-default", href: "https://webao.ca/services/quote-photo-upload" },
    ],
  },
  {
    path: "/services/website-touchup",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/website-touchup" },
      { hreflang: "x-default", href: "https://webao.ca/services/website-touchup" },
    ],
  },
  {
    path: "/services/weekly-seo-blog",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/weekly-seo-blog" },
      { hreflang: "x-default", href: "https://webao.ca/services/weekly-seo-blog" },
    ],
  },
  {
    path: "/services/ads-both-channels",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-both-channels" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-both-channels" },
    ],
  },
  {
    path: "/services/ads-single-channel",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-single-channel" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-single-channel" },
    ],
  },
  {
    path: "/services/ads-starter",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ads-starter" },
      { hreflang: "x-default", href: "https://webao.ca/services/ads-starter" },
    ],
  },
  {
    path: "/services/ai-pack",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-pack" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-pack" },
    ],
  },
  {
    path: "/services/ai-receptionist",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/ai-receptionist" },
      { hreflang: "x-default", href: "https://webao.ca/services/ai-receptionist" },
    ],
  },
  {
    path: "/services/google-business-profile-revamp",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/google-business-profile-revamp" },
      { hreflang: "x-default", href: "https://webao.ca/services/google-business-profile-revamp" },
    ],
  },
  {
    path: "/services/online-receptionist",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/online-receptionist" },
      { hreflang: "x-default", href: "https://webao.ca/services/online-receptionist" },
    ],
  },
  {
    path: "/services/smart-follow-up",
    changefreq: "monthly",
    priority: "0.7",
    alternates: [
      { hreflang: "en", href: "https://webao.ca/services/smart-follow-up" },
      { hreflang: "x-default", href: "https://webao.ca/services/smart-follow-up" },
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
