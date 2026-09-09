import type { Db } from "../storage/db/client.js";
import { dismissPageObstructions } from "../browser/obstructions.js";
import {
  authenticateAtsPortal,
  isRecognizedAtsAuthHost,
} from "../verification/portalAuth.js";
import { classifyWorkdayPage } from "../ats/workday/pageKind.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { closeWorkdayHeaderMenus } from "../ats/workday/fill.js";
import { readPageValidationErrors } from "./pageErrors.js";
import { walkWorkdayWizard } from "./workdayWizard.js";
import {
  walkGenericFormPages,
  walkSectionEditors,
} from "./genericFormAdvance.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import { scrubHtmlForSnapshot } from "./htmlScrub.js";
import {
  attemptExtensionAutofill,
  type ExtensionActivationResult,
} from "../jobright/extension/autofill.js";
import { writeFillTrace, type FillTraceEvent } from "../storage/fillTrace.js";
import path from "node:path";
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { recordFillRun } from "../storage/fillOutcomes.js";
import { redactFillReportForArtifact } from "./fillReportRedaction.js";
import { assertFormFillAllowed, assertSubmitAllowed } from "./formFillGuards.js";
import {
  defaultTtyConfirm,
  type ConfirmSubmission,
} from "./submitConfirmation.js";
import { scanRequiredCompleteness } from "../ats/shared/requiredCompleteness.js";
import { SubmissionUncertainError } from "../ats/shared/submissionUncertain.js";
import { isLoopbackUrl } from "../ats/generic/urlValidation.js";
import { planApplicationFill } from "./applicationFiller.js";
import { postSandboxTrace } from "../sandbox/trace.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { ATS_BINDINGS, type AtsBinding } from "./atsBindings.js";
import { findApplicationFrameUrl } from "../ats/shared/frameHop.js";
import { inventoryFileInputs } from "../ats/shared/uploadResolve.js";
import { advancePastPosting } from "../ats/shared/postingAdvance.js";
import { expandCollapsedSections } from "../ats/shared/sectionExpand.js";
import { genericSelectorsV1 } from "../ats/generic/selectors.js";
import {
  extractPostingContext,
  mergePostingContext,
} from "./essayAutofill.js";
import {
  classifyPage,
  classifyWithFrameFallback,
  sameOriginFrames,
} from "../ats/shared/pageClassify.js";
import {
  fetchGreenhouseQuestions,
  requiredQuestionLabels,
} from "../ats/greenhouse/questionsApi.js";
import {
  diffDeclaredVsDom,
  summarizeSchemaDiff,
} from "../ats/greenhouse/schemaDiff.js";
import { detectBlockingCaptcha } from "../ats/greenhouse/captchaDetection.js";
import {
  buildCaptchaIncident,
  pauseForHumanCaptcha,
} from "../ats/shared/captchaPause.js";
import {
  harvestFieldOptions,
  mergeDeclaredQuestions,
  type AnswerSpace,
  type OptionHarvestResult,
} from "../ats/shared/optionHarvest.js";
import {
  fillOtherSpecify,
  type OtherSpecifyOutcome,
} from "../ats/shared/otherSpecify.js";
import {
  withFixtureHtmlPage,
  withPublicUrlPage,
} from "../browser/fixtureSession.js";
import { resolveBrowserChannel } from "../browser/launchOptions.js";
import { detectAtsHandoff } from "../ats/shared/atsHandoff.js";
import type { Page } from "playwright";
import { verifyResumePdfFile } from "../jobright/resumeDownload.js";
import { attachSupplementalMaterials } from "../ats/shared/supplementalMaterials.js";
import type { PublicProfile } from "../candidate/publicProfile.js";
import type {
  FillResult,
  FormVerificationResult,
  SubmissionReceipt,
  UploadVerification,
} from "../ats/adapter.js";
import {
  buildOperatorFieldBrief,
  printOperatorFieldBrief,
} from "./operatorFieldBrief.js";
import type { ApprovedFillPlan } from "./approvedFillPlan.js";
import { fillRevealedProfileSelects } from "../ats/shared/dependentSelects.js";
import { readLiveHtml } from "../browser/liveHtml.js";
import { superviseApplicationNavigation, type SupervisorReport } from "../navigation/applicationSupervisor.js";
import { buildSupervisorJobContext } from "../navigation/supervisorContext.js";
import type { EmailLlmClient } from "../contacts/emailLlm.js";

/**
 * #149: one deterministic pass over selects the fill itself revealed
 * (Country → State/Province). Verified picks join the filled list so the
 * artifact records what the employer received; every note is kept.
 */
