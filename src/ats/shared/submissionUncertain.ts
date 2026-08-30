/**
 * Shared uncertain-submission error for the unwired adapters (Lever, Ashby)
 * so evidence-carrying catches work across both with one instanceof.
 * NOTE for the wiring milestone: src/applications/submitRun.ts checks
 * `instanceof` against the greenhouse module's own SubmissionUncertainError
 * — reconcile the greenhouse class with this one when wiring, or the
 * structured evidence (classification, final_url, screenshot_path) will be
 * silently dropped to a message string for Lever/Ashby runs.
 */
export class SubmissionUncertainError extends Error {
  readonly evidence: Record<string, unknown>;
  constructor(message: string, evidence: Record<string, unknown>) {
    super(message);
    this.name = "SubmissionUncertainError";
    this.evidence = evidence;
  }
}

/**
 * A visible validation error on a still-on-form page means the submit was
 * REJECTED — waiting the rest of the 15s confirmation window teaches
 * nothing (live corpus: 12 × "still_on_form" runs each burned the full
 * window on an answer that was already on screen). Returns the first
 * matched error text so the artifact says WHY, or null when no validation
 * message is visible.
 *
 * Deliberately narrow: matches the phrasings ATSes actually render next to
 * fields, not any "error" substring — a job description mentioning
 * "error budgets" must not fast-fail a real confirmation wait.
 */
const VALIDATION_ERROR_RE =
  /((?:this\s+)?field\s+is\s+required|is\s+a\s+required\s+field|(?:please\s+)?(?:fill\s+(?:in|out)|complete|select|enter|answer)\s+(?:this|all|the)\s+(?:required\s+)?(?:field|fields|question|questions)|required\s+fields?\s+(?:are\s+)?(?:missing|incomplete)|please\s+correct\s+the\s+errors?|there\s+(?:was|were)\s+(?:a\s+)?(?:problem|errors?)\s+(?:with|submitting)\s+your\s+(?:application|form|submission)|couldn'?t\s+submit\s+your\s+application|failed\s+to\s+submit|your\s+form\s+needs\s+corrections|missing\s+entry\s+for\s+(?:a\s+)?required\s+field)/i;

/**
 * Ashby's corrections banner names the field after a colon, usually inside
 * a link: "Missing entry for required field: <a>Complete the Takehome</a>"
 * (live 2026-08-30 Composio d607b204; 2026-08-11 Quadrillion "Do you
 * require visa sponsorship…"). Carry the name so the artifact and the
 * review item say WHICH field, not just that one is missing.
 */
const NAMED_FIELD_RE =
  /missing\s+entry\s+for\s+(?:a\s+)?required\s+field\s*:?\s*((?:<[^>]+>\s*)*)([^<]{1,100})/i;

export function detectVisibleValidationError(html: string): string | null {
  const m = html.match(VALIDATION_ERROR_RE);
  if (!m) return null;
  const named = html.match(NAMED_FIELD_RE);
  const field = named?.[2]?.replace(/\s+/g, " ").trim();
  const base = m[0].replace(/\s+/g, " ").trim();
  if (field && /^(?:your form needs corrections|missing entry)/i.test(base)) {
    return `missing entry for required field: ${field}`.slice(0, 160);
  }
  return base.slice(0, 120);
}

/**
 * The ATS itself REFUSED the submission after the click and said so on the
 * page — a definitive not-submitted, not an inconclusive wait. Live
 * 2026-08-30 (Ashby, Quadrillion 23d64c04): "We couldn't submit your
 * application — Your application submission was flagged as possible spam.
 * … please submit your application again." The form was gone, so the
 * still_on_form validation fast-fail never ran, the classifier read
 * "unknown", the run burned the 15s window and parked UNCERTAIN for the
 * operator although the page had already answered.
 *
 * Narrow on purpose: whole-sentence refusals an ATS renders as a banner,
 * never a bare "spam"/"error" substring.
 */
const SUBMISSION_REJECTED_RE =
  /(?:we\s+)?couldn'?t\s+submit\s+your\s+application|(?:your\s+)?(?:application|submission)\s+(?:submission\s+)?was\s+flagged\s+as\s+(?:possible\s+)?spam|flagged\s+as\s+possible\s+spam|your\s+(?:application|submission)\s+(?:was|has\s+been)\s+(?:rejected|blocked)\s+by\s+(?:our\s+)?(?:spam|security|fraud)/i;

export function detectSubmissionRejection(html: string): string | null {
  const m = html.match(SUBMISSION_REJECTED_RE);
  if (!m) return null;
  return m[0].replace(/\s+/g, " ").trim().slice(0, 120);
}
