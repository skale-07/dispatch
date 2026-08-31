import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  defaultTtyConfirm,
  type ConfirmSubmission,
} from "./submitConfirmation.js";
import { diagnoseDisabledSubmit } from "../ats/shared/submitDiagnostics.js";
import { scanRequiredCompleteness } from "../ats/shared/requiredCompleteness.js";
import {
  fetchGreenhouseQuestions,
  requiredQuestionLabels,
} from "../ats/greenhouse/questionsApi.js";
import type { SubmitClickOptions } from "../ats/adapter.js";
import { recoverEmailVerification } from "../verification/recoverSubmitVerification.js";
import {
  resolveVerificationCodeProvider,
  type FetchVerificationCode,
} from "../verification/codeProviders.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import {
  buildIdempotencyKey,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  markIdempotencyUncertain,
} from "../queue/idempotency.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import {
  insertPendingSubmission,
  markSubmissionFailed,
  markSubmissionUncertain,
  markSubmissionVerified,
} from "../queue/submissionsRepo.js";
import {
  createAutomationRun,
  tryConsumeUnattendedSubmission,
} from "../queue/automationRuns.js";
import {
  assertSubmissionAllowed,
} from "./submissionGuards.js";
import { assertSubmitAllowed } from "./formFillGuards.js";
import { planApplicationFill } from "./applicationFiller.js";
import { approvedFillEntries } from "./approvedFillPlan.js";
import { buildHumanEssayEntries } from "./essayFill.js";
import { greenhouseFillEssays } from "../ats/greenhouse/essayFill.js";
import type { FieldMeta } from "../ats/greenhouse/fill.js";
import { SubmissionUncertainError } from "../ats/shared/submissionUncertain.js";
import {
  checkUrlCongruence,
  getJobIdentity,
} from "../navigation/congruence.js";
import {
  failedApprovedEntries,
  reachGreenhouseApplicationForm,
  verifyPageBeforeMutation,
} from "../ats/greenhouse/liveFill.js";
import { healFailedFillEntries } from "../ats/greenhouse/fillHealer.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { ATS_BINDINGS } from "./atsBindings.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { resolveBrowserChannel } from "../browser/launchOptions.js";
import { getRegisteredResume } from "../jobright/materialsRegister.js";
import { verifyResumePdfFile } from "../jobright/resumeDownload.js";
import {
  ensureApplicationArtifactDirs,
  writeJsonAtomic,
} from "../storage/atomicJson.js";
import { redactObject } from "../logging/redaction.js";
import {
  parseSubmitNotes,
  recordSubmitAttempt,
} from "../storage/navSubmitOutcomes.js";
import type { SubmissionReceipt } from "../ats/adapter.js";
import {
  buildOperatorFieldBrief,
  printOperatorFieldBrief,
  type OperatorFieldBrief,
} from "./operatorFieldBrief.js";
import { attachSupplementalMaterials } from "../ats/shared/supplementalMaterials.js";

export type SubmissionRunOutcome =
  | "SUBMITTED_VERIFIED"
  | "UNCERTAIN"
  | "REFUSED"
  | "FAILED_BEFORE_CLICK"
  /**
   * The click happened and the ATS refused it ON THE PAGE (classification
   * `rejected`, e.g. Ashby "flagged as possible spam"). Definitive
   * not-submitted → FAILED_RETRYABLE, no UNCERTAIN review park.
   */
  | "REJECTED_AFTER_CLICK";

export type SubmissionRunReport = {
  outcome: SubmissionRunOutcome;
  application_id: string;
  submission_id: string | null;
  attempt: number | null;
  receipt: SubmissionReceipt | null;
  review_item_id: string | null;
  reason: string;
  artifact_path: string | null;
  /** Present when pre-click fill/verify/upload failed. */
  operator_brief?: OperatorFieldBrief;
};

/**
 * An emailed-code wall is a LOGIN_WALL to the classifier (portal tuning
 * 390c113 — correct for fill/nav routing), but on the SUBMIT path it is a
 * RECOVERABLE state, not a refusal: the disabled-submit diagnostics detect
 * the one-time-code input, the mailbox waiter fetches the newest code, and
 * submit unlocks. Refusing at the page gate killed exactly that recovery.
 * Only the PURE code-wall signature passes through — any wall that also
 * shows a password input still refuses, because a password prompt is not
 * recoverable by reading mail.
 */
export function isEmailedCodeWallOnly(gate: {
  ok: boolean;
  failureCode?: string | null;
  reason?: string | null;
}): boolean {
  return (
    !gate.ok &&
    gate.failureCode === "LOGIN_WALL" &&
    /emailed_code_wall/.test(gate.reason ?? "") &&
    !/password_input/.test(gate.reason ?? "")
  );
}