async function sweepRevealedSelects(
  page: Page,
  report: { fill: FillResult | null; notes: string[] },
  profile?: PublicProfile,
): Promise<void> {
  const revealed = await fillRevealedProfileSelects({
    page,
    ...(profile ? { profile } : {}),
  }).catch((err: unknown) => ({
    outcomes: [],
    notes: [
      `revealed-select: pass failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
    ],
  }));
  report.notes.push(...revealed.notes);
  const verified = revealed.outcomes.filter((o) => o.verified);
  if (verified.length > 0 && report.fill) {
    report.fill = {
      ...report.fill,
      filled: [...report.fill.filled, ...verified.map((o) => o.canonical_field)],
    };
  }
}

async function attemptSandboxSubmit(args: {
  page: Page;
  binding: AtsBinding;
  report: AtsLiveFillReport;
  approvedPlan: ApprovedFillPlan;
  /** G2: labels the board's own schema declares required (fail-open []). */
  declaredRequired?: string[];
  assumeYes?: boolean;
  confirmSubmission?: ConfirmSubmission;
}): Promise<void> {
  const { page, binding, report, approvedPlan } = args;
  const notes: string[] = [];
  const refuse = (
    outcome: NonNullable<AtsLiveFillReport["submit"]>["outcome"],
    reason: string,
  ) => {
    notes.push(reason);
    report.notes.push(reason);
    report.submit = { outcome, clicked: false, receipt: null, notes: [...notes] };
  };

  if (!isLoopbackUrl(report.url) && !isLoopbackUrl(page.url())) {
    refuse(
      "refused",
      "submit refused — ats:fill --submit is sandbox/loopback only; use `submit --application` for an employer",
    );
    return;
  }
  if (!report.verify?.passed || (report.fill?.errors.length ?? 0) > 0) {
    refuse("failed_before_click", "submit withheld — fill verify did not pass");
    return;
  }

  assertSubmitAllowed(`atsLiveFill.${binding.id}.submit`);

  const completeness = await scanRequiredCompleteness(page, {
    declaredRequired: args.declaredRequired ?? [],
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
    refuse(
      "failed_before_click",
      `submit withheld — ${completeness.unanswered.length} required question(s) unanswered: ${names}`,
    );
    return;
  }
  notes.push(...completeness.notes);

  const cfg = getConfig();
  if (cfg.submitRequiresLocalConfirmation) {
    const confirm = args.confirmSubmission ?? defaultTtyConfirm();
    const approved = await confirm({
      application_id: "sandbox",
      company: "employer sandbox",
      role: null,
      url: page.url(),
      attempt: 1,
      resume_sha256: "0".repeat(64),
      resume_size_bytes: 0,
      plan: {
        fillable_count: approvedPlan.fillable_count,
        skipped_count: approvedPlan.skipped_count,
        review_required_count: approvedPlan.review_required_count,
      },
    });
    if (!approved) {
      refuse("refused", "submit withheld — operator declined confirmation");
      return;
    }
  } else if (!args.assumeYes) {
    refuse(
      "refused",
      "submit withheld — unattended sandbox submit requires --yes",
    );
    return;
  }

  const attempt = await binding.submit(page);
  notes.push(...attempt.notes);
  report.submit_attempted = attempt.clicked;
  if (!attempt.clicked) {
    report.submit = {
      outcome: "failed_before_click",
      clicked: false,
      receipt: null,
      notes,
    };
    report.notes.push("submit control was not clicked");
    return;
  }

  const screenshotPath = path.join(
    cfg.artifactsDir,
    "ats-submit",
    binding.id,
    `sandbox-receipt-${Date.now()}.png`,
  );
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  try {
    const receipt = await binding.verifySubmission(page, { screenshotPath });
    report.submit = { outcome: "confirmed", clicked: true, receipt, notes };
    report.notes.push(
      `submit confirmed: ${receipt.confirmation_text} (${receipt.confirmation_url})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const evidence =
      err instanceof SubmissionUncertainError ? err.evidence : undefined;
    report.submit = {
      outcome: "uncertain",
      clicked: true,
      receipt: null,
      notes: [
        ...notes,
        message,
        ...(evidence ? [`evidence: ${JSON.stringify(evidence)}`] : []),
      ],
    };
    report.notes.push(`submit uncertain: ${message}`);
    report.validation_level = "UNVERIFIED";
  }
  await postSandboxTrace(report.url, {
    kind: "submit",
    lines: [
      `submit: ${report.submit?.outcome ?? "unknown"}`,
      ...(report.submit?.notes ?? []).map((n) => `  ${n}`),
    ],
  });
}

function briefPlanEntries(approvedPlan: ApprovedFillPlan) {
  return approvedPlan.entries.map((e) => ({
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
  }));
}

/**
 * Resume for a live fill. `--resume` always wins. On loopback only, a
 * missing flag falls back to DEFAULT_RESUME_PATH when that file exists —
 * so a sandbox run exercises the upload path. A real employer URL never
 * gets a silent attach.
 */
export function resolveLiveFillResumePath(input: {
  url: string;
  explicitResumePath?: string;
  defaultResumePath: string;
  fileExists?: (p: string) => boolean;
}): { path: string; source: "flag" | "sandbox_default" } | null {
  if (input.explicitResumePath) {
    return { path: input.explicitResumePath, source: "flag" };
  }
  if (!isLoopbackUrl(input.url)) return null;
  const exists = input.fileExists ?? ((p) => fs.existsSync(p));
  if (!exists(input.defaultResumePath)) return null;
  return { path: input.defaultResumePath, source: "sandbox_default" };
}

/**
 * Shared guarded live fill for the non-greenhouse ATSes (lever/ashby).
 * Greenhouse keeps its own runGreenhouseLiveFill (full identity
 * verification, healer, essay path); this runner uses the binding's weaker
 * pre-mutation gate — see preMutationGate.ts. Submit is opt-in and
 * loopback-only (`--submit` + SUBMIT_ENABLED): a real employer URL still
 * never clicks Submit here. Use `submit --application` for that.
 *
 * Validation-ladder honesty: plan_only runs are LIVE_READ_ONLY_CONFIRMED at
 * most; executed runs are LIVE_MUTATION_CONFIRMED only when the read-back
 * verify passed, else UNVERIFIED. Nothing here promotes a synthetic-fixture
 * claim — a green run against a real page IS the live evidence.
 */
export type AtsLiveFillReport = {
  ats: string;
  url: string;
  requested_url: string;
  mode: "refused" | "plan_only" | "executed";
  /** Apply landed on another recognised ATS; the pipeline re-detects from this URL. */
  handoff?: { ats: string; url: string } | null;
  gate: {
    ok: boolean;
    failure_code: string | null;
    reason: string | null;
    final_url: string | null;
    /** classifyPage result — recovery branches on this, not the collapsed gate code. */
    page_class?: string | null;
  };
  plan_summary: {
    fillable_count: number;
    skipped_count: number;
    review_required_count: number;
  } | null;
  /**
   * Every plan entry's label + routing — values excluded. Exists because a
   * live run once reported "10 skipped" with no way to tell WHICH questions
   * the plan missed; blind counts made the bug undiagnosable. Labels are
   * the form's own question text, not candidate data.
   */
  plan_fields: Array<{
    field_id: string;
    label: string;
    type: string;
    canonical_field: string | null;
    action: string;
    reason: string;
  }> | null;
  /** Sanitized pre-fill page HTML, written when the plan skipped fields. */
  form_snapshot_path: string | null;
  /**
   * The answer space scraped off each live control before planning. This
   * is the evidence that separates "the system chose badly" from "the
   * system never saw the choices" — the distinction the Appian run could
   * not be diagnosed without.
   */
  harvested_options?: Array<{
    field_id: string;
    label: string;
    answer_space: AnswerSpace;
    option_count: number;
    options: string[];
    other_option: string | null;
  }>;
  /** Text boxes revealed by choosing "Other", and what went into them. */
  other_specify?: OtherSpecifyOutcome[];
  /**
   * G3: reconciliation between the DOM discovery and the board's declared
   * schema — which declared questions never matched a DOM field, which DOM
   * fields the schema doesn't declare, and where two real option lists
   * disagree. Present only when the board API answered.
   */
  schema_diff?: import("../ats/greenhouse/schemaDiff.js").SchemaDiff;
  /** C2: classed record of a blocking-CAPTCHA hit (host + provider, no candidate data). */
  captcha_incident?: import("../ats/shared/captchaPause.js").CaptchaIncident;
  /**
   * Extension-first activation outcome (X2): whether JobRight's extension
   * was triggered, whether the form changed, and which planned answers it
   * satisfied (those fields were left alone by the native gap-fill).
   */
  extension?: ExtensionActivationResult & { satisfied_answers: string[] };
  fill: FillResult | null;
  verify: FormVerificationResult | null;
  uploads: UploadVerification[] | null;
  validation_level:
    | "LIVE_MUTATION_CONFIRMED"
    | "LIVE_READ_ONLY_CONFIRMED"
    | "UNVERIFIED";
  submit_attempted: boolean;
  submit?: {
    outcome: "confirmed" | "uncertain" | "refused" | "failed_before_click";
    clicked: boolean;
    receipt: SubmissionReceipt | null;
    notes: string[];
  };
  /**
   * Extra form pages walked BEYOND the landing page (Workday Next, or
   * generic Continue/Next). Bounded; the submit button is never clicked
   * here. Absent for single-page fills.
   */
  wizard_pages?: Array<{
    page: number;
    url: string;
    kind: string;
    fillable: number;
    filled: number;
    verify_passed: boolean;
  }>;
  notes: string[];
  report_path?: string;
  navigation_supervisor?: SupervisorReport;
  /** Built when fill/verify/uploads need operator attention. */
  operator_brief?: import("./operatorFieldBrief.js").OperatorFieldBrief;
};

type BindingGate = {
  ok: boolean;
  html: string;
  finalUrl: string;
  failureCode?: string | null;
  reason?: string | null;
};

function applyGateToReport(
  report: AtsLiveFillReport,
  gate: BindingGate,
): ReturnType<typeof classifyPage> {
  const landing = classifyPage({ html: gate.html, url: gate.finalUrl });
  report.gate = {
    ok: gate.ok,
    failure_code: gate.failureCode ?? null,
    reason: gate.reason ?? null,
    final_url: gate.finalUrl,
    page_class: landing.page_class,
  };
  return landing;
}

const TERMINAL_GATE_CODES = new Set([
  "UNTRUSTED_FINAL_HOST",
  "POSTING_MISMATCH",
  "BLOCKING_CAPTCHA",
  "ATS_MISMATCH",
  "UNSAFE_URL",
]);

export async function runAtsLiveFill(input: {
  binding: AtsBinding;
  url: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  headless?: boolean;
  /** Forwarded to planApplicationFill: unanswered questions become "Answer needed" review items on this application. */
  capture?: { db: Db; applicationId: string | null };
  /**
   * Test seam (liveInspect precedent): serve this HTML at the normalized
   * URL instead of navigating the network. Any resulting validation level
   * is demoted — a fixture-served page is never live evidence.
   */
  fixtureHtml?: string;
  /** Fixture-only model seam; capability checks still run. */
  supervisorClient?: EmailLlmClient;
  /**
   * X2: activate the JobRight extension before planning and fill only the
   * gap it leaves. Requires execute + JOBRIGHT_AUTOFILL_ENABLED + promoted
   * trigger selectors; anything missing degrades to a full native fill.
   */
  extensionFirst?: boolean;
  /** Test seam: overrides the registry's trigger selectors (fixtures). */
  extensionTriggerSelectors?: string[];
  /**
   * Session handoff (nav N6): run on this page — typically a CDP-attached
   * page whose cookies survive from navigation. The caller owns its
   * lifetime; this runner navigates it but never closes it.
   */
  existingPage?: Page;
  /** Transfer a popup form to the caller's same-run submit session. */
  onPageChanged?: (page: Page) => void;
  /**
   * Click Submit after a passing verify. Refused unless the URL is
   * loopback (employer sandbox). Still requires SUBMIT_ENABLED and the
   * same confirmation seam as `submit --application`.
   */
  submit?: boolean;
  /** Honored only when SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false. */
  assumeYes?: boolean;
  confirmSubmission?: ConfirmSubmission;
}): Promise<AtsLiveFillReport> {
  // Mutable: the iframe hop can re-detect a different vendor's adapter for
  // the embedded form (e.g. company page → embedded Greenhouse board).
  let binding = input.binding;
  const report: AtsLiveFillReport = {
    ats: binding.id,
    url: input.url,
    requested_url: input.url,
    mode: "refused",
    gate: { ok: false, failure_code: null, reason: null, final_url: null },
    plan_summary: null,
    plan_fields: null,
    form_snapshot_path: null,
    fill: null,
    verify: null,
    uploads: null,
    validation_level: "UNVERIFIED",
    submit_attempted: false,
    notes: [],
  };

  const detected = detectAtsFromUrl(input.url);
  if (detected.ats === null) {
    report.gate.reason = detected.failureReason;
    report.gate.failure_code = "UNSAFE_URL";
    return persist(report);
  }
  if (detected.ats !== binding.id) {
    report.gate.failure_code = "ATS_MISMATCH";
    report.gate.reason = `URL validated as ${detected.ats}, binding is ${binding.id}`;
    return persist(report);
  }
  report.url = detected.normalizedUrl;

  if (input.resumePath) {
    const preflight = verifyResumePdfFile(input.resumePath);
    if (!preflight.verified) {
      report.gate.failure_code = "RESUME_PREFLIGHT_FAILED";
      report.gate.reason = `resume preflight failed: ${preflight.evidence}`;
      return persist(report);
    }
  }

  const runInPage = async (
    fn: (page: Page) => Promise<AtsLiveFillReport>,
  ): Promise<AtsLiveFillReport> => {
    if (input.existingPage) {
      const page = input.existingPage;
      report.notes.push("session: handoff (caller-owned page, not closed here)");
      await page.goto(detected.normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return fn(page);
    }
    if (input.fixtureHtml !== undefined) {
      const html = input.fixtureHtml;
      return withFixtureHtmlPage("<html><body></body></html>", async (page) => {
        await page.route("**/*", (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
        await page.goto(detected.normalizedUrl, {
          waitUntil: "domcontentloaded",
        });
        return fn(page);
      });
    }
    return withPublicUrlPage(detected.normalizedUrl, fn, {
      headless: input.headless ?? true,
      channel: resolveBrowserChannel(),
      ...(getConfig().navigationEnabled ? { cdpUrl: getConfig().agentCdpUrl } : {}),
    });
  };

  // Read-only page fetch is allowed without flags; mutation asserts below.
  return runInPage(
    async (page) => {
      let gate = await binding.gate(page, input.url, detected.normalizedUrl);
      if (input.execute && !TERMINAL_GATE_CODES.has(gate.failureCode ?? "") &&
          classifyPage({ html: gate.html, url: gate.finalUrl }).page_class !== "form") {
        // Full job context (posting details + prior nav attempts/events),
        // not just {company, role}: the supervisor's navigation decisions
        // are only as good as what it can see (operator directive 2026-09-07).
        const job = input.capture?.applicationId
          ? buildSupervisorJobContext(input.capture.db, input.capture.applicationId, input.url)
          : { url: input.url };
        const supervised = await superviseApplicationNavigation({ page, job,
          ...(input.supervisorClient ? { client: input.supervisorClient } : {}),
        });
        if (supervised.report.outcome !== "disabled") {
          report.navigation_supervisor = supervised.report;
          report.notes.push(`navigation supervisor: ${supervised.report.outcome} (${supervised.report.steps.length} steps)`);
          page = supervised.page;
          input.onPageChanged?.(page);
          const handoff = detectAtsHandoff(binding.id, page.url());
          if (handoff) {
            report.handoff = handoff;
            report.gate.ok = false;
            report.gate.failure_code = "ATS_HANDOFF";
            report.gate.reason = `navigation supervisor landed on ${handoff.ats} (${handoff.url}) — handing off to the ${handoff.ats} adapter`;
            report.gate.final_url = page.url();
            report.notes.push(
              `ATS handoff: ${binding.id} → ${handoff.ats} at ${handoff.url}`,
            );
            return persist(report);
          }
          gate = await binding.gate(page, input.url, detected.normalizedUrl);
          if (supervised.report.outcome !== "form_ready") {
            // #219 (operator 2026-09-09 20:29 UTC: "you should be able to
            // submit Workday and account-registration walls — you have an
            // email and password in env and can read the verification
            // mail"): a supervisor that stops ON an auth wall (Two Sigma's
            // /careers/Register, Peraton's jibeapply sign-up) is not
            // navigation failure — it found the wall. Fall through to the
            // page-class decision below, where auth → portal auth (create /
            // sign in, mailbox verification) exactly as a direct landing
            // would. Only a non-auth stop is NAVIGATION_INCOMPLETE.
            const stoppedOn = classifyPage({ html: gate.html, url: gate.finalUrl }).page_class;
            if (stoppedOn === "auth" || gate.failureCode === "LOGIN_WALL") {
              report.notes.push(
                `navigation supervisor stopped on an auth wall (${gate.finalUrl.slice(0, 100)}) — handing to portal auth (#219)`,
              );
            } else {
              applyGateToReport(report, gate);
              report.gate.ok = false;
              report.gate.failure_code = "NAVIGATION_INCOMPLETE";
              report.gate.reason = supervised.report.notes.join("; ") || "navigation supervisor did not reach an applicant form";
              return persist(report);
            }
          }
        }
      }
      // Employer/role text from every page-level hop, captured BEFORE the
      // page is navigated away: the iframe outer shell and the posting
      // page usually name the company; the form page often does not
      // (fillhard's embed is just "Application"). Essays ground on this.
      const postingTrail: string[] = [extractPostingContext(gate.html)];
      // Iframe hop: a page whose FORM lives in an iframe discovers zero
      // fields (page.content() excludes frames). Trigger on that fact,
      // not on a collapsed gate code — after page_class recovery a
      // zero-field shell is UNKNOWN_LANDING, not always NO_APPLICATION_FORM.
      if (discoverFieldsFromHtml(gate.html).length === 0) {
        const frameForm = await findApplicationFrameUrl(page);
        if (frameForm) {
          report.notes.push(
            `application form found in an iframe (${frameForm.fieldCount} fields) — hopping to ${frameForm.url}`,
          );
          await page
            .goto(frameForm.url, { waitUntil: "domcontentloaded" })
            .catch((e: Error) =>
              report.notes.push(`iframe hop navigation failed: ${e.message.slice(0, 120)}`),
            );
          const hopDetected = detectAtsFromUrl(frameForm.url);
          if (hopDetected.ats !== null && hopDetected.ats !== binding.id) {
            report.notes.push(
              `iframe hop: adapter ${binding.id} → ${hopDetected.ats}`,
            );
            binding = ATS_BINDINGS[hopDetected.ats];
            report.ats = binding.id;
          }
          gate = await binding.gate(page, frameForm.url, frameForm.url);
        }
      }
      let landing = applyGateToReport(report, gate);
      report.notes.push(
        `page class at gate: ${landing.page_class} (${landing.evidence})`,
      );
      if (binding.id === "workday") {
        report.notes.push(
          `workday page kind at gate: ${classifyWorkdayPage(gate.html)}`,
        );
      }

      // C2: a blocking CAPTCHA on a HEADED run pauses in place first —
      // the operator is looking at the challenge; a bounded wait beats a
      // park + requeue round-trip. Unattended (headless) never pauses.
      // Every hit is recorded as a classed incident either way.
      if (!gate.ok && gate.failureCode === "BLOCKING_CAPTCHA") {
        const fieldCount = discoverFieldsFromHtml(gate.html).length;
        const detection = detectBlockingCaptcha({
          finalUrl: gate.finalUrl,
          html: gate.html,
          formDetected: fieldCount > 0,
          fieldCount,
        });
        const pause = await pauseForHumanCaptcha(page, {
          attended: input.headless === false && !input.fixtureHtml,
        });
        report.captcha_incident = buildCaptchaIncident({
          surface: `ats_live_fill:${binding.id}`,
          url: gate.finalUrl,
          signals: detection.signals,
          pause,
        });
        report.notes.push(...pause.notes);
        if (pause.cleared) {
          gate = await binding.gate(page, input.url, detected.normalizedUrl);
          landing = applyGateToReport(report, gate);
          report.notes.push(
            `page class after captcha clearance: ${landing.page_class}`,
          );
        }
      }

      // Host / captcha / mismatch are terminal. Everything else recovers
      // from page_class (auth → portal auth, posting → Apply, unknown →
      // park), not from the gate's collapsed NO_APPLICATION_FORM.
      if (!gate.ok && TERMINAL_GATE_CODES.has(gate.failureCode ?? "")) {
        report.notes.push("refused before any mutation — page gate failed");
        return persist(report);
      }

      let planHtml = gate.html;
      let planUrl = gate.finalUrl;

      if (input.execute) {
        const obstructions = await dismissPageObstructions(page);
        if (obstructions.dismissed.length > 0) {
          report.notes.push(
            `popups dismissed: ${obstructions.dismissed.join(", ")}`,
          );
        }

        const canAuth = () =>
          getConfig().navigationEnabled &&
          isRecognizedAtsAuthHost(page.url());

        // Workday's Apply → Apply Manually walk lives in portalAuth.
        // Generic posting advance would click Apply and land on the
        // chooser, which classifyPage cannot name — do not steal that.
        const workdayOwnsWalk = binding.id === "workday" && canAuth();

        // #159: `unknown` gets the advance attempt too. iCIMS serves the
        // posting and its Apply link from a same-origin child frame, so the
        // top document has no fields and no CTA and classifies `unknown` —
        // and the park below then refused a page whose Apply control was
        // one frame away. advancePastPosting already owns this case (it
        // treats an unknown landing as a posting ONLY when it finds a
        // visible Apply control) and no-ops otherwise, so the attempt is
        // free: no control ⇒ advanced:false and the same park as before.
        if (
          !workdayOwnsWalk &&
          (landing.page_class === "posting" || landing.page_class === "unknown")
        ) {
          postingTrail.push(extractPostingContext(planHtml));
          const advance = await advancePastPosting({
            page,
            html: planHtml,
            url: planUrl,
          });
          report.notes.push(...advance.notes);
          if (advance.hops > 0) {
            page = advance.page;
            gate = await binding.gate(page, advance.url, advance.url);
            landing = applyGateToReport(report, gate);
            // #138 (live UKG AuthCode/Register 2026-09-01): advance.html
            // is the click's settle snapshot; a hydrating SPA mounts its
            // native inputs SECONDS later (<ukg-input> web components), so
            // the plan discovered 0 fields from stale HTML while the
            // re-gate above already saw the real form. Plan from the
            // re-gate's fresh read, never the click snapshot.
            planHtml = gate.html;
            planUrl = gate.finalUrl;
          }
          // Apply landed on a DIFFERENT recognised ATS (careers site →
          // Workday/Greenhouse/…): hand the application to that adapter
          // instead of classifying its page with this one (night19 #52,
          // Leidos: careers.leidos.com → leidos.wd5.myworkdayjobs.com).
          const handoff = detectAtsHandoff(binding.id, page.url());
          if (handoff) {
            report.gate.ok = false;
            report.gate.failure_code = "ATS_HANDOFF";
            report.gate.reason = `Apply landed on ${handoff.ats} (${handoff.url}) — handing off to the ${handoff.ats} adapter`;
            report.gate.final_url = page.url();
            report.handoff = handoff;
            report.notes.push(
              `ATS handoff: ${binding.id} → ${handoff.ats} at ${handoff.url}`,
            );
            return persist(report);
          }
          if (landing.page_class === "posting") {
            report.gate.ok = false;
            report.gate.failure_code = "FORM_NOT_REACHED";
            report.gate.reason =
              "still on the job posting after trying Apply — no application form to fill";
            report.gate.page_class = "posting";
            report.notes.push(
              "parked: refused to fill a listing page's own search widgets",
            );
            return persist(report);
          }
        }

        // #166: the landing may be an empty shell whose real page is one
        // same-origin frame down (iCIMS). Resolve that BEFORE the auth
        // decision below — it is keyed on page_class, so an unresolved
        // `unknown` silently skips portal auth and parks UNKNOWN_LANDING.
        if (landing.page_class === "unknown") {
          const frames = await readSameOriginFrames(page);
          if (frames.length > 0) {
            const resolved = classifyWithFrameFallback(landing, frames);
            if (resolved.evidence !== landing.evidence) {
              report.notes.push(`landing re-read via child frame: ${resolved.evidence}`);
            }
            landing = resolved;
            report.gate.page_class = landing.page_class;
          }
        }

        const tryPortalAuth =
          canAuth() &&
          (workdayOwnsWalk || landing.page_class === "auth");

        if (tryPortalAuth) {
          // portalAuth keeps secrets OUT of its notes by construction, and
          // the form snapshot scrubs every value= attribute — so the
          // password/code never reach the artifact. auth.secrets is the
          // scrub list for any future value-based redaction.
          const auth = await authenticateAtsPortal(page);
          void auth.secrets;
          report.notes.push(...auth.notes);
          const cleared =
            auth.status === "signed_in" ||
            auth.status === "account_created" ||
            (binding.id === "workday" && auth.status === "not_an_auth_wall");
          if (!cleared) {
            report.gate.ok = false;
            report.gate.failure_code = "AUTH_REQUIRED";
            report.gate.reason = `portal auth did not clear the wall (${auth.status})`;
            report.gate.page_class = "auth";
            report.notes.push("parked: account wall not cleared");
            return persist(report);
          }
          // #218: Create Account can leave the portal's header account
          // menu open over the form (live redhat.wd5) — every later field
          // click was intercepted. Clear chrome once before planning.
          const postAuth = await dismissPageObstructions(page);
          if (postAuth.dismissed.length > 0) {
            report.notes.push(`post-auth obstructions dismissed: ${postAuth.dismissed.join(", ")}`);
          }
          // Gate HTML is the posting/login we arrived on. Plan AFTER
          // sign-in. Do not treat POSTING_MISMATCH as fatal — apply URL
          // paths often diverge from the normalized posting.
          planHtml = await readLiveHtml(page);
          planUrl = page.url();
          if (binding.id === "workday") {
            let kind = classifyWorkdayPage(planHtml);
            report.notes.push(`workday page kind after auth: ${kind}`);
            // #63d (live tiaa 22f-22j): auth can SUCCEED yet land OFF the
            // apply flow (Candidate Home / the posting) — the wizard is
            // only reachable by re-walking Apply from the posting URL.
            // ONE bounded re-reach: back to the employer URL, run the
            // portal walk again (signed in, it is just Apply → Apply
            // Manually → the resumed wizard — LIVE-probed 2026-08-30);
            // an unauthenticated session parks exactly as before.
            // #75: a WIZARD-looking page with the signed-OUT header is an
            // anonymous shell, never our draft — treat it as off-flow.
            const signedOut =
              (await page
                .locator("[data-automation-id='utilityButtonSignIn']")
                .first()
                .isVisible()
                .catch(() => false)) === true;
            if (signedOut) {
              report.notes.push(
                "workday: page header shows Sign In — session is signed OUT",
              );
            }
            const offFlow =
              signedOut ||
              kind === "posting" ||
              kind === "chooser" ||
              ((kind === "wizard" || kind === "unknown") &&
                discoverFieldsFromHtml(planHtml).length === 0);
            if (offFlow) {
              report.notes.push(
                `workday: page after auth is off the apply flow (${kind}) — one re-reach from the posting URL`,
              );
              await page
                .goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
                .catch(() => undefined);
              // Workday's SPA paints the Apply button SECONDS after
              // domcontentloaded (probes: 4-5s; live 22k the re-reach
              // walked a blank shell and found no Apply). Bounded wait
              // for the control before walking.
              await page
                .locator(
                  "[data-automation-id='adventureButton'], [data-automation-id='continueButton']",
                )
                .first()
                .waitFor({ timeout: 15_000 })
                .catch(() => undefined);
              const reReach = await authenticateAtsPortal(page);
              void reReach.secrets;
              report.notes.push(
                ...reReach.notes.map((n) => `re-reach ${n}`),
              );
              planHtml = await readLiveHtml(page);
              planUrl = page.url();
              kind = classifyWorkdayPage(planHtml);
              report.notes.push(`workday page kind after re-reach: ${kind}`);
            }
            if (kind === "posting" || kind === "chooser") {
              report.gate.ok = false;
              report.gate.failure_code = "FORM_NOT_REACHED";
              report.gate.reason = `still on Workday ${kind} after portal auth`;
              report.notes.push(
                "parked: Apply / Apply Manually did not reach the application form",
              );
              return persist(report);
            }
            if (kind === "auth") {
              report.gate.ok = false;
              report.gate.failure_code = "AUTH_REQUIRED";
              report.gate.reason = "still on Workday sign-in after portal auth";
              report.gate.page_class = "auth";
              report.notes.push("parked: Workday account wall not cleared");
              return persist(report);
            }
            // wizard | unknown: the page claims to BE the form, so it has
            // to have fields. This branch skips binding.gate entirely
            // (the apply path legitimately leaves the posting URL), so it
            // is also the one place the shared gate's zero-field refusal
            // cannot reach. Crowe live: 0 planned, 0 filled, verify
            // failed — a refusal names that, a 0-field fill hides it.
            if (discoverFieldsFromHtml(planHtml).length === 0) {
              report.gate.ok = false;
              report.gate.failure_code = "NO_APPLICATION_FORM";
              report.gate.reason = `Workday page classified ${kind} but has no fillable fields`;
              report.notes.push(
                "parked: reached a Workday page with nothing to fill",
              );
              return persist(report);
            }
            landing = classifyPage({ html: planHtml, url: planUrl });
            report.gate.ok = true;
            report.gate.failure_code = null;
            report.gate.reason = null;
            report.gate.final_url = planUrl;
            report.gate.page_class = landing.page_class;
          } else {
            const again = await binding.gate(
              page,
              input.url,
              detected.normalizedUrl,
            );
            if (again.ok) {
              planHtml = again.html;
              planUrl = again.finalUrl;
              landing = applyGateToReport(report, again);
            } else if (again.failureCode === "POSTING_MISMATCH") {
              report.notes.push(
                "post-auth path differs from posting URL — planning the landed page",
              );
              landing = classifyPage({ html: planHtml, url: planUrl });
              report.gate = {
                ok: true,
                failure_code: null,
                reason: null,
                final_url: planUrl,
                page_class: landing.page_class,
              };
            } else {
              landing = applyGateToReport(report, again);
              report.gate.ok = false;
              report.gate.failure_code = again.failureCode ?? "AUTH_REQUIRED";
              report.gate.reason = again.reason ?? "page gate still failed after portal auth";
              report.notes.push("refused after portal auth — page gate still failed");
              return persist(report);
            }
          }
        }
      }

      landing = classifyPage({ html: planHtml, url: planUrl });
      report.gate.page_class = landing.page_class;
      if (landing.page_class === "form" && !report.gate.ok) {
        report.gate.ok = true;
        report.gate.failure_code = null;
        report.gate.reason = null;
        report.notes.push(
          "page class is form — proceeding despite missing <form> marker",
        );
      }

      // plan_only cannot click Apply, so a posting has nothing plannable —
      // a listing page's own widgets (search boxes, newsletter signups)
      // must never become the "form" just because the field-count gate now
      // tolerates form-less SPAs (live 2026-08-19 Paylocity). Execute mode
      // advances past postings above; refusing here keeps plan_only honest.
      if (!input.execute && report.gate.ok && landing.page_class === "posting") {
        report.gate.ok = false;
        report.gate.reason =
          "posting page — Apply advance is execute-only, nothing to plan";
      }
      if (!report.gate.ok && landing.page_class !== "form") {
        if (landing.page_class === "auth") {
          report.gate.failure_code = report.gate.failure_code ?? "LOGIN_WALL";
          report.notes.push(
            "refused — login wall; set NAVIGATION_ENABLED=true and PORTAL_LOGIN_EMAIL/PASSWORD to sign in",
          );
        } else if (landing.page_class === "posting") {
          report.gate.failure_code = input.execute
            ? "FORM_NOT_REACHED"
            : "NO_APPLICATION_FORM";
          report.notes.push("refused before any mutation — page is a posting, not a form");
        } else if (landing.page_class === "unknown") {
          report.gate.failure_code = "UNKNOWN_LANDING";
          report.gate.reason = landing.evidence;
          report.notes.push(
            `parked: page class unknown (${landing.evidence}) — not a form, posting, or login wall`,
          );
          // #160: say what the gate actually saw. Seven apps parked here
          // in the 2026-09-03 cycles across five hosts and the artifact
          // named none of it, so telling a slow SPA (still painting) from
          // an iframe-served posting (#159) needed a live re-probe.
          const rw = gate.renderWait;
          report.notes.push(
            rw
              ? `render wait: ${rw.settledAs} after ${rw.polls} poll(s) / ${rw.waitedMs}ms, final html ${rw.htmlChars} chars`
              : "render wait: skipped — the first paint already classified",
          );
          const frameUrls = page
            .frames()
            .map((f) => f.url())
            .filter((u) => u && u !== "about:blank" && u !== page.url());
          report.notes.push(
            frameUrls.length === 0
              ? "child frames: none — the posting is not iframe-served"
              : `child frames (${frameUrls.length}): ${frameUrls
                  .slice(0, 3)
                  .map((u) => u.slice(0, 80))
                  .join(" | ")}`,
          );
        } else if (landing.page_class === "confirmation") {
          report.gate.failure_code = "ALREADY_CONFIRMED";
          report.notes.push("refused — page already shows an application confirmation");
        } else {
          report.notes.push("refused before any mutation — page gate failed");
        }
        return persist(report);
      }

      // Extension-first (X2): activate JobRight's extension BEFORE option
      // harvest and planning, so its writes are on the page by the time
      // the pre-fill verify decides which answers are already satisfied.
      // Execute-only (activation IS mutation, same gates as our own
      // typing), opt-in (JOBRIGHT_AUTOFILL_ENABLED), and inert until an
      // ext-capture promoted trigger selectors. Failure is soft: the run
      // simply proceeds as a full native fill.
      if (input.extensionFirst && input.execute) {
        assertFormFillAllowed(`atsLiveFill.${binding.id}.extension`);
        if (!getConfig().jobrightAutofillEnabled) {
          report.notes.push(
            "extensionFirst requested but JOBRIGHT_AUTOFILL_ENABLED is off — native fill",
          );
        } else {
          const activation = await attemptExtensionAutofill(page, {
            ...(input.extensionTriggerSelectors
              ? { triggerSelectors: input.extensionTriggerSelectors }
              : {}),
          });
          report.extension = { ...activation, satisfied_answers: [] };
          report.notes.push(
            `extension activation: attempted=${activation.attempted} activated=${activation.activated}`,
            ...activation.notes,
          );
          if (activation.activated) {
            planHtml = await readLiveHtml(page);
          }
        }
      }

      // #143: expand collapsed accordion sections BEFORE harvest/plan —
      // a page that lands with its fields behind Bootstrap-style panels
      // (UKG OpportunityApply) otherwise plans fills that can only time
      // out "waiting for element to be visible". Execute-only: expansion
      // clicks are interaction. Refresh the plan HTML when it changed.
      if (input.execute) {
        const expanded = await expandCollapsedSections(page).catch(() => null);
        if (expanded && expanded.clicked > 0) {
          report.notes.push(...expanded.notes);
          planHtml = await readLiveHtml(page);
        }
      }

      // Scrape each control's REAL answer space before planning anything.
      // HTML cannot see a React-select's option list, so without this every
      // dropdown reaches the planner empty and the tiers below degrade to
      // typing blind (live Appian: "Summer Atlantic Capital" typed into a
      // list that only offered "Other"). Execute-only — plan_only stays
      // zero-interaction — and read-only w.r.t. values: it opens controls,
      // reads, and escapes without ever committing a choice.
      // Greenhouse publishes the form's questions and their COMPLETE
      // option lists as public JSON. One request beats opening eight
      // comboboxes, and it cannot be truncated by a virtualized menu's
      // scroll position the way a DOM read can (live: "How did you hear
      // about Appian?" has 22 options). Fail-open — null means the DOM
      // harvest carries the whole load, exactly as before. G1: fetched in
      // BOTH modes — the fetch is a network read, so plan_only's
      // zero-interaction promise holds; only the DOM harvest below stays
      // execute-only. Before this, plan_only previews planned every
      // dropdown blind.
      const declared = await fetchGreenhouseQuestions(planUrl).catch(() => null);
      let harvest: OptionHarvestResult | null = null;
      let declaredOnly: {
        options: Map<string, string[]>;
        answerSpace: Map<string, AnswerSpace>;
      } | null = null;
      {
        let planFields = discoverFieldsFromHtml(planHtml);
        let apiOptions = new Map<string, string[]>();
        let apiAnswerSpace = new Map<string, AnswerSpace>();
        if (declared) {
          // G3: reconcile BEFORE the merge overwrites DOM option lists —
          // the diff's whole value is showing where the two sources
          // disagreed, which the merged fields can no longer tell.
          report.schema_diff = diffDeclaredVsDom(planFields, declared);
          report.notes.push(summarizeSchemaDiff(report.schema_diff));
          const merged = mergeDeclaredQuestions(planFields, declared.byLabel);
          planFields = merged.fields;
          apiOptions = merged.options;
          apiAnswerSpace = merged.answerSpace;
          report.notes.push(
            `board API declared ${declared.questions.length} question(s); matched complete option lists onto ${merged.matched} field(s)${
              input.execute ? "" : " (plan_only — API options, no DOM harvest)"
            }`,
          );
        }
        if (input.execute) {
          // Fields the API already answered are not re-opened in the
          // browser — that is the speed win. The harvest handles only
          // what is left.
          harvest = await harvestFieldOptions(page, planFields);
          for (const [id, options] of apiOptions) {
            harvest.options.set(id, options);
            harvest.answerSpace.set(id, "closed");
          }
        } else if (apiOptions.size > 0) {
          declaredOnly = { options: apiOptions, answerSpace: apiAnswerSpace };
        }
      }
      if (harvest) {
        report.notes.push(...harvest.notes);
        report.harvested_options = harvest.harvested.map((h) => ({
          field_id: h.field_id,
          label: h.label,
          answer_space: h.answer_space,
          option_count: h.options.length,
          options: h.options.slice(0, 25),
          other_option: h.other_option,
        }));
        await postSandboxTrace(input.url, {
          kind: "harvest",
          lines: harvest.harvested.map(
            (h) =>
              `${h.label.slice(0, 60)}: ${h.answer_space} (${h.options.length} options)${
                h.other_option ? ` other="${h.other_option}"` : ""
              }`,
          ),
        });
      }
      // #198 (live morningstar.wd5): an open header menu over the wizard
      // intercepts every field click. Close it before the first plan.
      if (binding.id === "workday") {
        const headerMenu = await closeWorkdayHeaderMenus(page);
        report.notes.push(...headerMenu.notes);
      }
      const planStartedAt = Date.now();
      const { adapter, plan, approvedPlan, fields: plannedFields, otherFallbacks } =
        await planApplicationFill({
          url: planUrl,
          html: planHtml,
          postingContext: mergePostingContext(...postingTrail),
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.capture ? { capture: input.capture } : {}),
          ...(harvest ? { liveOptions: harvest.options } : {}),
          ...(harvest ? { answerSpace: harvest.answerSpace } : {}),
          // plan_only with a board-API response: the API's complete lists
          // stand in for the harvest, so previews stop planning blind.
          ...(!harvest && declaredOnly
            ? {
                liveOptions: declaredOnly.options,
                answerSpace: declaredOnly.answerSpace,
              }
            : {}),
        });
      if (adapter.id !== binding.id) {
        report.gate.failure_code = "ATS_MISMATCH";
        report.gate.reason = `page detected as ${adapter.id}, binding is ${binding.id}`;
        report.notes.push("refused before any mutation — adapter mismatch");
        return persist(report);
      }
      report.plan_summary = {
        fillable_count: approvedPlan.fillable_count,
        skipped_count: approvedPlan.skipped_count,
        review_required_count: approvedPlan.review_required_count,
      };
      report.plan_fields = approvedPlan.entries.map((e) => ({
        field_id: e.field_id,
        label: e.label,
        type: String(e.type),
        canonical_field: e.canonical_field ?? null,
        action: String(e.action),
        reason: e.reason,
      }));
      await postSandboxTrace(input.url, {
        kind: "plan",
        lines: [
          `${approvedPlan.fillable_count} fill / ${approvedPlan.skipped_count} skip / ${approvedPlan.review_required_count} review`,
          ...approvedPlan.entries.map((e) => {
            const val =
              e.value === undefined || e.value === null
                ? ""
                : ` → ${String(e.value).slice(0, 70)}`;
            return `${String(e.action).padEnd(16)} ${e.label.slice(0, 48)}${val}  [${e.reason}]`;
          }),
        ],
      });
      // Ground truth for skipped-question diagnosis: the pre-fill DOM, with
      // control values scrubbed (a handoff page can arrive pre-filled).
      if (approvedPlan.skipped_count > 0 && planHtml) {
        report.form_snapshot_path = writeFormSnapshot(planHtml);
      }

      if (!input.execute) {
        report.mode = "plan_only";
        report.validation_level = "LIVE_READ_ONLY_CONFIRMED";
        report.notes.push(
          "plan_only — set --execute with FORM_FILL_ENABLED=true and DRY_RUN=false to mutate",
        );
        return persist(report, { plan, approvedPlan });
      }

      assertFormFillAllowed(`atsLiveFill.${binding.id}.execute`);
      report.mode = "executed";
      const planMs = Date.now() - planStartedAt;
      const fillStartedAt = Date.now();
      const knownFieldIds = new Set(plannedFields.map((f) => f.id));
      // Gap restriction (X3): when the extension activated, read the form
      // back BEFORE typing anything — every planned answer the page
      // already matches was the extension's work and is left alone. The
      // adapters execute from their STORED approved plan (answers are
      // advisory), so the restriction flips satisfied entries to
      // approved:false for the fill and restores the full plan before the
      // whole-form verify — a wrong extension value is still caught.
      let planRestricted = false;
      if (report.extension?.activated) {
        const preVerify = await adapter.verify(page, approvedPlan.answers);
        const satisfied = preVerify.fields
          .filter((f) => f.match)
          .map((f) => f.canonical_field);
        report.extension.satisfied_answers = satisfied;
        if (satisfied.length > 0) {
          const skip = new Set(satisfied);
          const gapPlan = {
            ...approvedPlan,
            entries: approvedPlan.entries.map((e) =>
              skip.has(e.canonical_field ?? e.field_id)
                ? {
                    ...e,
                    approved: false as const,
                    reason:
                      "extension_filled — left in place, verified whole-form",
                  }
                : e,
            ),
          };
          adapter.setApprovedFillPlan(
            gapPlan,
            ...(input.profile ? [input.profile] : []),
          );
          planRestricted = true;
        }
        report.notes.push(
          `extension satisfied ${satisfied.length}/${approvedPlan.fillable_count} planned answer(s) — native gap-fill covers the rest`,
        );
      }
      report.fill = await adapter.fill(page, approvedPlan.answers);
      if (planRestricted) {
        // Whole-form verify must cover extension-filled fields too.
        adapter.setApprovedFillPlan(
          approvedPlan,
          ...(input.profile ? [input.profile] : []),
        );
      }
      // Choosing "Other" usually reveals an "Other (please specify)" box —
      // an OPEN answer space that only exists after the option commits.
      // The real answer the closed list could not hold goes in there.
      if (otherFallbacks.length > 0) {
        const specified = await fillOtherSpecify({
          page,
          knownFieldIds,
          requests: otherFallbacks.map((o) => ({
            field_id: o.field_id,
            label: o.label,
            intended: o.intended,
          })),
        });
        report.other_specify = specified;
        report.notes.push(...specified.map((s) => `other-specify: ${s.note}`));
      }
      // #149: dependent selects (Country → State/Province) reveal their
      // option list only after the parent pick — one deterministic
      // profile-tier pass over selects still at their placeholder.
      await sweepRevealedSelects(page, report, input.profile);
      const fillMs = Date.now() - fillStartedAt;
      const verifyStartedAt = Date.now();
      report.verify = await adapter.verify(page, approvedPlan.answers);
      // Where the minutes go (live UKG runs 20-21 took 16-25 min): one
      // note per planned page so a slow stage is visible in the artifact.
      report.notes.push(
        timingNote("base page", approvedPlan.entries.length, {
          plan: planMs,
          fill: fillMs,
          verify: Date.now() - verifyStartedAt,
        }),
      );
      // #66b: a verify miss reading EMPTY on a text control is the one
      // moment we know React state never took the fill — one keystroke
      // retype (adapter-provided), then verify decides again.
      if (!report.verify.passed && adapter.retypeVerifyMisses) {
        const retype = await adapter.retypeVerifyMisses(page, report.verify);
        report.notes.push(...retype.notes);
        if (retype.retyped.length > 0) {
          report.verify = await adapter.verify(page, approvedPlan.answers);
          report.notes.push(
            `verify after keystroke retype: ${report.verify.passed ? "passed" : "still failing"}`,
          );
        }
      }
      // #66a (operator directive): EVERY platform paints its own
      // validation errors — read them on any failed verify so the page's
      // wording names the blocker. Vendor extras come from the registry.
      if (!report.verify.passed) {
        const pageErrors = await readPageValidationErrors(page, {
          extraSelectors:
            binding.id === "workday"
              ? [...workdaySelectorsV1.errorContainers]
              : [],
        });
        const lines = pageErrors.map((e) => `page error: ${e}`);
        if (lines.length > 0) {
          report.notes.push(...lines);
          report.verify.warnings.push(...lines);
        } else {
          report.notes.push(
            "page error scan: no visible validation errors on the page",
          );
        }
      }
      await postSandboxTrace(input.url, {
        kind: "fill",
        lines: [
          `filled: ${(report.fill.filled ?? []).join(", ") || "(none)"}`,
          ...(report.fill.errors ?? []).map((e) => `ERROR ${e}`),
          `verify: ${report.verify.passed ? "passed" : "failed"}`,
          ...(report.other_specify ?? []).map((s) => `other-specify: ${s.note}`),
        ],
      });
      // Uploads after field mutation is settled, matching the greenhouse order.
      // A resume on disk is not a miss when the form has no file input
      // (sandbox /portal). Recording a failed upload demoted a passing
      // verify to UNVERIFIED and opened a bogus operator brief.
      if (input.resumePath) {
        const fileInputs = await inventoryFileInputs(page);
        if (fileInputs.length === 0) {
          report.notes.push(
            "resume on disk but this page has no file input — not an upload miss",
          );
        } else {
          report.uploads = [await adapter.uploadResume(page, input.resumePath)];
        }
      }

      // Workday is a MULTI-PAGE wizard (Crowe live: 7 steps). Filling only
      // the landing page left My Experience / Application Questions /
      // Voluntary Disclosures untouched — the app then died at submit on
      // "required questions unanswered" that were never even seen. The
      // walk (workdayWizard.ts) clicks Next → settles → hands each page to
      // this filler; bounded, and NEVER the submit button.
      let wizardVerifyFailed = false;
      // #113c (live mastercard 2026-08-31): "Please upload your
      // college/university transcript." is REQUIRED mid-wizard, but the
      // supplemental pass only ran at submit time — page 2 could never
      // advance. Attach once per walk, only on a page that names a
      // transcript (the pass itself is fail-closed: no file on disk or
      // no matching input ⇒ nothing touched).
      let wizardTranscriptDone = false;
      if (binding.id === "workday") {
        const walk = await walkWorkdayWizard(page, async ({ html, url }) => {
          // #198: a header menu can be (re)opened on any wizard page.
          const headerMenu = await closeWorkdayHeaderMenus(page);
          if (headerMenu.notes.length > 0) report.notes.push(...headerMenu.notes);
          // #126b (live finastra 2026-09-01, operator-diagnosed): wizard
          // pages planned with ZERO option data — the harvest only ever
          // ran on the first page, so the questions page's listbox
          // answers ("U.S. Citizen", consent Yes, AI-opt-out Yes) had no
          // option lists for the bank/option-select/predict tiers to map
          // onto and stayed unfilled through 10 runs. Same
          // discover→harvest→plan pattern as the greenhouse path.
          let pageHarvest: Awaited<ReturnType<typeof harvestFieldOptions>> | null =
            null;
          try {
            pageHarvest = await harvestFieldOptions(
              page,
              discoverFieldsFromHtml(html),
            );
            if (pageHarvest.notes.length > 0) {
              report.notes.push(
                ...pageHarvest.notes.slice(0, 4).map((n) => `wizard ${n}`),
              );
            }
            if (pageHarvest.harvested.length > 0) {
              report.notes.push(
                `wizard option harvest: ${pageHarvest.harvested
                  .map((h) => `"${h.label.slice(0, 40)}"×${h.options.length}`)
                  .slice(0, 6)
                  .join(", ")}`,
              );
            }
          } catch {
            // harvest is best-effort; the plan proceeds without options
          }
          const pagePlan = await planApplicationFill({
            url,
            html,
            postingContext: mergePostingContext(...postingTrail),
            ...(input.profile ? { profile: input.profile } : {}),
            ...(input.capture ? { capture: input.capture } : {}),
            ...(pageHarvest && pageHarvest.options.size > 0
              ? {
                  liveOptions: pageHarvest.options,
                  answerSpace: pageHarvest.answerSpace,
                }
              : {}),
          });
          const wizardAdapter = pagePlan.adapter;
          const fillResult = await wizardAdapter.fill(page, pagePlan.approvedPlan.answers);
          // #73: per-page fill errors/skips were DROPPED — #22v walked four
          // question pages at 0/17..0/9 filled with zero evidence why.
          report.notes.push(
            ...fillResult.errors.slice(0, 8).map((e) => `wizard fill error: ${e}`),
          );
          if (fillResult.filled.length === 0 && pagePlan.approvedPlan.fillable_count > 0) {
            report.notes.push(
              `wizard fill: 0 of ${pagePlan.approvedPlan.fillable_count} approved entries filled — skipped: ${fillResult.skipped.slice(0, 6).join("; ").slice(0, 300)}`,
            );
          }
          // #126 (live finastra, 10 runs): the questions page held at
          // 6/17 with ZERO errors — the misses were plan-time SKIPS and
          // nothing recorded their walk-time labels/reasons, so the gap
          // between walk-plan and submit-plan mapping was invisible.
          const pageSkips = pagePlan.approvedPlan.entries.filter(
            (e) => e.action === "SKIP",
          );
          if (pageSkips.length > 0) {
            report.notes.push(
              `wizard plan skips (${pageSkips.length}): ${pageSkips
                .slice(0, 8)
                .map((e) => `"${e.label.slice(0, 60)}"→${(e.reason ?? "?").slice(0, 50)}`)
                .join(" | ")
                .slice(0, 700)}`,
            );
          }
          let verifyResult = await wizardAdapter.verify(page, pagePlan.approvedPlan.answers);
          // #86 (live stryker ×2, deterministic): a text value can pass the
          // immediate per-page verify (read before the wipe) and be gone
          // by the time Next is clicked — the GPA textarea emptied on
          // every run. Re-verify after a settle so the late wipe is seen
          // while the page is still current; the #66b retype then fires.
          if (verifyResult.passed) {
            await page.waitForTimeout(1_500);
            const settled = await wizardAdapter.verify(page, pagePlan.approvedPlan.answers);
            if (!settled.passed) {
              report.notes.push(
                `wizard: page verified then LOST value(s) after settle — retyping (${settled.fields.filter((f) => !f.match).length} miss(es))`,
              );
              verifyResult = settled;
            }
          }
          // #66b per wizard page: keystroke-retype empty text misses once.
          if (!verifyResult.passed && wizardAdapter.retypeVerifyMisses) {
            const retype = await wizardAdapter.retypeVerifyMisses(page, verifyResult);
            report.notes.push(...retype.notes.map((n) => `wizard ${n}`));
            if (retype.retyped.length > 0) {
              verifyResult = await wizardAdapter.verify(page, pagePlan.approvedPlan.answers);
            }
          }
          // #66a per wizard page: the page's own error UI, when verify fails.
          if (!verifyResult.passed) {
            const pageErrors = await readPageValidationErrors(page, {
              extraSelectors: [...workdaySelectorsV1.errorContainers],
            });
            report.notes.push(
              ...pageErrors.map((e) => `wizard page error: ${e}`),
            );
          }
          // Resume upload lives on My Experience — retry there if page 1
          // had no control (or its upload failed to verify).
          if (
            input.resumePath &&
            !(report.uploads?.some((u) => u.verified) ?? false) &&
            (await page
              .locator(workdaySelectorsV1.wizard.resumeUpload)
              .first()
              .count()
              .catch(() => 0)) > 0
          ) {
            const upload = await wizardAdapter.uploadResume(page, input.resumePath);
            report.uploads = [...(report.uploads ?? []), upload];
          }
          // #113c: supplemental materials (transcript) mid-walk, once.
          if (!wizardTranscriptDone && /transcript/i.test(html)) {
            const supplemental = await attachSupplementalMaterials(page);
            if (supplemental.attached.length > 0) {
              wizardTranscriptDone = true;
              report.notes.push(
                ...supplemental.attached.map(
                  (a) =>
                    `wizard supplemental: ${a.kind} "${a.label}" ${a.verified ? "verified" : "unverified"}`,
                ),
              );
            } else if (supplemental.notes.length > 0) {
              report.notes.push(
                ...supplemental.notes.map((n) => `wizard supplemental: ${n}`),
              );
            }
          }
          if (pagePlan.approvedPlan.skipped_count > 0) {
            report.form_snapshot_path = writeFormSnapshot(html);
          }
          return {
            fillable: pagePlan.approvedPlan.fillable_count,
            filled: fillResult.filled.length,
            verifyPassed: verifyResult.passed && fillResult.errors.length === 0,
          };
        }, {
          applicationId: input.capture?.applicationId ?? null,
          // Mid-walk session expiry: sign back in (same gates as
          // tryPortalAuth) and resume, instead of abandoning a wizard
          // that is already half filled.
          onAuthWall: async (walkPage) => {
            if (!getConfig().navigationEnabled) return false;
            if (!isRecognizedAtsAuthHost(walkPage.url())) return false;
            const auth = await authenticateAtsPortal(walkPage);
            report.notes.push(...auth.notes);
            return auth.status === "signed_in" || auth.status === "account_created";
          },
        });
        report.wizard_pages = walk.pages;
        report.notes.push(...walk.notes);
        wizardVerifyFailed = walk.verifyFailed;
      } else if (binding.id === "generic") {
        // Shared re-plan+fill+verify closure — the section-editor walk
        // (#145c, same-page editors) and the page walk (Paycom-class
        // Next/Continue) both hand each newly revealed form state here.
        const fillCurrentGenericPage = async ({
          page: formPage,
          html,
          url,
        }: {
          page: Page;
          html: string;
          url: string;
        }) => {
          const pagePlanStartedAt = Date.now();
          const pagePlan = await planApplicationFill({
            url,
            html,
            postingContext: mergePostingContext(...postingTrail),
            ...(input.profile ? { profile: input.profile } : {}),
            ...(input.capture ? { capture: input.capture } : {}),
          });
          const pagePlanMs = Date.now() - pagePlanStartedAt;
          const pageFillStartedAt = Date.now();
          const fillResult = await pagePlan.adapter.fill(
            formPage,
            pagePlan.approvedPlan.answers,
          );
          // #149: same dependent-select pass as the base fill.
          const revealed = await fillRevealedProfileSelects({
            page: formPage,
            ...(input.profile ? { profile: input.profile } : {}),
          }).catch(() => ({ outcomes: [], notes: [] }));
          report.notes.push(...revealed.notes);
          const pageFillMs = Date.now() - pageFillStartedAt;
          const pageVerifyStartedAt = Date.now();
          const verifyResult = await pagePlan.adapter.verify(
            formPage,
            pagePlan.approvedPlan.answers,
          );
          report.notes.push(
            timingNote("revealed page", pagePlan.approvedPlan.entries.length, {
              plan: pagePlanMs,
              fill: pageFillMs,
              verify: Date.now() - pageVerifyStartedAt,
            }),
          );
          report.fill = {
            filled: [
              ...(report.fill?.filled ?? []),
              ...fillResult.filled,
              ...revealed.outcomes.filter((o) => o.verified).map((o) => o.canonical_field),
            ],
            skipped: [...(report.fill?.skipped ?? []), ...fillResult.skipped],
            errors: [...(report.fill?.errors ?? []), ...fillResult.errors],
            field_meta: [
              ...(report.fill?.field_meta ?? []),
              ...(fillResult.field_meta ?? []),
            ],
          };
          report.verify = verifyResult;
          report.plan_fields = [
            ...(report.plan_fields ?? []),
            ...pagePlan.approvedPlan.entries.map((e) => ({
              field_id: e.field_id,
              label: e.label,
              type: String(e.type),
              canonical_field: e.canonical_field ?? null,
              action: String(e.action),
              reason: e.reason,
            })),
          ];
          if (pagePlan.approvedPlan.skipped_count > 0) {
            report.form_snapshot_path = writeFormSnapshot(html);
          }
          return {
            fillable: pagePlan.approvedPlan.fillable_count,
            filled: fillResult.filled.length,
            verifyPassed: verifyResult.passed && fillResult.errors.length === 0,
          };
        };

        // #145c: cycle the page's section editors (open → fill → save),
        // one at a time — UKG disables every other pencil while an editor
        // is open. Runs even when the base verify failed: the failures ARE
        // the hidden section fields the editors reveal.
        const editorWalk = await walkSectionEditors(
          page,
          fillCurrentGenericPage,
          genericSelectorsV1.sectionEditors,
        );
        if (editorWalk.editors > 0) {
          report.notes.push(...editorWalk.notes);
        }

        if (report.verify.passed && report.fill.errors.length === 0) {
          // Paycom-class lead-capture and in-form Next: the submit cascade
          // correctly refuses "Continue"/"Next" so --submit cannot fake a
          // receipt. After this page verifies, click that CTA, re-plan, fill.
          const walk = await walkGenericFormPages(page, fillCurrentGenericPage);
          page = walk.page;
          report.wizard_pages = walk.pages;
          report.notes.push(...walk.notes);
          wizardVerifyFailed = walk.verifyFailed;
        }
      }

      report.validation_level =
        report.verify.passed &&
        report.fill.errors.length === 0 &&
        !wizardVerifyFailed &&
        (report.uploads?.every((u) => u.verified) ?? true)
          ? "LIVE_MUTATION_CONFIRMED"
          : "UNVERIFIED";
      if (input.submit) {
        await attemptSandboxSubmit({
          page,
          binding,
          report,
          approvedPlan,
          declaredRequired: requiredQuestionLabels(declared),
          ...(input.assumeYes ? { assumeYes: true } : {}),
          ...(input.confirmSubmission
            ? { confirmSubmission: input.confirmSubmission }
            : {}),
        });
      } else {
        report.notes.push("submit not attempted — live fill never submits");
      }
      if (report.validation_level === "UNVERIFIED") {
        const brief = buildOperatorFieldBrief({
          context: `Live fill — ${binding.id} ${gate.finalUrl}`,
          verify: report.verify,
          fill: report.fill,
          upload: report.uploads?.find((u) => !u.verified) ?? null,
          planEntries: briefPlanEntries(approvedPlan),
        });
        report.operator_brief = brief;
        printOperatorFieldBrief(brief);
      }
      return persist(report, { plan, approvedPlan });
    },
  );

  function timingNote(
    what: string,
    fieldCount: number,
    ms: { plan: number; fill: number; verify: number },
  ): string {
    const s = (n: number) => `${Math.round(n / 1000)}s`;
    return `timing: ${what} (${fieldCount} planned) — plan ${s(ms.plan)}, fill ${s(ms.fill)}, verify ${s(ms.verify)}`;
  }

  /**
   * #166: content of the page's SAME-ORIGIN child frames, for the landing
   * re-read. Bounded (3 frames) and fail-soft — a frame that detaches
   * mid-read contributes nothing rather than throwing at the gate.
   */
  async function readSameOriginFrames(
    p: Page,
  ): Promise<Array<{ url: string; html: string }>> {
    const candidates = sameOriginFrames(
      p.url(),
      p.frames().map((f) => ({ url: f.url(), html: "" })),
    ).slice(0, 3);
    const out: Array<{ url: string; html: string }> = [];
    for (const c of candidates) {
      const frame = p.frames().find((f) => f.url() === c.url);
      if (!frame) continue;
      const html = await frame.content().catch(() => "");
      if (html) out.push({ url: c.url, html });
    }
    return out;
  }

  /**
   * Persist a value-scrubbed copy of the page HTML for offline discovery
   * repro. Scrubbing is defensive: value attributes, textarea bodies, and
   * scripts go; question labels and structure — the diagnostic payload —
   * stay. Capped so a pathological page can't flood the artifacts dir.
   */
  function writeFormSnapshot(html: string): string {
    const cfg = getConfig();
    const outDir = path.join(cfg.artifactsDir, "ats-fill", `${binding.id}-live`);
    fs.mkdirSync(outDir, { recursive: true });
    const snapshotPath = path.join(outDir, `form-snapshot-${Date.now()}.html`);
    fs.writeFileSync(snapshotPath, scrubHtmlForSnapshot(html), "utf8");
    return snapshotPath;
  }

  function persist(
    r: AtsLiveFillReport,
    plans?: {
      plan: Awaited<ReturnType<typeof planApplicationFill>>["plan"];
      approvedPlan: Awaited<ReturnType<typeof planApplicationFill>>["approvedPlan"];
    },
  ): AtsLiveFillReport {
    if (input.fixtureHtml !== undefined && r.validation_level !== "UNVERIFIED") {
      r.validation_level = "UNVERIFIED";
      r.notes.push(
        "fixture-served page (test seam) — validation level demoted, not live evidence",
      );
    }
    const cfg = getConfig();
    const outDir = path.join(cfg.artifactsDir, "ats-fill", `${r.ats}-live`);
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, `live-${r.mode}-${Date.now()}.json`);

    if (r.mode === "executed" && plans) {
      // X4: step-level trace artifact — classed/identifier data only.
      const now = () => new Date().toISOString();
      const traceEvents: FillTraceEvent[] = [];
      if (r.extension) {
        traceEvents.push({
          event: "activation",
          at: now(),
          attempted: r.extension.attempted,
          activated: r.extension.activated,
          trigger: r.extension.trigger,
          changed_fields: r.extension.changed_fields,
        });
        traceEvents.push({
          event: "extension_satisfied",
          at: now(),
          canonical_fields: r.extension.satisfied_answers,
        });
      }
      traceEvents.push({
        event: "native_fill",
        at: now(),
        filled: r.fill?.filled ?? [],
        errors: (r.fill?.errors ?? []).map((e) => String(e).slice(0, 200)),
      });
      traceEvents.push({
        event: "verify",
        at: now(),
        passed: r.verify?.passed ?? null,
        fields: (r.verify?.fields ?? []).map((f) => ({
          canonical_field: f.canonical_field,
          match: f.match,
        })),
      });
      const tracePath = writeFillTrace(
        outDir,
        `fill-trace-${Date.now()}.jsonl`,
        traceEvents,
      );
      recordFillRun({
        mode: "executed",
        // A threaded capture means the pipeline invoked us for a tracked
        // application — recording "cli_url"/NULL there broke the corpus
        // join promised in docs/telemetry-training.md.
        source: input.capture?.applicationId ? "pipeline" : "cli_url",
        application_id: input.capture?.applicationId ?? null,
        strategy: input.extensionFirst ? "EXTENSION_FIRST" : "NATIVE_ONLY",
        trace_relpath: path.relative(cfg.artifactsDir, tracePath),
        extension_satisfied: r.extension?.satisfied_answers ?? null,
        ats: r.ats,
        job_url: r.url,
        mutation_attempted: true,
        validation_level: r.validation_level,
        fillable_count: plans.approvedPlan.fillable_count,
        skipped_count: plans.approvedPlan.skipped_count,
        report_artifact_relpath: path.relative(cfg.artifactsDir, reportPath),
        notes: r.notes,
        plan_entries: plans.approvedPlan.entries.map((e) => ({
          field_id: e.field_id,
          label: e.label,
          type: e.type as string,
          canonical_field: e.canonical_field ?? null,
          action: String(e.action),
          value: e.value,
          reason: e.reason,
          approved: e.approved,
        })),
        fill: r.fill,
        verify: r.verify,
        uploads: r.uploads,
        heal: null,
      },
      input.capture?.db ? { db: input.capture.db } : {});
    }

    const redacted = redactFillReportForArtifact({
      ...r,
      written_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>);
    writeJsonAtomic(reportPath, redacted);
    r.report_path = reportPath;
    logger.info("ats live fill finished", {
      service: r.ats,
      action: "live_fill",
      metadata: {
        mode: r.mode,
        gate_ok: r.gate.ok,
        validation_level: r.validation_level,
      },
    });
    return r;
  }
}
