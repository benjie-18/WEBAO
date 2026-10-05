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
  | "Landscaping"
  | "Technology"
  | "Fashion"
  | "Music"
  | "Finance"
  | "Gaming"
  | "Design"
  | "Beauty";

// Trade filter for the demo catalog: a finer-grained business trade than the
// broad DemoCategory. Only set on demos that represent a specific trade;
// the catalog derives its trade filter chips from demos that have one.
export type DemoTrade = "plumbing" | "electrical" | "roofing" | "renovation";

export type Demo = {
  id: string; // slug, used for future microsite routing e.g. /demos/nora
  name: string;
  category: DemoCategory;
  trade?: DemoTrade;
  city: string;
  tone: string; // design direction
  palette: string;
  accent: string;
  description: string;
  pages?: string[]; // sub-pages for the fictional site
};

export const demos: Demo[] = [
  {
    id: "brume",
    name: "Brume Parfums",
    category: "Beauty",
    city: "Grasse",
    tone: "Ethereal",
    palette: "Mist / Lavender",
    accent: "#B9A8D9",
    description: "Fragrance house. Perfume like weather.",
    pages: ["Home", "Collection", "Notes", "Rituals", "Contact"],
  },
  {
    id: "sahara-sage",
    name: "Sahara & Sage",
    category: "Retail",
    city: "Montréal",
    tone: "Bohemian",
    palette: "Terracotta / Sage",
    accent: "#C67B5C",
    description: "Bohemian home goods. Woven, thrown, knotted.",
    pages: ["Home", "Collection", "Artisans", "Lookbook", "Contact"],
  },
  {
    id: "esquisse",
    name: "Esquisse",
    category: "Design",
    city: "Montréal",
    tone: "Conceptual sketch",
    palette: "Paper / Graphite",
    accent: "#8A6D3B",
    description: "Architecture concept studio. Napkin to blueprint.",
    pages: ["Home", "Sketches", "Process", "Journal", "Contact"],
  },
  {
    id: "tactile",
    name: "Tactile",
    category: "Technology",
    city: "Portland",
    tone: "Neumorphism",
    palette: "Lavender gray",
    accent: "#8FA8C8",
    description: "Smart home controls. Soft UI you can feel.",
    pages: ["Home", "Controls", "Rooms", "Kits", "Contact"],
  },
  {
    id: "prism",
    name: "Prism",
    category: "Finance",
    city: "Toronto",
    tone: "Glassmorphism",
    palette: "Violet / Cyan",
    accent: "#7C3AED",
    description: "Modern banking app. Money, in frosted glass.",
    pages: ["Home", "Features", "Pricing", "Reviews", "Download"],
  },
  {
    id: "hexline",
    name: "Hexline Systems",
    category: "Technology",
    city: "Montréal",
    tone: "Cybercore",
    palette: "Black / Cyan / Magenta",
    accent: "#00F0FF",
    description: "Neural interface security. HUD-grade protection.",
    pages: ["Home", "Protocols", "Telemetry", "Access", "Uplink"],
  },
  {
    id: "papier-ciseaux",
    name: "Papier Ciseaux",
    category: "Retail",
    city: "Québec",
    tone: "Scrapbook",
    palette: "Cream / Kraft / Red",
    accent: "#C8452C",
    description: "Artisan stationery: journals, washi, pens.",
    pages: ["Home", "Collection", "Craft", "Workshops", "Contact"],
  },
  {
    id: "finition-r",
    name: "Finition R",
    category: "Trades",
    city: "Montréal",
    tone: "Swiss design",
    palette: "Concrete / Safety Orange",
    accent: "#FF6B00",
    description: "Rénovation & finition, devis rapide.",
    trade: "renovation",
    pages: ["Home", "Services", "Projects", "Process", "Contact"],
  },
  {
    id: "studio-reve",
    name: "Studio Rêve",
    category: "Creative",
    city: "Montréal",
    tone: "Surrealism",
    palette: "Indigo / Gold",
    accent: "#E8B84B",
    description: "Surreal brand experiences. Dreams you can walk through.",
    pages: ["Home", "Dreams", "Manifesto", "Process", "Contact"],
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
    id: "cyberdoll",
    name: "CYBERDOLL",
    category: "Fashion",
    city: "Montréal",
    tone: "Y2K",
    palette: "Pink / Chrome",
    accent: "#FF6EC7",
    description: "Y2K fashion label. Glitter is a neutral.",
    pages: ["Home", "Drops", "Lookbook", "Manifesto", "Contact"],
  },
  {
    id: "aeris",
    name: "AERIS",
    category: "Technology",
    city: "Montréal",
    tone: "Frutiger Aero",
    palette: "Aqua / Green",
    accent: "#4FC3F7",
    description: "Clean-tech company. Dewy optimism, engineered.",
    pages: ["Home", "Technology", "Products", "Impact", "Contact"],
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
    id: "pixelforge",
    name: "Pixelforge Games",
    category: "Gaming",
    city: "Montréal",
    tone: "Pixel art",
    palette: "Navy / Neon",
    accent: "#7CFF6B",
    description: "Indie game studio. 8-bit worlds, modern hearts.",
    pages: ["Home", "Games", "High scores", "Devlog", "Contact"],
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
    id: "toit-fils",
    name: "Toit & Fils",
    category: "Trades",
    city: "Québec",
    tone: "Heritage craft",
    palette: "Oxide / Paper",
    accent: "#9A3412",
    description: "Couvreurs, membrane & tôle, travail garanti.",
    trade: "roofing",
    pages: ["Home", "Services", "Guarantee", "Projects", "Contact"],
  },
  {
    id: "pouf",
    name: "Pouf Studio",
    category: "Creative",
    city: "Montréal",
    tone: "Claymorphism",
    palette: "Pastel / Cream",
    accent: "#FF9D7A",
    description: "3D character & toy design. Soft, squishy, playful.",
    pages: ["Home", "Toys", "Process", "Pricing", "Contact"],
  },
  {
    id: "vhs-dreams",
    name: "VHS Dreams",
    category: "Music",
    city: "Montréal",
    tone: "Synthwave",
    palette: "Purple / Neon pink",
    accent: "#FF2079",
    description: "Synthwave record label. Midnight drives on vinyl.",
    pages: ["Home", "Releases", "Artists", "Merch", "Contact"],
  },
  {
    id: "atelier-caractere",
    name: "Atelier Caractère",
    category: "Design",
    city: "Montréal",
    tone: "Luxury typography",
    palette: "Ivory / Gold",
    accent: "#C6A15B",
    description: "High-end type foundry. Letters with posture.",
    pages: ["Home", "Collection", "In use", "Licensing", "Contact"],
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
    trade: "plumbing",
    pages: ["Home", "Services", "Emergency", "Reviews", "Contact"],
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
    id: "maximal",
    name: "MAXIMAL",
    category: "Creative",
    city: "Montréal",
    tone: "Maximalism",
    palette: "Acid / Everything",
    accent: "#FF2EA6",
    description: "Maximalist creative collective. No beige allowed.",
    pages: ["Home", "Services", "Work", "Manifesto", "Contact"],
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
    id: "lattice",
    name: "Lattice",
    category: "Technology",
    city: "Toronto",
    tone: "Bento grid",
    palette: "Off-white / Lime",
    accent: "#D4FF3F",
    description: "Modular productivity SaaS. Everything in its box.",
    pages: ["Home", "Modules", "Workflows", "Pricing", "Contact"],
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
    id: "nora",
    name: "Nora Électrique",
    category: "Trades",
    city: "Laval",
    tone: "Clean contemporary",
    palette: "Ink / Paper / Vermillion",
    accent: "#FF3B30",
    description: "Emergency residential + commercial, 24h dispatch.",
    trade: "electrical",
    pages: ["Home", "Services", "About", "Service Area", "Contact"],
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
  "Technology",
  "Fashion",
  "Music",
  "Finance",
  "Gaming",
  "Design",
  "Beauty",
] as const;

// Style families: broad, plain-language groups for the style filter.
// Each visible demo belongs to exactly one family.
export type StyleFamily = "timeless" | "elegant" | "bold" | "playful" | "soft";

export const styleFamilies: StyleFamily[] = ["timeless", "elegant", "bold", "playful", "soft"];

export const demoFamily: Record<string, StyleFamily> = {
  // Timeless: clean, professional, never looks dated
  "finition-r": "timeless",
  kanso: "timeless",
  nora: "timeless",
  mira: "timeless",
  "toit-fils": "timeless",
  boise: "timeless",
  sora: "timeless",
  // Elegant: refined, premium, luxurious
  forma: "elegant",
  "atelier-caractere": "elegant",
  "atelier-nord": "elegant",
  "maison-lune": "elegant",
  leduc: "elegant",
  prism: "elegant",
  // Bold: striking, unconventional, impossible to ignore
  "encre-brute": "bold",
  maximal: "bold",
  lune: "bold",
  hexline: "bold",
  "studio-reve": "bold",
  lattice: "bold",
  // Playful: fun, creative, full of personality
  cyberdoll: "playful",
  "boba-club": "playful",
  pixelforge: "playful",
  "vhs-dreams": "playful",
  "papier-ciseaux": "playful",
  pouf: "playful",
  verte: "playful",
  aeris: "playful",
  // Soft: gentle, calm, organic
  brume: "soft",
  "sahara-sage": "soft",
  esquisse: "soft",
  tactile: "soft",
};

export function getDemoFamily(id: string): StyleFamily {
  return demoFamily[id] ?? "timeless";
}

export function searchDemos(query: string, category: string = "All") {
  const q = query.trim().toLowerCase();
  return demos.filter((d) => {
    const matchCat = category === "All" || d.category === category;
    const hay = `${d.name} ${d.category} ${d.city} ${d.tone} ${d.palette} ${d.description}`.toLowerCase();
    const matchQ = !q || hay.includes(q);
    return matchCat && matchQ;
  });
}

// Trade filters for the catalog: only trades with at least one demo get a chip.
// Enables trade-specific landing views like /demos?trade=plumbing.
export const tradeFilters: DemoTrade[] = ["plumbing", "electrical", "roofing", "renovation"];