/**
 * Human-approved submission (Phase 7), dispatched per ATS via ATS_BINDINGS
 * (greenhouse / lever / ashby).
 *
 * Layered defenses, in firing order:
 *   env gate (assertSubmitAllowed) → state check → lease →
 *   assertSubmissionAllowed → idempotency claim → per-ATS page gate
 *   (greenhouse: SPA settle + Apply recovery, then identity verification;
 *   lever/ashby: the weaker trusted-host/login-wall/captcha/form gate —
 *   see preMutationGate.ts) →
 *   fill verify must pass → per-submission human confirmation (or persisted
 *   unattended cap) → single click → deterministic receipt verification.
 * Essays present on an ATS without a wired essay path fail closed BEFORE
 * any mutation. An unverifiable outcome is UNCERTAIN: review item +
 * idempotency 'uncertain', and nothing ever re-clicks.
 */
export async function runAtsSubmission(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  /** Honored only when SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false. */
  assumeYes?: boolean;
  /** Shared per-batch run for the unattended cap; created ad hoc if absent. */
  automationRunId?: string;
  /**
   * Confirmation transport (submitConfirmation.ts). Defaults to the TTY
   * prompt — byte-identical CLI behavior. An injected callback (console web
   * modal) sits at exactly the same point; false ⇒ REFUSED before the
   * SUBMITTING transition, so the app stays READY_TO_SUBMIT.
   */
  confirmSubmission?: ConfirmSubmission;
  /**
   * Verification-code source for disabled-submit recovery. Defaults to
   * the flag-gated provider resolution (Outlook web / Gmail readonly);
   * injectable for tests.
   */
  fetchVerificationCode?: FetchVerificationCode;
  /**
   * Caller-owned page from the same pipeline fill. Do not goto, do not
   * close. `reuseFilledPage` skips adapter.fill when verify still passes
   * (Jump Trading 2026-08-17: cold re-fill could not open comboboxes
   * after a verified 18-field fill was thrown away).
   */
  existingPage?: Page;
  reuseFilledPage?: boolean;
}): Promise<SubmissionRunReport> {
  const { db, applicationId } = input;
  const cfg = getConfig();
  const runStartedAt = new Date().toISOString();
  const startedMs = Date.now();
  /** Function-scoped so persist() can flush it whatever path returned. */
  const submitTelemetry = {
    via: null as string | null,
    ctaInventoryCount: null as number | null,
    clicked: false,
    capHit: false,
    recoveryUsed: false,
  };

  const report: SubmissionRunReport = {
    outcome: "REFUSED",
    application_id: applicationId,
    submission_id: null,
    attempt: null,
    receipt: null,
    review_item_id: null,
    reason: "",
    artifact_path: null,
  };

  // Env gate before anything else — no browser, no DB writes when flags refuse.
  assertSubmitAllowed("submitRun.runAtsSubmission");

  const app = getApplication(db, applicationId);
  if (!app) {
    report.reason = `Unknown application: ${applicationId}`;
    return report;
  }
  if (app.state !== "READY_TO_SUBMIT") {
    report.reason = `Application state is ${app.state}, not READY_TO_SUBMIT`;
    return report;
  }

  // Safety-critical guard first: a verified or uncertain prior submission
  // must surface before any mundane refusal (URL, resume, …).
  // Re-checked under the lease below against races.
  assertSubmissionAllowed(db, applicationId);

  const job = db
    .prepare(
      `SELECT j.company, j.role, j.normalized_application_url AS url,
              j.raw_json
       FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as
    | { company: string; role: string; url: string | null; raw_json: string }
    | undefined;
  const raw = job ? (JSON.parse(job.raw_json) as Record<string, unknown>) : {};
  const employerUrl =
    (typeof raw["employer_application_url"] === "string"
      ? (raw["employer_application_url"] as string)
      : null) ?? job?.url;
  if (!employerUrl) {
    report.reason = "No employer application URL stored for this job";
    return report;
  }
  const detected = detectAtsFromUrl(employerUrl);
  if (detected.ats === null) {
    report.reason = `Employer URL failed ATS validation: ${detected.failureReason}`;
    return report;
  }
  const binding = ATS_BINDINGS[detected.ats];

  // Defense in depth against wrong-employer URLs: the page identity gate
  // below verifies the page matches the STORED URL — which is circular when
  // the stored URL itself was mis-resolved (the live nav-agent failure).
  // The company-vs-URL check breaks that circle before any submit machinery.
  const jobIdentity = getJobIdentity(db, applicationId);
  if (jobIdentity?.company) {
    const cong = checkUrlCongruence(jobIdentity.company, detected.normalizedUrl);
    if (cong.verdict === "mismatch") {
      report.reason = `Refusing submit: stored employer URL belongs to "${cong.slug}", not ${jobIdentity.company} — re-run navigation for this application`;
      return report;
    }
  }

  const resume = getRegisteredResume(db, applicationId);
  if (!resume) {
    report.reason =
      "No verified resume material — run materials:register (or resume:download) first";
    return report;
  }
  // The file may have moved or been corrupted since registration.
  const resumeOnDisk = verifyResumePdfFile(resume.path);
  if (!resumeOnDisk.verified) {
    report.reason = `Registered resume failed on-disk verification: ${resume.path} — ${resumeOnDisk.evidence}. Re-run materials:register.`;
    return report;
  }

  // application_events.run_id references automation_runs(id); reuse the
  // caller's batch run (pipeline) or create our own row for this submission.
  const runId =
    input.automationRunId ??
    createAutomationRun(db, { stage: "submit" }).id;
  acquireLease(db, {
    resourceType: "application",
    resourceId: `${applicationId}:submit`,
    holderRunId: runId,
    ttlMs: 300_000,
  });

  try {
    assertSubmissionAllowed(db, applicationId);

    const pending = insertPendingSubmission(db, { applicationId });
    report.submission_id = pending.id;
    report.attempt = pending.submission_attempt_number;

    const idemKey = buildIdempotencyKey("submit", {
      application_id: applicationId,
      attempt: String(pending.submission_attempt_number),
    });
    claimIdempotencyKey(db, idemKey, {
      holderRunId: runId,
      resourceType: "submission",
      resourceId: pending.id,
    });

    const dirs = ensureApplicationArtifactDirs(applicationId);
    const submissionDir = path.join(dirs.root, "submission");
    fs.mkdirSync(submissionDir, { recursive: true });
    const screenshotPath = path.join(
      submissionDir,
      `receipt-attempt-${pending.submission_attempt_number}.png`,
    );

    const runOnPage = async (startPage: Page) => {
        let page = startPage;
        let landingNotes: string[] = [];
        // Greenhouse identity gate is FORM_NOT_FOUND on a posting/SPA shell.
        // Fill already recovers (settle → hop → Apply). Submit used to gate
        // the first paint and fail before re-fill. Same recovery, same page.
        let gate;
        if (binding.id === "greenhouse") {
          if (input.reuseFilledPage) {
            gate = await verifyPageBeforeMutation(
              page,
              employerUrl,
              detected.normalizedUrl ?? null,
            );
            if (
              !gate.ok &&
              (gate.failureCode === "FORM_NOT_FOUND" ||
                gate.failureCode === "ZERO_FIELDS")
            ) {
              const reached = await reachGreenhouseApplicationForm(
                page,
                employerUrl,
                detected.normalizedUrl ?? null,
                { dismissObstructions: true },
              );
              page = reached.page;
              gate = reached.gate;
              landingNotes = [
                "reuseFilledPage: form gone — landing recovery",
                ...reached.notes,
              ];
            } else {
              landingNotes = ["reusing filled page — skipped landing recovery"];
            }
          } else {
            const reached = await reachGreenhouseApplicationForm(
              page,
              employerUrl,
              detected.normalizedUrl ?? null,
              { dismissObstructions: true },
            );
            page = reached.page;
            gate = reached.gate;
            landingNotes = reached.notes;
          }
          if (landingNotes.length > 0) {
            logger.info("greenhouse submit landing recovery", {
              service: "submit",
              action: "landing_recovery",
              application_id: applicationId,
              metadata: {
                notes: landingNotes,
                ok: gate.ok,
                failure_code: gate.failureCode,
                reuse_filled_page: Boolean(input.reuseFilledPage),
              },
            });
          }
        } else {
          gate = await binding.gate(page, employerUrl, detected.normalizedUrl);
        }
        const emailedCodeWallOnly = isEmailedCodeWallOnly(gate);
        if (emailedCodeWallOnly) {
          logger.info(
            "emailed-code wall at the submit gate — proceeding to the verification-code recovery",
            { service: "submit", action: "code_wall_passthrough", application_id: applicationId },
          );
        }
        if (!gate.ok && !emailedCodeWallOnly) {
          markSubmissionFailed(db, pending.id, `page gate: ${gate.failureCode}`);
          failIdempotencyKey(db, idemKey, gate.failureCode ?? "gate");
          transitionApplication(db, {
            applicationId,
            nextState: "FAILED_RETRYABLE",
            reason: `submit page gate failed: ${gate.failureCode}`,
            runId,
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = `Page failed identity gate (${gate.failureCode}): ${gate.reason}${
            landingNotes.length > 0 ? ` — ${landingNotes.join("; ")}` : ""
          }`;
          return persist(report);
        }

        const { adapter, approvedPlan, fields } = await planApplicationFill({
          url: gate.finalUrl,
          html: gate.html,
          capture: { db, applicationId },
        });
        if (adapter.id !== binding.id) {
          markSubmissionFailed(
            db,
            pending.id,
            `ATS mismatch: URL says ${binding.id}, page detected as ${adapter.id}`,
          );
          failIdempotencyKey(db, idemKey, "ats_mismatch");
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = `ATS mismatch: URL validated as ${binding.id} but the page detected as ${adapter.id}`;
          return persist(report);
        }

        // Essays on an ATS without a wired essay path: fail closed BEFORE
        // the confirmation prompt and before any page mutation, leaving the
        // application in READY_TO_SUBMIT so it retries once essays land.
        const essayEntries = buildHumanEssayEntries(db, applicationId, fields);
        if (essayEntries.length > 0 && !binding.supportsEssayFill) {
          markSubmissionFailed(
            db,
            pending.id,
            `${binding.id} essay fill not wired (${essayEntries.length} essay answers present)`,
          );
          failIdempotencyKey(db, idemKey, "essays_not_supported");
          const { item } = upsertOpenReviewItem(db, {
            applicationId,
            kind: "MANUAL",
            title: `Essay answers exist but ${binding.id} essay fill is not wired`,
            payload: {
              ats: binding.id,
              essay_count: essayEntries.length,
              essay_fields: essayEntries.map((e) => e.field_id),
            },
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.review_item_id = item.id;
          report.reason = `${binding.id} essay fill is not wired — ${essayEntries.length} human essay answers would be dropped`;
          return persist(report);
        }

        // Human confirmation BEFORE any mutation of the page. The transport
        // is injectable (web modal via the console runner); the default TTY
        // prompt never declines, exactly as before.
        if (cfg.submitRequiresLocalConfirmation) {
          const confirm = input.confirmSubmission ?? defaultTtyConfirm();
          const approved = await confirm({
            application_id: applicationId,
            company: job?.company ?? null,
            role: job?.role ?? null,
            url: gate.finalUrl,
            attempt: pending.submission_attempt_number,
            resume_sha256: resume.sha256,
            resume_size_bytes: resume.size_bytes,
            plan: {
              fillable_count: approvedPlan.fillable_count,
              skipped_count: approvedPlan.skipped_count,
              review_required_count: approvedPlan.review_required_count,
            },
          });
          if (!approved) {
            markSubmissionFailed(
              db,
              pending.id,
              "operator declined submission confirmation",
            );
            failIdempotencyKey(db, idemKey, "operator_declined");
            report.outcome = "REFUSED";
            report.reason =
              "Operator declined (or confirmation timed out) — submission refused";
            return persist(report);
          }
        } else {
          // Check the acknowledgment BEFORE consuming a budget slot — a
          // refusal here must never burn an unattended submission the run
          // never actually made. (Previously the slot was consumed first,
          // so a run without --yes silently decremented the cap.)
          if (!input.assumeYes) {
            markSubmissionFailed(db, pending.id, "unattended without --yes");
            failIdempotencyKey(db, idemKey, "no_confirmation");
            report.outcome = "REFUSED";
            report.reason =
              "Unattended mode requires an explicit --yes acknowledgment";
            return persist(report);
          }
          // The budget slot is NOT consumed here anymore — it is consumed at
          // click-commit time via the beforeClick gate below, so a failure
          // that never reaches a clickable control (verify miss, control not
          // found, disabled) no longer burns an unattended submission. The
          // Netic session spent its only slot on exactly such a failure.
        }

        // Click-commit gate: consumed once, immediately before the first
        // actual click. The verification-recovery retry re-enters submit()
        // after a slot was already spent — idempotent by design.
        let unattendedSlotConsumed = false;
        let unattendedCapHit = false;
        const clickGate: SubmitClickOptions = cfg.submitRequiresLocalConfirmation
          ? {}
          : {
              beforeClick: () => {
                if (unattendedSlotConsumed) return true;
                if (tryConsumeUnattendedSubmission(db, runId)) {
                  unattendedSlotConsumed = true;
                  return true;
                }
                unattendedCapHit = true;
                return false;
              },
            };

        transitionApplication(db, {
          applicationId,
          nextState: "SUBMITTING",
          reason: "human-approved submission started",
          runId,
        });

        try {
          // Fill + essays + upload + verify on the gated page.
          // A same-run pipeline fill already mutated this DOM; re-fill
          // empties Greenhouse comboboxes (listbox never opens).
          // Upload FIRST (night19 #49): uploading after the fill let the
          // board's resume-parse re-render wipe verified comboboxes. On a
          // reused page the pipeline already uploaded and the chip check
          // returns "already attached" without touching the form.
          const upload = await adapter.uploadResume(page, resume.path);
          if (upload.verified && !/already attached/.test(upload.evidence)) {
            await page.waitForTimeout(2_500);
          }
          // #84 (live stryker): a Workday held page is usually a QUESTION
          // or REVIEW step with no upload widget at all — the resume was
          // uploaded and verified during the wizard walk (My Experience).
          // An upload that cannot be re-checked on this page is not a
          // failure; Workday's own page errors flag a missing document.
          let uploadOk = upload.verified;
          if (!uploadOk && binding.id === "workday") {
            const fileInputs = await page
              .locator("input[type='file']")
              .count()
              .catch(() => 0);
            if (fileInputs === 0) {
              uploadOk = true;
              upload.evidence = `${upload.evidence}; no upload widget on this wizard page — walk-time upload is the evidence (#84)`;
            }
          }
          let fill = input.reuseFilledPage
            ? {
                filled: approvedFillEntries(approvedPlan).map((e) => e.field_id),
                skipped: [] as string[],
                errors: [] as string[],
              }
            : await adapter.fill(page, approvedPlan.answers);
          if (input.reuseFilledPage) {
            logger.info("submit reusing filled page — skipped re-fill", {
              service: "submit",
              action: "reuse_filled_page",
              application_id: applicationId,
              metadata: { filled_count: fill.filled.length },
            });
          }
          if (essayEntries.length > 0 && binding.supportsEssayFill) {
            const fieldMeta = new Map<string, FieldMeta>(
              fields.map((f) => {
                const meta: FieldMeta = { type: f.type };
                if (f.name) meta.name = f.name;
                if (f.inputId) meta.inputId = f.inputId;
                return [f.id, meta] as const;
              }),
            );
            await greenhouseFillEssays(page, essayEntries, fieldMeta, db);
          }
          // Known operator materials beyond the resume (transcript) — live
          // 2026-08-29 Appian: the click bounced off a required transcript
          // upload while private/candidate/transcript.pdf sat on disk.
          const supplemental = await attachSupplementalMaterials(page);
          if (
            supplemental.attached.length > 0 ||
            supplemental.notes.length > 0
          ) {
            logger.info("supplemental materials pass", {
              service: "submit",
              action: "supplemental_materials",
              application_id: applicationId,
              metadata: {
                attached: supplemental.attached,
                notes: supplemental.notes,
              },
            });
          }
          let verify = await adapter.verify(page, approvedPlan.answers);
          // #82 (live stryker 2026-08-31): a Workday WIZARD's answers live
          // across pages — the flat re-verify on the held page reads every
          // other page's question as unreachable (observed null via
          // resolution failure), and the blanket re-fill would smear the
          // full plan onto the review page. The walk verified each page
          // live; only failures whose control IS on the current page
          // (observed non-null) block here. The required-completeness scan
          // below still guards the click, and a rejected click is still
          // definitive.
          const applyCrossPageWaiver = (
            v: typeof verify,
          ): typeof verify => {
            if (binding.id !== "workday" || v.passed) return v;
            const onPageMisses = v.fields.filter(
              (f) => !f.match && f.observed !== null,
            );
            const offPage = v.fields.filter(
              (f) => !f.match && f.observed === null,
            ).length;
            if (onPageMisses.length === 0 && fill.errors.length === 0 && offPage > 0) {
              return {
                ...v,
                passed: true,
                warnings: [
                  ...v.warnings,
                  `workday wizard: ${offPage} cross-page answer(s) not re-checkable on this page — per-page verifies during the walk are the evidence`,
                ],
              };
            }
            return v;
          };
          verify = applyCrossPageWaiver(verify);
          // #90 (live crowe/stryker): for a Workday WIZARD the blanket
          // re-fill below smears cross-page errors; the targeted retype
          // (re-pick selects, keystroke text) fixes exactly the on-page
          // misses, then the waiver re-applies over the fresh verify.
          if (
            binding.id === "workday" &&
            !verify.passed &&
            adapter.retypeVerifyMisses
          ) {
            const retype = await adapter.retypeVerifyMisses(page, verify);
            if (retype.retyped.length > 0) {
              verify = applyCrossPageWaiver(
                await adapter.verify(page, approvedPlan.answers),
              );
            }
          }
          if (binding.id !== "workday" && (!verify.passed || fill.errors.length > 0)) {
            // Two live causes, one bounded remedy (ONE re-fill, then verify
            // decides): a reused held page whose fill did not survive, and —
            // neuralink 2026-08-30 — a fresh fill whose five comboboxes read
            // "(empty)" AFTER the resume upload while the same fill verified
            // clean in the fill-only path (fill → verify → upload). The
            // upload's resume-parse re-render is between the fill and this
            // verify; re-filling the misses after it is the cheap fix.
            logger.warn(
              input.reuseFilledPage
                ? "reused fill did not verify — filling this page once"
                : "post-upload verify failed — re-filling once (upload may have re-rendered the form)",
              {
                service: "submit",
                action: input.reuseFilledPage
                  ? "reuse_filled_page_fallback"
                  : "post_upload_refill",
                application_id: applicationId,
                metadata: {
                  verify_passed: verify.passed,
                  fill_errors: fill.errors.length,
                  mismatches: verify.fields.filter((f) => !f.match).length,
                },
              },
            );
            fill = await adapter.fill(page, approvedPlan.answers);
            verify = await adapter.verify(page, approvedPlan.answers);
          }
          // Phase 6a′: one heal pass before giving up on the click
          // (greenhouse-only until the healer is proven on other ATSes).
          if (!verify.passed && binding.supportsHealing) {
            const failed = failedApprovedEntries(approvedPlan, verify);
            if (failed.length > 0) {
              const heal = await healFailedFillEntries({
                page,
                failedEntries: failed,
              });
              if (heal.healed.length > 0) {
                verify = await adapter.verify(page, approvedPlan.answers);
              }
            }
          }
          if (!verify.passed || !uploadOk || fill.errors.length > 0) {
            const operatorBrief = buildOperatorFieldBrief({
              context: `Submit blocked — ${binding.id} app ${applicationId}`,
              verify,
              fill,
              upload,
              planEntries: approvedPlan.entries.map((e) => ({
                field_id: e.field_id,
                label: e.label,
                type: e.type,
                canonical_field: e.canonical_field,
                action:
                  e.action === "FILL"
                    ? ("fill" as const)
                    : e.action === "REVIEW_REQUIRED"
                      ? ("review_required" as const)
                      : ("skip_empty" as const),
                value: e.value,
                reason: e.reason,
              })),
            });
            printOperatorFieldBrief(operatorBrief);
            markSubmissionFailed(
              db,
              pending.id,
              `pre-submit verification failed (verify=${verify.passed}, upload=${upload.verified}, fillErrors=${fill.errors.length}; open_items=${operatorBrief.fail_count})`,
            );
            failIdempotencyKey(db, idemKey, "verify_failed");
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: "pre-submit verification failed",
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.reason =
              "Refusing to click submit: field verification or upload did not pass";
            report.operator_brief = operatorBrief;
            return persist(report);
          }

          // Required-completeness gate: the run data's #1 real failure was
          // clicking Submit with required screener/essay questions untouched
          // (client-side validation bounced it; the run ended UNCERTAIN).
          // Scan the live page and refuse BEFORE the click, naming each
          // unanswered question — no budget spent, precise review item.
          // G2: the board's own schema is a third requiredness source —
          // Greenhouse publishes `required` per question, and a control the
          // DOM heuristics saw as optional still blocks the click when the
          // board says it is required. Read-only, memoized (the plan-time
          // fetch already paid the round-trip), fail-open: null ⇒ the DOM
          // heuristics carry the load unchanged.
          const declaredQuestions = await fetchGreenhouseQuestions(
            page.url(),
          ).catch(() => null);
          const completeness = await scanRequiredCompleteness(page, {
            declaredRequired: requiredQuestionLabels(declaredQuestions),
          });
          if (completeness.unanswered.length > 0) {
            const names = completeness.unanswered
              .map(
                (u) =>
                  `${u.label} [${u.control}${
                    u.source === "board_api" ? ", required per board API" : ""
                  }]`,
              )
              .join("; ");
            markSubmissionFailed(
              db,
              pending.id,
              `required questions unanswered: ${names}`,
            );
            failIdempotencyKey(db, idemKey, "required_incomplete");
            const { item } = upsertOpenReviewItem(db, {
              applicationId,
              kind: "MANUAL",
              title: `${completeness.unanswered.length} required question(s) unanswered — answer via screeners.json/essay workflow, then requeue`,
              payload: {
                ats: binding.id,
                unanswered: completeness.unanswered,
              },
            });
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: "required questions unanswered — click withheld",
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.review_item_id = item.id;
            report.reason = `Refusing to click submit: ${completeness.unanswered.length} required question(s) unanswered — ${names}`;
            return persist(report);
          }
          if (completeness.notes.length > 0) {
            // Scan failed open — proceed, but the report says so.
            report.reason = completeness.notes.join("; ");
          }

          let attempt = await binding.submit(page, clickGate);
          {
            const parsed = parseSubmitNotes(attempt.notes);
            submitTelemetry.via = parsed.via;
            submitTelemetry.ctaInventoryCount = parsed.ctaInventoryCount;
            submitTelemetry.clicked = attempt.clicked;
            submitTelemetry.capHit = unattendedCapHit;
          }
          if (
            !attempt.clicked &&
            attempt.notes.some((n) => /disabled/i.test(n))
          ) {
            // Name the cause instead of the old opaque "submit control
            // disabled": verification walls, invalid required fields,
            // visible errors. One recovery attempt when it is an email
            // verification code and a mailbox provider is enabled.
            const diagnosis = await diagnoseDisabledSubmit(page);
            attempt.notes.push(`diagnosis: ${diagnosis.summary}`);
            const fetchCode =
              input.fetchVerificationCode ?? resolveVerificationCodeProvider();
            if (diagnosis.verification.detected && fetchCode) {
              const recovery = await recoverEmailVerification(page, diagnosis, {
                fetchCode,
                submitSelector: binding.submitSelector,
                requestedAt: runStartedAt,
              });
              attempt.notes.push(...recovery.notes);
              if (recovery.submitEnabled) {
                attempt = await binding.submit(page, clickGate);
                attempt.notes.unshift("submit retried after email verification");
                submitTelemetry.recoveryUsed = true;
                submitTelemetry.clicked = attempt.clicked;
                submitTelemetry.capHit = unattendedCapHit;
              }
            } else if (diagnosis.verification.detected) {
              attempt.notes.push(
                "no mailbox provider enabled (OUTLOOK_VERIFICATION_ENABLED / GMAIL_VERIFICATION_ENABLED) — cannot fetch the code",
              );
            }
          }
          if (!attempt.clicked && unattendedCapHit) {
            markSubmissionFailed(db, pending.id, "unattended cap reached at click time");
            failIdempotencyKey(db, idemKey, "unattended_cap");
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: "unattended cap reached at click time — filled and verified, click withheld",
              runId,
            });
            report.outcome = "REFUSED";
            report.reason = `MAX_UNATTENDED_SUBMISSIONS_PER_RUN cap reached (${cfg.maxUnattendedSubmissionsPerRun}) — click withheld after successful fill+verify`;
            return persist(report);
          }
          if (!attempt.clicked) {
            const reason = attempt.notes.join("; ");
            markSubmissionFailed(db, pending.id, reason);
            failIdempotencyKey(db, idemKey, "not_clicked");
            if (/verification code required/i.test(reason)) {
              upsertOpenReviewItem(db, {
                applicationId,
                kind: "AUTH_REQUIRED",
                title: "Employer form requires an email verification code",
                payload: {
                  ats: binding.id,
                  notes: attempt.notes,
                },
              });
            }
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: `submit control not clicked: ${reason}`,
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.reason = reason;
            return persist(report);
          }

          // Click happened — from here every path is VERIFIED or UNCERTAIN.
          try {
            const receipt = await binding.verifySubmission(page, {
              screenshotPath,
            });
            markSubmissionVerified(db, pending.id, receipt);
            completeIdempotencyKey(db, idemKey, pending.id);
            transitionApplication(db, {
              applicationId,
              nextState: "SUBMITTED",
              reason: "receipt verified",
              runId,
              artifacts: [receipt.screenshot_path],
            });
            report.outcome = "SUBMITTED_VERIFIED";
            report.receipt = receipt;
            report.reason = receipt.confirmation_text;
            return persist(report);
          } catch (err) {
            // Definitive on-page refusal (live 2026-08-30, Ashby spam flag on
            // 23d64c04): the page itself says the application was NOT
            // submitted. Record the failure and requeue-able state instead
            // of an UNCERTAIN park that only the operator can resolve.
            // Likewise a form that is STILL RENDERED with a visible
            // validation message (Ashby "Missing entry for required field:
            // Complete the Takehome", job #3 tonight): the POST never
            // happened. FAILED_RETRYABLE + an "Answer needed" item naming
            // the field, so the next attempt is a decision, not a replay.
            const stillOnFormWithError =
              err instanceof SubmissionUncertainError &&
              err.evidence["classification"] === "still_on_form" &&
              typeof err.evidence["validation_error"] === "string" &&
              (err.evidence["validation_error"] as string).length > 0;
            if (
              err instanceof SubmissionUncertainError &&
              (err.evidence["classification"] === "rejected" || stillOnFormWithError)
            ) {
              const refusal =
                typeof err.evidence["validation_error"] === "string"
                  ? (err.evidence["validation_error"] as string)
                  : err.message;
              if (stillOnFormWithError) {
                upsertOpenReviewItem(db, {
                  applicationId,
                  kind: "MANUAL",
                  title: `Answer needed: form refused the click — ${refusal.slice(0, 100)}`,
                  payload: {
                    validation_error: refusal,
                    final_url: err.evidence["final_url"] ?? null,
                    screenshot_path: screenshotPath,
                    submission_id: pending.id,
                  },
                });
              }
              markSubmissionFailed(db, pending.id, `rejected after click: ${refusal}`);
              failIdempotencyKey(db, idemKey, "rejected_after_click");
              transitionApplication(db, {
                applicationId,
                nextState: "FAILED_RETRYABLE",
                reason: `submission rejected by the form after click: ${refusal}`,
                runId,
                artifacts: [screenshotPath],
              });
              logger.warn("submission rejected on-page after click", {
                service: "submission",
                action: "post_click_rejected",
                application_id: applicationId,
                metadata: { refusal, final_url: err.evidence["final_url"] ?? null },
              });
              report.outcome = "REJECTED_AFTER_CLICK";
              report.reason = `Submission rejected by the form after click: ${refusal}`;
              return persist(report);
            }
            // Post-click emailed-code wall (live 2026-08-29, Greenhouse
            // "security code": the click leaves the FORM on-page waiting for
            // an 8-char code mailed to the candidate — the confirmation
            // classifier reads "unknown" and two real submissions parked
            // UNCERTAIN). When the inconclusive page names a code wall and a
            // mailbox provider is enabled, make exactly ONE recovery pass:
            // fetch the code, type it, re-click the same gated submit, and
            // re-verify. Anything short of a verified receipt falls through
            // to the unchanged UNCERTAIN path.
            if (
              err instanceof SubmissionUncertainError &&
              !submitTelemetry.recoveryUsed
            ) {
              const fetchCode =
                input.fetchVerificationCode ?? resolveVerificationCodeProvider();
              if (!fetchCode) {
                // Name the skip — live 2026-08-29 the recovery silently
                // never ran for 5 clicks and the cause was unfindable
                // from artifacts alone.
                logger.warn(
                  "post-click code recovery skipped: no mailbox provider available",
                  {
                    service: "submission",
                    action: "post_click_code_recovery_skip",
                    application_id: applicationId,
                  },
                );
              }
              if (fetchCode) {
                const diagnosis = await diagnoseDisabledSubmit(page).catch(
                  () => null,
                );
                if (!diagnosis?.verification.detected) {
                  logger.warn(
                    "post-click code recovery skipped: no verification input detected on the inconclusive page",
                    {
                      service: "submission",
                      action: "post_click_code_recovery_skip",
                      application_id: applicationId,
                      metadata: {
                        summary: diagnosis?.summary ?? "(diagnosis failed)",
                      },
                    },
                  );
                }
                if (diagnosis?.verification.detected) {
                  logger.info(
                    "post-click emailed-code wall — attempting verification-code recovery",
                    {
                      service: "submission",
                      action: "post_click_code_recovery",
                      application_id: applicationId,
                      metadata: { summary: diagnosis.summary },
                    },
                  );
                  // The click already happened: nothing thrown from here
                  // may reach the outer "failure before the click" catch
                  // (live 2026-08-30: an Outlook session error recorded a
                  // real post-click run as FAILED_BEFORE_CLICK).
                  try {
                  const recovery = await recoverEmailVerification(
                    page,
                    diagnosis,
                    {
                      fetchCode,
                      submitSelector: binding.submitSelector,
                      requestedAt: runStartedAt,
                    },
                  );
                  if (recovery.entered) {
                    const retry = await binding.submit(page, clickGate);
                    submitTelemetry.recoveryUsed = true;
                    if (retry.clicked) {
                      try {
                        const receipt = await binding.verifySubmission(page, {
                          screenshotPath,
                        });
                        markSubmissionVerified(db, pending.id, receipt);
                        completeIdempotencyKey(db, idemKey, pending.id);
                        transitionApplication(db, {
                          applicationId,
                          nextState: "SUBMITTED",
                          reason: "receipt verified after emailed-code recovery",
                          runId,
                          artifacts: [receipt.screenshot_path],
                        });
                        report.outcome = "SUBMITTED_VERIFIED";
                        report.receipt = receipt;
                        report.reason = receipt.confirmation_text;
                        return persist(report);
                      } catch {
                        // Still inconclusive — fall through to UNCERTAIN.
                      }
                    }
                  }
                  } catch (recoveryErr) {
                    logger.warn("post-click code recovery threw — parking UNCERTAIN", {
                      service: "submission",
                      action: "post_click_code_recovery_error",
                      application_id: applicationId,
                      metadata: {
                        reason:
                          recoveryErr instanceof Error
                            ? recoveryErr.message.slice(0, 200)
                            : String(recoveryErr),
                      },
                    });
                  }
                }
              }
            }
            const evidence =
              err instanceof SubmissionUncertainError
                ? err.evidence
                : { error: err instanceof Error ? err.message : String(err) };
            markSubmissionUncertain(db, pending.id, evidence);
            markIdempotencyUncertain(
              db,
              idemKey,
              "post-click verification inconclusive",
            );
            const { item } = upsertOpenReviewItem(db, {
              applicationId,
              kind: "UNCERTAIN_SUBMISSION",
              title: "Submission clicked but not verified",
              payload: { ...evidence, submission_id: pending.id },
            });
            transitionApplication(db, {
              applicationId,
              nextState: "SUBMISSION_VERIFICATION_FAILED",
              reason: "post-click verification inconclusive",
              runId,
            });
            report.outcome = "UNCERTAIN";
            report.review_item_id = item.id;
            report.reason =
              err instanceof Error ? err.message : "verification inconclusive";
            return persist(report);
          }
        } catch (err) {
          // Failure before the click (fill/upload/verify machinery threw).
          markSubmissionFailed(
            db,
            pending.id,
            err instanceof Error ? err.message : String(err),
          );
          failIdempotencyKey(db, idemKey, "exception_before_click");
          transitionApplication(db, {
            applicationId,
            nextState: "FAILED_RETRYABLE",
            reason: `submit run error before click: ${err instanceof Error ? err.message : String(err)}`,
            runId,
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = err instanceof Error ? err.message : String(err);
          return persist(report);
        }
    };
    if (input.existingPage) {
      return await runOnPage(input.existingPage);
    }
    return await withPublicUrlPage(
      detected.normalizedUrl,
      runOnPage,
      {
        headless: input.headless ?? false,
        channel: resolveBrowserChannel(),
        ...(cfg.navigationEnabled ? { cdpUrl: cfg.agentCdpUrl } : {}),
      },
    );
  } finally {
    releaseLease(db, {
      resourceType: "application",
      resourceId: `${applicationId}:submit`,
      holderRunId: runId,
    });
  }

  function persist(r: SubmissionRunReport): SubmissionRunReport {
    const dirs = ensureApplicationArtifactDirs(r.application_id);
    const out = path.join(
      dirs.root,
      "submission",
      `submit-run-${r.attempt ?? 0}-${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeJsonAtomic(out, redactObject(r as unknown as Record<string, unknown>));
    r.artifact_path = out;
    // Telemetry row (fail-open): joins artifact + logs + arm row on run_id.
    recordSubmitAttempt(
      {
        runId,
        applicationId: r.application_id,
        submissionId: r.submission_id,
        ats: detected.ats ?? "unknown",
        outcome: r.outcome,
        clicked: submitTelemetry.clicked,
        controlResolvedVia: submitTelemetry.via,
        capHitAtClick: submitTelemetry.capHit,
        verifyRecoveryUsed: submitTelemetry.recoveryUsed,
        urlHost: (() => {
          try {
            return employerUrl ? new URL(employerUrl).hostname : null;
          } catch {
            return null;
          }
        })(),
        reason: r.reason,
        ctaInventoryCount: submitTelemetry.ctaInventoryCount,
        durationMs: Date.now() - startedMs,
        reportArtifactRelpath: r.artifact_path,
      },
      { db },
    );
    logger.info("submission run finished", {
      service: detected.ats ?? "unknown",
      action: "submit_run",
      metadata: {
        application_id: r.application_id,
        outcome: r.outcome,
        attempt: r.attempt,
      },
    });
    return r;
  }
}

/** @deprecated Renamed — the run dispatches per ATS now. Kept for existing callers/tests. */
export const runGreenhouseSubmission = runAtsSubmission;
