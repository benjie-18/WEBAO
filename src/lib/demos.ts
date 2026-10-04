// WEBAO Demo Architecture
// Demo = fictional microsite with its own identity. Catalog is filterable/searchable.
// This file is the source of truth for demo metadata; individual demo sites
// will import this and extend with their own routes.

export type DemoCategory =
  | "Trades"
  | "Restaurant"
  | "Automotive"
  | "Health"
  | "Creative"
  | "Retail"
  | "Wellness"
  | "Hospitality"
  | "Landscaping";

export type Demo = {
  id: string; // slug, used for future microsite routing e.g. /demos/nora
  name: string;
  category: DemoCategory;
  city: string;
  tone: string; // design direction
  palette: string;
  accent: string;
  description: string;
  pages?: string[]; // sub-pages for the fictional site
};

export const demos: Demo[] = [
  {
    id: "nora",
    name: "Nora Électrique",
    category: "Trades",
    city: "Laval",
    tone: "Clean contemporary",
    palette: "Ink / Paper / Vermillion",
    accent: "#FF3B30",
    description: "Emergency residential + commercial, 24h dispatch.",
    pages: ["Home", "Services", "About", "Service Area", "Contact"],
  },
  {
    id: "mira",
    name: "Mira Cantine",
    category: "Restaurant",
    city: "Vieux-Montréal",
    tone: "Warm editorial",
    palette: "Cream / Terracotta / Ink",
    accent: "#E3421E",
    description: "Wood-fired small plates, natural wine, reservations.",
    pages: ["Home", "Menu", "Story", "Reservations", "Location"],
  },
  {
    id: "atelier-nord",
    name: "Atelier Nord",
    category: "Automotive",
    city: "Brossard",
    tone: "Premium technical",
    palette: "Navy / Slate / White",
    accent: "#0F172A",
    description: "Diagnostic précis, detailing & performance.",
    pages: ["Home", "Services", "Inventory", "Appointment", "Contact"],
  },
  {
    id: "encre-brute",
    name: "Encre Brute",
    category: "Creative",
    city: "Montréal",
    tone: "Neo-brutalist",
    palette: "Black / White / Signal red",
    accent: "#FF0000",
    description: "Tattoo studio. Walk-ins, flash, bold lines.",
    pages: ["Home", "Artists", "Flash", "Pricing", "Booking"],
  },
  {
    id: "boba-club",
    name: "Boba Club",
    category: "Retail",
    city: "Québec",
    tone: "Y2K chrome",
    palette: "Pastel / Chrome / Gloss",
    accent: "#B78CFF",
    description: "Bubble tea. Pearls, ice, repeat.",
    pages: ["Home", "Flavors", "Build a drink", "Locations", "Contact"],
  },
  {
    id: "kanso",
    name: "Kanso",
    category: "Restaurant",
    city: "Montréal",
    tone: "Japanese minimal",
    palette: "Greige / Ink",
    accent: "#1A1815",
    description: "Tea house. Quiet bowls, slow afternoons.",
    pages: ["Home", "Philosophy", "Tea menu", "Visit"],
  },
  {
    id: "leduc",
    name: "Plomberie Leduc",
    category: "Trades",
    city: "Longueuil",
    tone: "Bold modern",
    palette: "Cobalt / White",
    accent: "#0B5FFF",
    description: "Plombiers de père en fils. Dépannage rapide.",
    pages: ["Home", "Services", "Emergency", "Reviews", "Contact"],
  },
  {
    id: "boise",
    name: "Boisé Paysage",
    category: "Landscaping",
    city: "Gatineau",
    tone: "Calm natural",
    palette: "Sage / Stone / Ink",
    accent: "#6B7F59",
    description: "Design, entretien, terrassement: du plan au paillis.",
    pages: ["Home", "Services", "Realizations", "About", "Quote"],
  },
  {
    id: "sora",
    name: "Clinique Sora",
    category: "Health",
    city: "Brossard",
    tone: "Calm clinical",
    palette: "Mist / Teal / Ink",
    accent: "#0E7A5A",
    description: "Physio & wellness, rendez-vous en ligne.",
    pages: ["Home", "Services", "Team", "Booking", "Contact"],
  },
  {
    id: "forma",
    name: "Studio Forma",
    category: "Creative",
    city: "Montréal",
    tone: "Minimal luxury",
    palette: "Bone / Charcoal",
    accent: "#111111",
    description: "Architecture intérieure, portfolio éditorial.",
    pages: ["Home", "Projects", "Studio", "Services", "Contact"],
  },
  {
    id: "toit-fils",
    name: "Toit & Fils",
    category: "Trades",
    city: "Québec",
    tone: "Heritage craft",
    palette: "Oxide / Paper",
    accent: "#9A3412",
    description: "Couvreurs, membrane & tôle, travail garanti.",
    pages: ["Home", "Services", "Guarantee", "Projects", "Contact"],
  },
  {
    id: "verte",
    name: "Verte Épicerie",
    category: "Retail",
    city: "Sherbrooke",
    tone: "Playful organic",
    palette: "Leaf / Cream",
    accent: "#2E7D32",
    description: "Vrac, local, zéro déchet, panier en ligne.",
    pages: ["Home", "Products", "About", "Panier", "Location"],
  },
  {
    id: "lune",
    name: "Lune Fitness",
    category: "Wellness",
    city: "Trois-Rivières",
    tone: "Energetic bold",
    palette: "Black / Neon",
    accent: "#CCFF00",
    description: "Crossfit & coaching, horaires & essais.",
    pages: ["Home", "Classes", "Coaches", "Schedule", "Trial"],
  },
  {
    id: "maison-lune",
    name: "Maison Lune",
    category: "Hospitality",
    city: "Magog",
    tone: "Soft boutique",
    palette: "Blush / Linen",
    accent: "#E8B4B8",
    description: "Gîte 4 chambres, bord du lac, réservez direct.",
    pages: ["Home", "Rooms", "Experience", "Location", "Book"],
  },
  {
    id: "finition-r",
    name: "Finition R",
    category: "Trades",
    city: "Montréal",
    tone: "Industrial precise",
    palette: "Concrete / Safety Orange",
    accent: "#FF6B00",
    description: "Rénovation & finition, devis rapide.",
    pages: ["Home", "Services", "Projects", "Process", "Contact"],
  },
];

export const demoCategories = [
  "All",
  "Trades",
  "Restaurant",
  "Automotive",
  "Health",
  "Creative",
  "Retail",
  "Wellness",
  "Hospitality",
  "Landscaping",
] as const;

export function searchDemos(query: string, category: string = "All") {
  const q = query.trim().toLowerCase();
  return demos.filter((d) => {
    const matchCat = category === "All" || d.category === category;
    const hay = `${d.name} ${d.category} ${d.city} ${d.tone} ${d.palette} ${d.description}`.toLowerCase();
    const matchQ = !q || hay.includes(q);
    return matchCat && matchQ;
  });
}
