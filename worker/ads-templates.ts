// Per-trade Meta campaign templates for the Ads Pack.
//
// A template is a starting blueprint, not a finished campaign: business
// name, service area and budget come from the client's ads onboarding, and
// a human reviews the launch packet before anything goes live (the same
// approve-by-exception rule as the website pipeline). Copy follows the
// house rules: no em dashes, short, concrete, EN + FR.

export interface TradeTemplate {
  id: string;
  labelEn: string;
  labelFr: string;
  defaultRadiusKm: number;
  servicesEn: string[];
  servicesFr: string[];
  /** Creative angles; {business} and {area} are filled from onboarding. */
  angles: Array<{ headlineEn: string; headlineFr: string; textEn: string; textFr: string }>;
  formQuestionsEn: string[];
  formQuestionsFr: string[];
}

export const TRADE_IDS = [
  "plumbing",
  "electrical",
  "hvac",
  "painting",
  "renovation",
  "general",
] as const;

export const TRADES: Record<string, TradeTemplate> = {
  plumbing: {
    id: "plumbing",
    labelEn: "Plumbing",
    labelFr: "Plomberie",
    defaultRadiusKm: 25,
    servicesEn: ["Emergency repairs", "Drain cleaning", "Water heaters", "Renovations"],
    servicesFr: ["Réparations d'urgence", "Débouchage", "Chauffe-eau", "Rénovations"],
    angles: [
      {
        headlineEn: "Plumber in {area}, fast and local",
        headlineFr: "Plombier à {area}, rapide et local",
        textEn: "{business} handles repairs, drains and water heaters across {area}. Call today for a clear price before we start.",
        textFr: "{business} s'occupe des réparations, des drains et des chauffe-eau à {area}. Appelez aujourd'hui pour un prix clair avant le début des travaux.",
      },
      {
        headlineEn: "Burst pipe or blocked drain?",
        headlineFr: "Tuyau éclaté ou drain bloqué ?",
        textEn: "Do not let a small leak become a big bill. {business} serves {area} with same-week appointments.",
        textFr: "Ne laissez pas une petite fuite devenir une grosse facture. {business} dessert {area} avec des rendez-vous la même semaine.",
      },
    ],
    formQuestionsEn: ["What do you need help with?", "Where is the property?", "How soon do you need it done?"],
    formQuestionsFr: ["De quoi avez-vous besoin ?", "Où se trouve la propriété ?", "Pour quand en avez-vous besoin ?"],
  },
  electrical: {
    id: "electrical",
    labelEn: "Electrical",
    labelFr: "Électricité",
    defaultRadiusKm: 25,
    servicesEn: ["Panel upgrades", "Lighting", "EV chargers", "Troubleshooting"],
    servicesFr: ["Panneaux électriques", "Éclairage", "Bornes de recharge", "Dépannage"],
    angles: [
      {
        headlineEn: "Licensed electrician in {area}",
        headlineFr: "Électricien licencié à {area}",
        textEn: "{business} does panels, lighting and EV chargers across {area}. Safe work, done to code, priced up front.",
        textFr: "{business} installe panneaux, éclairage et bornes de recharge à {area}. Travail sécuritaire, conforme au code, prix annoncé d'avance.",
      },
      {
        headlineEn: "Panel upgrade or new charger?",
        headlineFr: "Panneau à changer ou borne à installer ?",
        textEn: "Get a proper quote from a local master electrician. {business} serves {area}.",
        textFr: "Obtenez une vraie soumission d'un maître électricien local. {business} dessert {area}.",
      },
    ],
    formQuestionsEn: ["What do you need installed or fixed?", "Where is the property?", "Is this for a home or a business?"],
    formQuestionsFr: ["Qu'avez-vous à installer ou réparer ?", "Où se trouve la propriété ?", "C'est pour une maison ou un commerce ?"],
  },
  hvac: {
    id: "hvac",
    labelEn: "Heating and cooling",
    labelFr: "Chauffage et climatisation",
    defaultRadiusKm: 30,
    servicesEn: ["Furnaces", "Heat pumps", "Air conditioning", "Maintenance plans"],
    servicesFr: ["Fournaises", "Thermopompes", "Climatisation", "Plans d'entretien"],
    angles: [
      {
        headlineEn: "Heating and cooling in {area}",
        headlineFr: "Chauffage et climatisation à {area}",
        textEn: "{business} installs and repairs furnaces, heat pumps and AC across {area}. Ask about current rebates before you book.",
        textFr: "{business} installe et répare fournaises, thermopompes et climatiseurs à {area}. Informez-vous sur les subventions en cours avant de réserver.",
      },
      {
        headlineEn: "No heat, no cool, no waiting",
        headlineFr: "Plus de chauffage, plus d'air frais, pas d'attente",
        textEn: "When the system quits, you need a local team that answers. {business} serves {area}.",
        textFr: "Quand le système lâche, il faut une équipe locale qui répond. {business} dessert {area}.",
      },
    ],
    formQuestionsEn: ["What system do you have?", "Repair or replacement?", "Where is the property?"],
    formQuestionsFr: ["Quel système avez-vous ?", "Réparation ou remplacement ?", "Où se trouve la propriété ?"],
  },
  painting: {
    id: "painting",
    labelEn: "Painting",
    labelFr: "Peinture",
    defaultRadiusKm: 25,
    servicesEn: ["Interior painting", "Exterior painting", "Cabinets", "Drywall repair"],
    servicesFr: ["Peinture intérieure", "Peinture extérieure", "Armoires", "Réparation de gypse"],
    angles: [
      {
        headlineEn: "Painters in {area} who show up on time",
        headlineFr: "Peintres à {area} qui arrivent à l'heure",
        textEn: "{business} paints interiors, exteriors and cabinets across {area}. Clean lines, tidy sites, written quotes.",
        textFr: "{business} peint intérieurs, extérieurs et armoires à {area}. Lignes propres, chantier rangé, soumissions écrites.",
      },
      {
        headlineEn: "Thinking of repainting?",
        headlineFr: "Vous pensez repeindre ?",
        textEn: "A fresh coat changes the whole room. Get a free quote from {business} in {area}.",
        textFr: "Une couche fraîche change toute la pièce. Obtenez une soumission gratuite de {business} à {area}.",
      },
    ],
    formQuestionsEn: ["Interior or exterior?", "How many rooms or what surface?", "Where is the property?"],
    formQuestionsFr: ["Intérieur ou extérieur ?", "Combien de pièces ou quelle surface ?", "Où se trouve la propriété ?"],
  },
  renovation: {
    id: "renovation",
    labelEn: "Renovation",
    labelFr: "Rénovation",
    defaultRadiusKm: 25,
    servicesEn: ["Kitchens", "Bathrooms", "Basements", "Flooring"],
    servicesFr: ["Cuisines", "Salles de bain", "Sous-sols", "Planchers"],
    angles: [
      {
        headlineEn: "Kitchen and bathroom renovations in {area}",
        headlineFr: "Rénovations de cuisine et salle de bain à {area}",
        textEn: "{business} renovates kitchens, bathrooms and basements across {area}. One team from quote to finish.",
        textFr: "{business} rénove cuisines, salles de bain et sous-sols à {area}. Une seule équipe, de la soumission à la finition.",
      },
      {
        headlineEn: "Start your project with a clear quote",
        headlineFr: "Commencez votre projet avec une soumission claire",
        textEn: "No vague allowances, no surprise extras. {business} quotes renovation work in {area} in writing.",
        textFr: "Pas d'allocations floues, pas d'extras surprises. {business} soumissionne vos rénovations à {area} par écrit.",
      },
    ],
    formQuestionsEn: ["What are you renovating?", "What is your rough budget range?", "Where is the property?"],
    formQuestionsFr: ["Qu'est-ce que vous rénovez ?", "Quel est votre budget approximatif ?", "Où se trouve la propriété ?"],
  },
  general: {
    id: "general",
    labelEn: "Home services",
    labelFr: "Services à domicile",
    defaultRadiusKm: 25,
    servicesEn: ["Repairs", "Installations", "Maintenance"],
    servicesFr: ["Réparations", "Installations", "Entretien"],
    angles: [
      {
        headlineEn: "Local pros in {area}",
        headlineFr: "Des pros locaux à {area}",
        textEn: "{business} serves {area} with clear prices and written quotes. Tell us what you need.",
        textFr: "{business} dessert {area} avec des prix clairs et des soumissions écrites. Dites-nous ce qu'il vous faut.",
      },
    ],
    formQuestionsEn: ["What do you need?", "Where are you located?", "How soon do you need it?"],
    formQuestionsFr: ["De quoi avez-vous besoin ?", "Où êtes-vous situé ?", "Pour quand en avez-vous besoin ?"],
  },
};

export function tradeTemplate(trade: string | undefined): TradeTemplate {
  return (trade && TRADES[trade]) || TRADES.general;
}

export function fillTemplate(text: string, business: string, area: string): string {
  return text.replaceAll("{business}", business).replaceAll("{area}", area);
}
