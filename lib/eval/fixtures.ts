import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_LENGTHS } from "../summarizer/types";
import type { NewsletterFixture } from "./summary-grader";

export const NEWSLETTER_FIXTURES_DIR = join(process.cwd(), "fixtures", "newsletters");

/** Loads every fixture and checks its shape, so a typo fails loudly instead of grading wrong. */
export function loadNewsletterFixtures(dir = NEWSLETTER_FIXTURES_DIR): NewsletterFixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const where = `fixtures/newsletters/${name}`;
      const need = (ok: unknown, what: string) => {
        if (!ok) throw new Error(`${where}: ${what}`);
      };
      need(raw.id === name.replace(/\.json$/, ""), "id must match the file name");
      need(raw.invented === true, '"invented": true is required (fixtures are never real mail)');
      need(SUMMARY_LENGTHS.includes(raw.length), `length must be one of ${SUMMARY_LENGTHS.join(", ")}`);
      const n = raw.newsletter ?? {};
      for (const field of ["from", "subject", "receivedAt", "text"]) {
        need(typeof n[field] === "string" && n[field].trim(), `newsletter.${field} is required`);
      }
      need(Array.isArray(raw.keyFacts) && raw.keyFacts.length > 0, "keyFacts must be a non-empty list");
      for (const k of raw.keyFacts) {
        need(typeof k.fact === "string" && Array.isArray(k.terms) && k.terms.length, "each key fact needs fact and terms");
      }
      if (raw.injection !== undefined) {
        need(Array.isArray(raw.injection.forbidden) && raw.injection.forbidden.length, "injection.forbidden must be non-empty");
      }
      need(typeof raw.referenceSummary === "string" && raw.referenceSummary.trim(), "referenceSummary is required");
      return {
        id: raw.id,
        length: raw.length,
        newsletter: { from: n.from, subject: n.subject, receivedAt: n.receivedAt, text: n.text },
        keyFacts: raw.keyFacts,
        injection: raw.injection,
        referenceSummary: raw.referenceSummary,
      };
    });
}
