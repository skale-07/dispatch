export const APPLICATION_STATES = [
  "DISCOVERED",
  "DUPLICATE_CHECK",
  "ELIGIBILITY_CHECK",
  "FILTERED_OUT",
  "QUEUED",
  "MATERIALS_GENERATING",
  "RESUME_DOWNLOADED",
  "COVER_LETTER_REQUIRED",
  "COVER_LETTER_DOWNLOADED",
  "APPLICATION_OPENING",
  "ATS_DETECTION",
  "APPLICATION_INSPECTION",
  "JOBRIGHT_AUTOFILL_RUNNING",
  "JOBRIGHT_AUTOFILL_VERIFICATION",
  "FORM_RESETTING",
  "NATIVE_AUTOFILL_RUNNING",
  "FIELD_VERIFICATION",
  "ESSAY_REQUIRED",
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "AMBIGUOUS_FIELD",
  "UNSUPPORTED_ATS",
  "READY_TO_SUBMIT",
  "SUBMITTING",
  "SUBMITTED",
  "SUBMISSION_VERIFICATION_FAILED",
  "CONTACTS_EXTRACTING",
  "CONTACTS_EXTRACTED",
  "LINKEDIN_ENRICHING",
  "LINKEDIN_ENRICHED",
  "EMAIL_GENERATING",
  "EMAIL_GENERATED",
  "DRAFT_CREATING",
  "DRAFT_CREATED",
  "COMPLETED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const APPLICATION_ROUTES = [
  "AUTO_SUBMIT",
  "ESSAY_REQUIRED",
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "UNSUPPORTED_ATS",
  "AMBIGUOUS_FIELD",
  "INELIGIBLE",
  "DUPLICATE",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;

export type ApplicationRoute = (typeof APPLICATION_ROUTES)[number];

const ALLOWED: Partial<Record<ApplicationState, readonly ApplicationState[]>> = {
  DISCOVERED: ["DUPLICATE_CHECK", "FAILED_RETRYABLE", "FAILED_FINAL"],
  DUPLICATE_CHECK: ["ELIGIBILITY_CHECK", "FILTERED_OUT", "FAILED_FINAL"],
  ELIGIBILITY_CHECK: ["QUEUED", "FILTERED_OUT", "FAILED_FINAL"],
  FILTERED_OUT: [],
  QUEUED: ["MATERIALS_GENERATING", "FAILED_RETRYABLE", "FAILED_FINAL"],
  MATERIALS_GENERATING: [
    "RESUME_DOWNLOADED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  RESUME_DOWNLOADED: [
    "COVER_LETTER_REQUIRED",
    "APPLICATION_OPENING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  COVER_LETTER_REQUIRED: [
    "COVER_LETTER_DOWNLOADED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  COVER_LETTER_DOWNLOADED: [
    "APPLICATION_OPENING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  APPLICATION_OPENING: [
    "ATS_DETECTION",
    "AUTH_REQUIRED",
    "CAPTCHA_REQUIRED",
    "UNSUPPORTED_ATS",
    // Navigation can learn mid-opening that the posting is closed (JobRight
    // "closed" wall). A dead posting is INELIGIBLE, not a failure — without
    // this edge the transition threw and dropped the shared nav session
    // (overnight 2026-08-29, issue #16: 5 pipeline_errors in one session).
    "FILTERED_OUT",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  ATS_DETECTION: [
    "APPLICATION_INSPECTION",
    "UNSUPPORTED_ATS",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  APPLICATION_INSPECTION: [
    "JOBRIGHT_AUTOFILL_RUNNING",
    "NATIVE_AUTOFILL_RUNNING",
    "ESSAY_REQUIRED",
    "AMBIGUOUS_FIELD",
    "AUTH_REQUIRED",
    "CAPTCHA_REQUIRED",
    "UNSUPPORTED_ATS",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  JOBRIGHT_AUTOFILL_RUNNING: [
    "JOBRIGHT_AUTOFILL_VERIFICATION",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  JOBRIGHT_AUTOFILL_VERIFICATION: [
    "FORM_RESETTING",
    "FIELD_VERIFICATION",
    "NATIVE_AUTOFILL_RUNNING",
    "ESSAY_REQUIRED",
    "AMBIGUOUS_FIELD",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  FORM_RESETTING: [
    "NATIVE_AUTOFILL_RUNNING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  NATIVE_AUTOFILL_RUNNING: [
    "FIELD_VERIFICATION",
    "ESSAY_REQUIRED",
    "AMBIGUOUS_FIELD",
    // Fill reached without a stored employer URL (enqueue reused a mid-fill
    // row, or upsert wiped the nav-owned URL). Navigation lives at opening.
    "APPLICATION_OPENING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  FIELD_VERIFICATION: [
    "READY_TO_SUBMIT",
    "ESSAY_REQUIRED",
    "AMBIGUOUS_FIELD",
    // Deliberate edge (night20 #62, live tiaa.wd1): a COLD Workday entry
    // cannot submit — the wizard lives behind portal auth + the Apply
    // walk that only the fill leg performs. The pipeline re-runs the
    // fill so the same-run held page carries the submit.
    "NATIVE_AUTOFILL_RUNNING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  ESSAY_REQUIRED: [
    "FIELD_VERIFICATION",
    "READY_TO_SUBMIT",
    "APPLICATION_INSPECTION",
    "NATIVE_AUTOFILL_RUNNING",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  AUTH_REQUIRED: ["APPLICATION_OPENING", "FAILED_FINAL"],
  // Operator resolution (console/CLI): the operator solved the captcha in a
  // headed session — or the wall is gone — so re-open the employer page.
  CAPTCHA_REQUIRED: ["APPLICATION_OPENING", "FAILED_FINAL"],
  AMBIGUOUS_FIELD: [
    "FIELD_VERIFICATION",
    "NATIVE_AUTOFILL_RUNNING",
    "FAILED_FINAL",
  ],
  // Operator resolution: a corrected, supported employer URL was supplied —
  // re-open against it (URL validity is enforced by setEmployerApplicationUrl).
  UNSUPPORTED_ATS: ["APPLICATION_OPENING", "FAILED_FINAL"],
  // Deliberate edge (2026-09-14, live rb.wd5 5d8afb36 cycles 155/156): a
  // Workday wizard cut at the per-app deadline in READY_TO_SUBMIT is a
  // COLD entry on the next cycle — the submit runner opens the posting
  // URL and refuses NO_APPLICATION_FORM. Same shape as #62 at
  // FIELD_VERIFICATION: re-run the fill leg so the held page carries the
  // submit.
  READY_TO_SUBMIT: ["SUBMITTING", "FAILED_RETRYABLE", "FAILED_FINAL", "NATIVE_AUTOFILL_RUNNING"],
  SUBMITTING: [
    "SUBMITTED",
    "SUBMISSION_VERIFICATION_FAILED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  SUBMITTED: [
    "CONTACTS_EXTRACTING",
    "COMPLETED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  // Operator resolution of an uncertain submission (review:resolve):
  // → SUBMITTED when the receipt is confirmed to exist;
  // → FAILED_RETRYABLE when confirmed nothing was submitted (explicit re-queue).
  SUBMISSION_VERIFICATION_FAILED: [
    "SUBMITTED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
  ],
  CONTACTS_EXTRACTING: [
    "CONTACTS_EXTRACTED",
    "FAILED_RETRYABLE",
    "COMPLETED",
  ],
  CONTACTS_EXTRACTED: ["LINKEDIN_ENRICHING", "EMAIL_GENERATING", "COMPLETED"],
  LINKEDIN_ENRICHING: ["LINKEDIN_ENRICHED", "EMAIL_GENERATING", "COMPLETED"],
  LINKEDIN_ENRICHED: ["EMAIL_GENERATING", "COMPLETED"],
  EMAIL_GENERATING: ["EMAIL_GENERATED", "COMPLETED", "FAILED_RETRYABLE"],
  EMAIL_GENERATED: ["DRAFT_CREATING", "COMPLETED"],
  DRAFT_CREATING: ["DRAFT_CREATED", "FAILED_RETRYABLE", "COMPLETED"],
  DRAFT_CREATED: ["COMPLETED"],
  COMPLETED: [],
  FAILED_RETRYABLE: [
    "QUEUED",
    "MATERIALS_GENERATING",
    "APPLICATION_OPENING",
    "FAILED_FINAL",
  ],
  FAILED_FINAL: [],
};

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
): boolean {
  if (from === to) return true;
  const allowed = ALLOWED[from];
  return allowed?.includes(to) ?? false;
}

export function assertTransition(
  from: ApplicationState,
  to: ApplicationState,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
