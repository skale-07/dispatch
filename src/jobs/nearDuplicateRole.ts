/**
 * #249 — don't apply to the same role twice under a different term.
 *
 * Operator, 2026-09-10: "ensure your not sending duplicate applications.
 * youve sent so many apps to verkada."
 *
 * The audit found no TRUE duplicates — every submission is a distinct
 * posting URL, and each company's submit count equals its distinct-posting
 * count. But the postings themselves are often term variants of one job:
 *
 *   Systems Engineering Intern Summer 2027 / Systems Engineering Intern Spring 2027
 *   Fluid Systems Intern Summer 2027       / Fluid Systems Intern Spring 2027
 *   Flight Software Intern Summer 2027     / Flight Software Intern Spring 2027
 *
 * Eight Rocket Lab applications covering five actual roles. To the person
 * reading them that is the same candidate applying twice to one job, which
 * is exactly the impression the operator is objecting to.
 *
 * Scope, deliberately narrow: only a title that DIFFERS from one we
 * already applied to yet collapses to the same key counts. Two postings
 * with the IDENTICAL title are separate location requisitions (Stripe
 * posts "Software Engineer, Intern" per city) and the 2026-09-07 US-only
 * directive expects those to enqueue, so they are left alone. Whether
 * per-location reqs should also collapse is an open question for the
 * operator, not something to decide by silently rewriting that contract.
 *
 * This is also NOT a per-company cap — the operator ruled that out
 * on 2026-09-07 ("same-JobRight-job dedupe only; never cap per company"),
 * and applying to five different Rocket Lab teams is fine. What is dropped
 * is the SECOND posting of a role we already applied to at that company,
 * once season and year are stripped.
 */

/** Season / term words that distinguish a posting but not a job. */
const TERM_WORDS = [
  "summer", "spring", "fall", "autumn", "winter",
  "co-op", "coop", "internship", "intern", "program",
];

/**
 * The role, reduced to what actually identifies the JOB: season words,
 * years, and intern/co-op boilerplate removed.
 *
 *   "Systems Engineering Intern Summer 2027"  -> "systems engineering"
 *   "Flight Software Intern Spring 2027"      -> "flight software"
 *   "Software Engineer, Intern (Summer 2026)" -> "software engineer"
 *
 * An empty result means the title was ONLY boilerplate; the caller treats
 * that as "cannot tell" and never dedupes on it.
 */
export function normalizeRoleForDedupe(role: string): string {
  let text = role.toLowerCase();
  // Strip 4-digit years and year ranges first.
  text = text.replace(/\b(19|20)\d{2}\b/g, " ");
  text = text.replace(/[^a-z0-9+#]+/g, " ");
  const kept = text
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !TERM_WORDS.includes(t));
  return kept.join(" ").trim();
}

/**
 * Is `role` the same job as one we already have at this company?
 *
 * Compared only against roles at the SAME employer — two companies may
 * both post "Software Engineer Intern" and both are worth applying to.
 */
export function isNearDuplicateRole(
  role: string,
  existingRolesAtCompany: readonly string[],
): { duplicate: boolean; matched: string | null; key: string } {
  const key = normalizeRoleForDedupe(role);
  if (key.length < 3) return { duplicate: false, matched: null, key };
  const raw = role.trim().toLowerCase();
  for (const existing of existingRolesAtCompany) {
    // IDENTICAL titles are separate location reqs, not a duplicate job:
    // Stripe posts "Software Engineer, Intern" for Seattle, Remote and
    // unlisted, and the 2026-09-07 US-only directive expects all three to
    // enqueue. Only a title that DIFFERS yet collapses to the same key is
    // the same job posted for two terms — which is the case the operator
    // objected to on 2026-09-10.
    if (existing.trim().toLowerCase() === raw) continue;
    if (normalizeRoleForDedupe(existing) === key) {
      return { duplicate: true, matched: existing, key };
    }
  }
  return { duplicate: false, matched: null, key };
}
