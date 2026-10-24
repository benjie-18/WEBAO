// Abandoned checkout recovery.
//
// When a Stripe checkout session expires unpaid (checkout.session.expired),
// the webhook stores the would-be buyer here via storeAbandonedCheckout.
// The daily automation then calls POST /api/internal/abandoned-followups,
// which sends exactly one follow-up email per record, in the buyer's
// language, once the checkout is at least about half a day old. A record
// whose email has since become a client is marked "converted" instead, and
// records older than two weeks go "stale" unemailed. Storage mirrors the
// clients pattern: records at abandoned:<sessionId>, a newest-first
// abandoned:index capped at 500.

import { getJson, putJson } from "./kv";
import { batch, err, json, timingSafeEqual } from "./util";
import { findClientByEmail } from "./clients";
import { sendClientEmail } from "./mailer";

export interface AbandonedCheckout {
  sessionId: string;
  email: string;
  name?: string;
  /** Cart keys from the session metadata (see checkout.ts PRICE_MAP). */
  items: string[];
  /** Stripe amount_total in cents, when the session carried one. */
  amountTotal?: number;
  currency?: string;
  lang: string;
  createdAt: number;
  status: "pending" | "emailed" | "converted" | "stale";
  emailedAt?: number;
}

const INDEX = "abandoned:index";
const MAX_INDEX = 500;
const MIN_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const keyOf = (sessionId: string): string => "abandoned:" + sessionId;

/** Store a newly expired checkout (first write wins on redelivery). */
export async function storeAbandonedCheckout(
  kv: KVNamespace,
  rec: AbandonedCheckout,
): Promise<void> {
  if (!rec.sessionId || !rec.email) return;
  const key = keyOf(rec.sessionId);
  if ((await getJson<AbandonedCheckout>(kv, key)) !== null) return;
  await putJson(kv, key, rec);
  const index = (await getJson<string[]>(kv, INDEX)) || [];
  index.unshift(key);
  if (index.length > MAX_INDEX) index.splice(MAX_INDEX);
  await putJson(kv, INDEX, index);
}

/** Newest abandoned checkouts first (admin warm-lead list + follow-ups). */
export async function listAbandoned(
  kv: KVNamespace,
  limit: number = 50,
): Promise<AbandonedCheckout[]> {
  const index = (await getJson<string[]>(kv, INDEX)) || [];
  const records = await batch(index.slice(0, limit), 25, (k) =>
    getJson<AbandonedCheckout>(kv, k),
  );
  return records.filter((r): r is AbandonedCheckout => !!r);
}

function followupEmail(rec: AbandonedCheckout): { subject: string; text: string } {
  const fr = rec.lang === "fr";
  const link = fr ? "https://webao.ca/fr/tarifs" : "https://webao.ca/pricing";
  if (fr) {
    return {
      subject: "Votre commande WEBAO est toujours ouverte",
      text: [
        "Bonjour,",
        "",
        "Vous avez commencé une commande WEBAO récemment, mais le paiement n'a pas été complété avant la fin de la session. Rien n'a été débité et aucun compte n'a été créé.",
        "",
        "Si vous voulez toujours aller de l'avant, vous pouvez reprendre exactement où vous étiez rendu :",
        "",
        link,
        "",
        "Des questions ou un doute ? Répondez simplement à ce courriel, une personne lit chaque réponse.",
        "",
        "Si vous vous êtes inscrit autrement, ou si vous avez changé d'idée, ignorez ce message : nous ne réécrirons pas à ce sujet.",
        "",
        "L'équipe Webao",
      ].join("\n"),
    };
  }
  return {
    subject: "Your WEBAO checkout is still open",
    text: [
      "Hi,",
      "",
      "You started a WEBAO checkout recently, but the payment was not completed before the session closed. Nothing was charged and no account was created.",
      "",
      "If you would still like to go ahead, you can pick up right where you left off:",
      "",
      link,
      "",
      "Questions, or second thoughts? Just reply to this email, a person reads every reply.",
      "",
      "If you already signed up another way, or you changed your mind, ignore this message and we will not write again about it.",
      "",
      "The Webao team",
    ].join("\n"),
  };
}

/**
 * POST /api/internal/abandoned-followups — Bearer INTERNAL_CRON_SECRET.
 * One pass over the pending records; idempotent by record status, so a
 * repeated call never emails the same person twice.
 */
export async function handleAbandonedFollowups(req: Request, env: Env): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Follow-ups are not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }
  const kv = env.WEBAO_KV;
  const now = Date.now();
  const records = await listAbandoned(kv, MAX_INDEX);
  let emailed = 0;
  let converted = 0;
  let stale = 0;
  let pending = 0;
  for (const rec of records) {
    if (rec.status !== "pending") continue;
    const age = now - rec.createdAt;
    if (age > MAX_AGE_MS) {
      rec.status = "stale";
      await putJson(kv, keyOf(rec.sessionId), rec);
      stale++;
      continue;
    }
    if (age < MIN_AGE_MS) {
      pending++;
      continue;
    }
    if (await findClientByEmail(kv, rec.email)) {
      rec.status = "converted";
      await putJson(kv, keyOf(rec.sessionId), rec);
      converted++;
      continue;
    }
    const mail = followupEmail(rec);
    const sent = await sendClientEmail(env, {
      to: rec.email,
      subject: mail.subject,
      text: mail.text,
    });
    if (sent) {
      rec.status = "emailed";
      rec.emailedAt = now;
      await putJson(kv, keyOf(rec.sessionId), rec);
      emailed++;
    } else {
      // Mailer not configured yet (or a send failure): leave the record
      // pending so a later run retries, and count it honestly.
      pending++;
    }
  }
  return json({ ok: true, emailed, converted, stale, pending });
}
