#!/usr/bin/env python3
"""Regenerate the French audit results shell from the English one.

src/pages/fr/audits/index.astro is a French twin of
src/pages/audits/index.astro: same structure and script (the STR dict
already carries both languages), French static strings and locale="fr".
Run this after any change to the EN shell so the two never drift.
Replacements are exact strings; a missing one fails loudly.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EN = ROOT / "src/pages/audits/index.astro"
FR = ROOT / "src/pages/fr/audits/index.astro"

HEADER_EN = """// WEBAO audit result page (shell) — renders one stored audit at /audits/<id>.
// The site is a static build, so there is no per-id prerendered page: the
// worker rewrites /audits/<id> to this shell (see worker/ROUTE-PATCH.txt)
// and the script below loads the audit from GET /api/audit/<id>.
// The audit record carries its lang, so the shell renders in the language
// the audit was run in. Noindex: result URLs are personal, not for search.
// Styled like the pricing page: grain hero, big display score, bordered
// cards, dark band for the report form.
import BaseLayout from "../../layouts/BaseLayout.astro";
import StarMark from "../../components/ui/StarMark.astro";"""

HEADER_FR = """// WEBAO audit result page (shell, FR) — renders one stored audit at
// /fr/audits/<id>. French twin of src/pages/audits/index.astro, same
// structure, French static strings and locale="fr". The worker rewrites
// /fr/audits/<id> to this shell and the script loads the audit from
// GET /api/audit/<id>. The audit record carries its lang, so the content
// renders in the language the audit was run in. Noindex: result URLs are
// personal, not for search. Regenerate from the EN shell when it changes.
import BaseLayout from "../../../layouts/BaseLayout.astro";
import StarMark from "../../../components/ui/StarMark.astro";"""

REPLACEMENTS = [
    (HEADER_EN, HEADER_FR),
    (
        '<BaseLayout title="Your website audit · Webao" description="The result of your free WEBAO website audit." locale="en" noIndex>',
        '<BaseLayout title="Votre audit de site web · Webao" description="Le résultat de votre audit gratuit de site web WEBAO." locale="fr" noIndex>',
    ),
    ("Loading your audit…", "Chargement de votre audit…"),
    (
        '<a href="/audit" data-audit-result-action-link>Run a new audit</a>',
        '<a href="/fr/eval" data-audit-result-action-link>Lancer un nouvel audit</a>',
    ),
    ("Your website audit", "Votre audit de site web"),
    (
        '<a href="/pricing" class="btn btn--primary btn--lg" id="audit-pricing-link">Fix site now</a>',
        '<a href="/fr/tarifs" class="btn btn--primary btn--lg" id="audit-pricing-link">Corriger mon site</a>',
    ),
    ("What works", "Ce qui fonctionne"),
    ("What to fix first", "Quoi corriger en premier"),
    (
        "Our team knows what each reference means and how to fix it.",
        "Notre équipe sait ce que chaque référence veut dire et comment la corriger.",
    ),
    (
        '<a href="/start" class="btn btn--primary" id="audit-fix-start">Get started</a>',
        '<a href="/fr/commencer" class="btn btn--primary" id="audit-fix-start">Commencer</a>',
    ),
    ("Full report", "Rapport complet"),
    ("Want the full report?", "Vous voulez le rapport complet?"),
    (
        "Leave your business email and we will send the complete report, with every finding explained.",
        "Laissez votre courriel professionnel et nous vous enverrons le rapport complet, avec chaque point expliqué.",
    ),
    ("Business email", "Courriel professionnel"),
    ("you@yourbusiness.com", "vous@votreentreprise.com"),
    ("Send me the full report", "Envoyez-moi le rapport complet"),
    (
        '<a href="/audit" id="audit-back-link">Run another audit</a>',
        '<a href="/fr/eval" id="audit-back-link">Lancer un autre audit</a>',
    ),
    (
        "Values displayed in the initial report are only estimates and may not reflect the final results.",
        "Les valeurs affichées dans le rapport initial sont seulement des estimations et peuvent ne pas refléter les résultats finaux.",
    ),
]


def main() -> int:
    text = EN.read_text()
    for old, new in REPLACEMENTS:
        if old not in text:
            print(f"REGEN FAILED: not found in EN shell: {old[:80]!r}", file=sys.stderr)
            return 1
        text = text.replace(old, new, 1)
    FR.write_text(text)
    print(f"Regenerated {FR} from {EN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
