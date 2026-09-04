import type { Db } from "../../storage/db/client.js";
import { dismissPageObstructions } from "../../browser/obstructions.js";
import {
  authenticateAtsPortal,
  isRecognizedAtsAuthHost,
} from "../../verification/portalAuth.js";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  planApplicationFill,
  type ApplicationFillReport,
} from "../../applications/applicationFiller.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import {
  mergeDeclaredQuestions,
  harvestFieldOptions,
  type AnswerSpace,
  type OptionHarvestResult,
} from "../shared/optionHarvest.js";
import {
  fillOtherSpecify,
  type OtherSpecifyOutcome,
} from "../shared/otherSpecify.js";
import { inventoryFileInputs } from "../shared/uploadResolve.js";
import { fetchGreenhouseQuestions } from "./questionsApi.js";
import {
  diffDeclaredVsDom,
  summarizeSchemaDiff,
  type SchemaDiff,
} from "./schemaDiff.js";
import {
  buildCaptchaIncident,
  pauseForHumanCaptcha,
  type CaptchaIncident,
} from "../shared/captchaPause.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { redactFillReportForArtifact } from "../../applications/fillReportRedaction.js";
import { withPublicUrlPage } from "../../browser/fixtureSession.js";
import type { PublicProfile } from "../../candidate/publicProfile.js";
import { getConfig } from "../../config/index.js";
import { logger } from "../../logging/logger.js";
import { writeJsonAtomic } from "../../storage/atomicJson.js";
import { recordFillRun } from "../../storage/fillOutcomes.js";
import { GreenhouseAdapterV1 } from "./v1.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import { detectBlockingCaptcha, type CaptchaDetection } from "./captchaDetection.js";
import { detectLoginWall, type LoginWallDetection } from "./loginWallDetection.js";
import { healFailedFillEntries, type HealReport } from "./fillHealer.js";
import { verifyResumePdfFile } from "../../jobright/resumeDownload.js";
import type { ApprovedFillPlanEntry } from "../../applications/approvedFillPlan.js";
import { findApplicationFrameUrl } from "../shared/frameHop.js";
import {
  classifyPage,
  hasApplicationIdentityFields,
} from "../shared/pageClassify.js";
import {
  advancePastPosting,
  findApplyControl,
} from "../shared/postingAdvance.js";
import { verifyFinalNavigation } from "./finalNavigation.js";
import {
  detectClosedJobSignals,
  detectErrorPageSignals,
  extractBoardTokenFromUrl,
  extractGreenhouseJobIdFromUrl,
  verifyGreenhousePageIdentity,
  type GreenhouseIdentityVerification,
} from "./identityVerification.js";
import { validateGreenhouseApplicationUrl } from "./urlValidation.js";
import {
  buildOperatorFieldBrief,
  printOperatorFieldBrief,
} from "../../applications/operatorFieldBrief.js";
import type { ApprovedFillPlan } from "../../applications/approvedFillPlan.js";

function briefFromApproved(approvedPlan: ApprovedFillPlan) {
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

export type GreenhouseLiveFillReport = ApplicationFillReport & {
  validation_level: "LIVE_MUTATION_CONFIRMED" | "LIVE_READ_ONLY_CONFIRMED" | "UNVERIFIED";
  final_url: string | null;
  identity_verification: GreenhouseIdentityVerification | null;
  captcha_detection: CaptchaDetection | null;
  login_wall_detection: LoginWallDetection | null;
  failure_code: string | null;
  mutation_attempted: boolean;
  /** Phase 6a′ heal pass, present when read-back verification failed. */
  heal?: HealReport;
  /** Answer space scraped per control before planning (see optionHarvest.ts). */
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
  /** G3: DOM↔declared-schema reconciliation (see schemaDiff.ts). */
  schema_diff?: SchemaDiff;
  /** C2: classed record of a blocking-CAPTCHA hit (host + provider, no candidate data). */
  captcha_incident?: CaptchaIncident;
};

/** Approved FILL entries whose read-back verification failed. */
export function failedApprovedEntries(
  approvedPlan: { entries: ApprovedFillPlanEntry[] },
  verify: { fields: Array<{ canonical_field: string; match: boolean }> },
): ApprovedFillPlanEntry[] {
  const failed = new Set(
    verify.fields.filter((f) => !f.match).map((f) => f.canonical_field),
  );
  return approvedPlan.entries.filter(
    (e) =>
      e.approved &&
      e.action === "FILL" &&
      failed.has(e.canonical_field ?? e.field_id),
  );
}

export class GreenhouseLiveFillError extends Error {
  readonly report: GreenhouseLiveFillReport;
  constructor(message: string, report: GreenhouseLiveFillReport) {
    super(message);
    this.name = "GreenhouseLiveFillError";
    this.report = report;
  }
}

/**
 * Re-run the full read-only safety gate on the page we are about to mutate.
 * inspectGreenhouseApplication proves a URL on its own page load; this proves
 * the page actually in hand, so nothing is typed into an unverified document.
 * Exported for the Phase 7 submission path, which must pass the same gate.
 */
export async function verifyPageBeforeMutation(
  page: Page,
  requestedUrl: string,
  normalizedUrl: string | null,
): Promise<{
  ok: boolean;
  finalUrl: string;
  html: string;
  title: string;
  identity: GreenhouseIdentityVerification | null;
  captcha: CaptchaDetection | null;
  loginWall: LoginWallDetection | null;
  failureCode: string | null;
  reason: string | null;
}> {
  const finalUrl = page.url();
  const title = (await page.title().catch(() => "")) || "";
  const html = await page.content();

  const nav = verifyFinalNavigation({
    requestedUrl: normalizedUrl ?? requestedUrl,
    finalUrl,
  });
  if (!nav.passed) {
    return {
      ok: false,
      finalUrl,
      html,
      title,
      identity: null,
      captcha: null,
      loginWall: null,
      failureCode: nav.failureCode,
      reason: nav.failureReason,
    };
  }

  const adapter = new GreenhouseAdapterV1();
  const fields = await adapter.discoverFields({ html });
  const formDetected = greenhouseSelectorsV1.formMarkers.test(html);
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected,
    fieldCount: fields.length,
  });
  const loginWall = detectLoginWall({ finalUrl, html, title });

  const identity = verifyGreenhousePageIdentity({
    requestedUrl,
    finalUrl,
    requestedJobId: extractGreenhouseJobIdFromUrl(normalizedUrl ?? requestedUrl),
    observedJobId: extractGreenhouseJobIdFromUrl(finalUrl),
    company: extractBoardTokenFromUrl(finalUrl),
    role: title || null,
    formDetected: formDetected || fields.length > 0,
    fieldCount: fields.length,
    captchaDetected: captcha.detected,
    loginWall,
    closedJobDetected: detectClosedJobSignals(html, title),
    errorPageDetected: detectErrorPageSignals(html, title),
  });

  return {
    ok: identity.passed,
    finalUrl,
    html,
    title,
    identity,
    captcha,
    loginWall,
    failureCode: identity.failureCode,
    reason: identity.failureReason,
  };
}

/** Job-boards parses an uploaded resume and re-renders; fill only after it settles. */
const RESUME_PARSE_SETTLE_MS = 2_500;
const LANDING_SETTLE_MS = 12_000;
const LANDING_POLL_MS = 400;

/**
 * Company-domain Greenhouse boards (Jump Trading, Datadog, …) are SPAs.
 * First paint is an empty shell; JSON in a <script> can say "apply" and
 * classify as a posting before any button exists. Wait for a real Apply
 * control, a form, an auth wall, or a fillable iframe — not a regex hit.
 */
async function settleGreenhouseLanding(page: Page): Promise<void> {
  const deadline = Date.now() + LANDING_SETTLE_MS;
  while (Date.now() < deadline) {
    const html = await page.content();
    const landing = classifyPage({ html, url: page.url() });
    if (
      landing.page_class === "form" ||
      landing.page_class === "auth" ||
      landing.page_class === "captcha"
    ) {
      return;
    }
    if (await findApplicationFrameUrl(page)) return;
    if (await findApplyControl(page).catch(() => null)) return;
    await page.waitForTimeout(LANDING_POLL_MS);
  }
}

async function hopEmbeddedForm(
  page: Page,
  notes: string[],
): Promise<boolean> {
  const topFields = discoverFieldsFromHtml(await page.content());
  // Listing chrome (search boxes) used to abort the hop because "fields > 0".
  // Only a real applicant-identity form is already the destination.
  if (hasApplicationIdentityFields(topFields)) return false;
  const frameForm = await findApplicationFrameUrl(page);
  if (!frameForm) return false;
  const why =
    frameForm.fieldCount > 0
      ? `${frameForm.fieldCount} fields`
      : "Greenhouse embed URL, document not readable yet";
  notes.push(
    `application form found in an iframe (${why}) — hopping to ${frameForm.url}`,
  );
  try {
    await page.goto(frameForm.url, { waitUntil: "domcontentloaded" });
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    notes.push(`iframe hop navigation failed: ${message.slice(0, 120)}`);
    return false;
  }
}

/**
 * Live 2026-08-30 (Zipline): job-boards.greenhouse.io/flyzipline/jobs/<id>
 * 302s to www.zipline.com/open-roles?gh_jid=<id> — a listing page whose
 * only inputs are its "Search roles" boxes, with NO Apply control and NO
 * embed iframe in any frame. Apply + hop both miss, and the fill then ran
 * on the search boxes (and the predictor learned "Search roles" as a
 * screener). Greenhouse's canonical embed app is deterministic from the
 * board token + job id we already hold, so a ?gh_jid= shell with nothing
 * to hop to gets ONE direct navigation there. Null when either half is
 * unknown or the page is already an embed.
 */
export function greenhouseEmbedFallbackUrl(
  requestedUrl: string,
  normalizedUrl: string | null,
  finalUrl: string,
): string | null {
  let final: URL;
  try {
    final = new URL(finalUrl);
  } catch {
    return null;
  }
  if (/greenhouse\.io$/i.test(final.hostname) && /\/embed\/job_app/i.test(final.pathname)) {
    return null;
  }
  const jobId =
    extractGreenhouseJobIdFromUrl(finalUrl) ??
    extractGreenhouseJobIdFromUrl(normalizedUrl ?? requestedUrl);
  const board =
    extractBoardTokenFromUrl(normalizedUrl ?? requestedUrl) ??
    extractBoardTokenFromUrl(requestedUrl) ??
    extractBoardTokenFromUrl(finalUrl);
  if (!jobId || !board) return null;
  return `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(jobId)}`;
}

function describeFrames(page: Page): string {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    const url = frame.url() || "(empty)";
    parts.push(frame === page.mainFrame() ? `main ${url}` : url);
  }
  return `frames: ${parts.join(" | ")}`.slice(0, 360);
}

export type GreenhouseMutationGate = Awaited<
  ReturnType<typeof verifyPageBeforeMutation>
>;

/**
 * Same landing recovery fill and submit must share: SPA settle, iframe hop,
 * then Apply on a posting/unknown shell. Returns the page to continue on
 * (a popup, if Apply opened one). Does not click Submit.
 */
/**
 * A gate result that must NOT be filled as-is: either it failed on a
 * missing form, or it PASSED on page chrome. Live 2026-08-29 (samsara
 * ?gh_jid= landing): the gate passed with 2 fields — the site footer's
 * "Select region" pickers — the fill "verified" those and READY_TO_SUBMIT
 * carried junk until the upload guard refused. A greenhouse application
 * form always carries applicant-identity fields; a passing gate without
 * them is a posting shell that still needs Apply + iframe hop.
 */
export function gateLooksLikePostingShell(gate: {
  ok: boolean;
  failureCode?: string | null;
  html: string;
}): boolean {
  if (!gate.ok) {
    return (
      gate.failureCode === "FORM_NOT_FOUND" ||
      gate.failureCode === "ZERO_FIELDS"
    );
  }
  return !hasApplicationIdentityFields(discoverFieldsFromHtml(gate.html));
}

export async function reachGreenhouseApplicationForm(
  page: Page,
  requestedUrl: string,
  normalizedUrl: string | null,
  options?: { dismissObstructions?: boolean },
): Promise<{
  page: Page;
  gate: GreenhouseMutationGate;
  notes: string[];
}> {
  const notes: string[] = [];
  let working = page;
  if (options?.dismissObstructions) {
    const obstructions = await dismissPageObstructions(working);
    if (obstructions.dismissed.length > 0) {
      notes.push(`popups dismissed: ${obstructions.dismissed.join(", ")}`);
    }
  }
  await settleGreenhouseLanding(working);
  let gate = await verifyPageBeforeMutation(
    working,
    requestedUrl,
    normalizedUrl,
  );
  if (await hopEmbeddedForm(working, notes)) {
    await settleGreenhouseLanding(working);
    gate = await verifyPageBeforeMutation(working, requestedUrl, normalizedUrl);
  }
  if (gate.ok && gateLooksLikePostingShell(gate)) {
    notes.push(
      "gate passed but the page has no applicant-identity fields — treating as posting shell (samsara-type chrome), running Apply + hop recovery",
    );
  }
  if (gateLooksLikePostingShell(gate)) {
    const advance = await advancePastPosting({
      page: working,
      html: gate.html,
      url: gate.finalUrl,
    });
    notes.push(...advance.notes);
    working = advance.page;
    // Always retry hop after Apply miss. hops===0 used to skip this, so a
    // late Greenhouse iframe never got a second look.
    const hopped = await hopEmbeddedForm(working, notes);
    if (hopped || advance.hops > 0 || advance.page !== page) {
      if (hopped) await settleGreenhouseLanding(working);
      gate = await verifyPageBeforeMutation(
        working,
        requestedUrl,
        normalizedUrl,
      );
    }
    if (gateLooksLikePostingShell(gate)) {
      await settleGreenhouseLanding(working);
      if (await hopEmbeddedForm(working, notes)) {
        await settleGreenhouseLanding(working);
        gate = await verifyPageBeforeMutation(
          working,
          requestedUrl,
          normalizedUrl,
        );
      } else {
        notes.push(
          `no hopable iframe after landing miss — ${describeFrames(working)}`,
        );
        const embedUrl = greenhouseEmbedFallbackUrl(requestedUrl, normalizedUrl, gate.finalUrl);
        if (embedUrl) {
          notes.push(`posting shell without Apply or iframe — navigating to the canonical embed app ${embedUrl}`);
          try {
            await working.goto(embedUrl, { waitUntil: "domcontentloaded" });
            await settleGreenhouseLanding(working);
            gate = await verifyPageBeforeMutation(working, requestedUrl, normalizedUrl);
          } catch (e) {
            notes.push(
              `embed fallback navigation failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
            );
          }
        }
      }
    }
    // Still chrome after every rung: refuse. Filling a listing page's search
    // boxes "verified" nothing and poisoned the screener bank (live 2026-08-30).
    if (gate.ok && gateLooksLikePostingShell(gate)) {
      notes.push("application form never reached — refusing to fill page chrome");
      gate = {
        ...gate,
        ok: false,
        failureCode: "FORM_NOT_FOUND",
        reason:
          "posting shell: no Apply control, no embed iframe, and no canonical embed reachable — application form never rendered",
      };
    }
  }
  return { page: working, gate, notes };
}

function tryRecordFillOutcomes(
  report: GreenhouseLiveFillReport,
  reportRelpath: string,
  capture?: { db?: Db; applicationId: string | null },
): void {
  if (report.mode !== "executed" || !report.mutation_attempted) return;

  const planEntries = (report.approved_plan?.entries ?? report.plan.entries).map(
    (e) => {
      const base = {
        field_id: e.field_id,
        label: e.label,
        type: e.type as string,
        canonical_field: e.canonical_field ?? null,
        action: String(e.action),
        value: e.value,
        reason: e.reason,
      };
      if ("approved" in e && typeof (e as { approved?: boolean }).approved === "boolean") {
        return {
          ...base,
          approved: (e as { approved: boolean }).approved,
        };
      }
      return base;
    },
  );

  recordFillRun({
    mode: "executed",
    // A threaded capture means the pipeline invoked us for a tracked
    // application — recording "cli_url"/NULL there broke the corpus join.
    source: capture?.applicationId ? "pipeline" : "cli_url",
    application_id: capture?.applicationId ?? null,
    ats: report.ats,
    job_url: report.final_url ?? report.url,
    company: report.identity_verification?.company ?? null,
    role: report.identity_verification?.role ?? null,
    job_id_observed: report.identity_verification?.observedJobId ?? null,
    mutation_attempted: report.mutation_attempted,
    validation_level: report.validation_level,
    fillable_count:
      report.approved_plan?.fillable_count ?? report.plan.fillable_count,
    skipped_count:
      report.approved_plan?.skipped_count ?? report.plan.skipped_count,
    report_artifact_relpath: reportRelpath,
    notes: report.notes,
    metadata: {
      captcha_detection: report.captcha_detection,
      login_wall_detection: report.login_wall_detection,
      failure_code: report.failure_code,
    },
    plan_entries: planEntries,
    fill: report.fill ?? null,
    verify: report.verify ?? null,
    uploads: report.uploads ?? null,
    heal: report.heal ?? null,
  },
  capture?.db ? { db: capture.db } : {});
}

function persist(
  report: GreenhouseLiveFillReport,
  capture?: { db?: Db; applicationId: string | null },
): GreenhouseLiveFillReport {
  const outDir = path.join(getConfig().artifactsDir, "ats-fill", "greenhouse-live");
  fs.mkdirSync(outDir, { recursive: true });
  // #165: ONE FILE PER RUN. This wrote a fixed "live-fill-report.json", so
  // every executed fill overwrote the last one — 191 recorded Greenhouse
  // runs (2026-08-07 → 09-03) all carry that same report_artifact_relpath,
  // and each row points at whichever run happened to write LAST. The Five
  // Rings School* diagnosis on 2026-09-03 lost its evidence to a run that
  // landed three minutes later. Everything that reads the recorded path
  // back — the submit-inventory healer, the console read models, a human
  // debugging a parked application — was reading a different run's fill.
  // Same shape atsLiveFill already writes for ashby/generic/workday.
  const file = path.join(outDir, `live-${report.mode}-${Date.now()}.json`);

  // SQLite outcomes first (uses raw report values) then redacted artifact.
  tryRecordFillOutcomes(report, path.relative(getConfig().artifactsDir, file), capture);

  const redacted = {
    ...redactFillReportForArtifact(report),
    validation_level: report.validation_level,
    final_url: report.final_url,
    identity_verification: report.identity_verification,
    captcha_detection: report.captcha_detection,
    login_wall_detection: report.login_wall_detection,
    failure_code: report.failure_code,
    mutation_attempted: report.mutation_attempted,
    written_at: new Date().toISOString(),
  };
  writeJsonAtomic(file, redacted);
  return { ...report, report_path: file };
}

/**
 * Guarded live Greenhouse fill. Deterministic allowlist fields only; essays,
 * demographics and invented sponsorship are rejected upstream by the approved
 * plan. Submit is never called — the adapter's submit path throws regardless.
 */
export async function runGreenhouseLiveFill(input: {
  url: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  coverLetterPath?: string;
  headless?: boolean;
  /** Forwarded to planApplicationFill: unanswered questions become "Answer needed" review items on this application. */
  capture?: { db: Db; applicationId: string | null };
  /**
   * Session handoff (nav N6): run on this page — typically CDP-attached so
   * cookies survive from navigation. Caller owns its lifetime; this runner
   * navigates it but never closes it.
   */
  existingPage?: Page;
}): Promise<GreenhouseLiveFillReport> {
  const urlValidation = validateGreenhouseApplicationUrl(input.url);
  const base: GreenhouseLiveFillReport = {
    mode: input.execute ? "executed" : "plan_only",
    ats: "greenhouse",
    url: input.url,
    plan: { answers: {}, entries: [], fillable_count: 0, skipped_count: 0, review_required_count: 0 },
    submit_attempted: false,
    notes: [],
    validation_level: "UNVERIFIED",
    final_url: null,
    identity_verification: null,
    captcha_detection: null,
    login_wall_detection: null,
    failure_code: null,
    mutation_attempted: false,
  };

  if (!urlValidation.passed) {
    base.failure_code = "UNSAFE_FINAL_URL";
    base.notes.push(urlValidation.failureReason ?? "URL validation failed");
    throw new GreenhouseLiveFillError(
      `Refusing live fill: ${urlValidation.failureReason ?? "invalid Greenhouse application URL"}`,
      persist(base, input.capture),
    );
  }

  // Resume preflight — hard error before any browser opens, regardless of
  // gates, so a wrong path is the FIRST thing the operator sees, not a
  // soft `verified:false` after the form is nearly complete.
  if (input.resumePath) {
    const abs = path.resolve(input.resumePath);
    const check = verifyResumePdfFile(abs);
    if (!check.verified) {
      base.failure_code = "RESUME_FILE_INVALID";
      base.notes.push(`resume preflight failed: ${abs} — ${check.evidence}`);
      throw new GreenhouseLiveFillError(
        `Resume file failed preflight: ${abs} — ${check.evidence}`,
        persist(base, input.capture),
      );
    }
  }

  // Fail before opening a browser if flags are wrong.
  if (input.execute) {
    assertFormFillAllowed("greenhouse.liveFill");
  }

  const runInPage = async (
    fn: (page: Page) => Promise<GreenhouseLiveFillReport>,
  ): Promise<GreenhouseLiveFillReport> => {
    if (input.existingPage) {
      const page = input.existingPage;
      base.notes.push("session: handoff (caller-owned page, not closed here)");
      await page.goto(urlValidation.normalizedUrl ?? input.url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return fn(page);
    }
    return withPublicUrlPage(urlValidation.normalizedUrl ?? input.url, fn, {
      headless: input.headless ?? false,
    });
  };

  return runInPage(
    async (startPage) => {
      const reached = await reachGreenhouseApplicationForm(
        startPage,
        input.url,
        urlValidation.normalizedUrl,
        { dismissObstructions: input.execute },
      );
      let page = reached.page;
      let gate = reached.gate;
      base.notes.push(...reached.notes);
      base.final_url = gate.finalUrl;
      base.identity_verification = gate.identity;
      base.captcha_detection = gate.captcha;
      base.login_wall_detection = gate.loginWall;
      base.failure_code = gate.failureCode;

      const tryPortalAuth =
        input.execute &&
        gate.failureCode === "LOGIN_WALL" &&
        getConfig().navigationEnabled &&
        isRecognizedAtsAuthHost(page.url());

      let verified = gate;
      if (!verified.ok && tryPortalAuth) {
        const obstructions = await dismissPageObstructions(page);
        if (obstructions.dismissed.length > 0) {
          base.notes.push(`popups dismissed: ${obstructions.dismissed.join(", ")}`);
        }
        const auth = await authenticateAtsPortal(page);
        void auth.secrets;
        base.notes.push(...auth.notes);
        if (
          auth.status !== "signed_in" &&
          auth.status !== "account_created"
        ) {
          base.failure_code = "AUTH_REQUIRED";
          base.notes.push(
            gate.reason ?? `portal auth did not clear the wall (${auth.status})`,
          );
          throw new GreenhouseLiveFillError(
            `Refusing live fill (AUTH_REQUIRED): portal auth did not clear the wall (${auth.status})`,
            persist(base, input.capture),
          );
        }
        verified = await verifyPageBeforeMutation(
          page,
          input.url,
          urlValidation.normalizedUrl,
        );
        base.final_url = verified.finalUrl;
        base.identity_verification = verified.identity;
        base.captcha_detection = verified.captcha;
        base.login_wall_detection = verified.loginWall;
        base.failure_code = verified.failureCode;
      }

      // C2: a blocking CAPTCHA on a HEADED run pauses in place first — the
      // operator is looking at the challenge, so a bounded wait beats a
      // park + requeue round-trip. Headless never pauses. Recorded as a
      // classed incident (host + provider only) either way.
      if (!verified.ok && verified.captcha?.detected) {
        const pause = await pauseForHumanCaptcha(page, {
          attended: (input.headless ?? false) === false,
        });
        base.captcha_incident = buildCaptchaIncident({
          surface: "greenhouse_live_fill",
          url: verified.finalUrl,
          signals: verified.captcha.signals,
          pause,
        });
        base.notes.push(...pause.notes);
        if (pause.cleared) {
          verified = await verifyPageBeforeMutation(
            page,
            input.url,
            urlValidation.normalizedUrl,
          );
          base.final_url = verified.finalUrl;
          base.identity_verification = verified.identity;
          base.captcha_detection = verified.captcha;
          base.login_wall_detection = verified.loginWall;
          base.failure_code = verified.failureCode;
        }
      }

      if (!verified.ok) {
        base.notes.push(verified.reason ?? "page failed verification");
        throw new GreenhouseLiveFillError(
          `Refusing live fill (${verified.failureCode}): ${verified.reason}`,
          persist(base, input.capture),
        );
      }

      // Cookie banners / consent modals block clicks under them — clear
      // before mutating. Execute-only: plan_only stays zero-mutation.
      if (input.execute) {
        const obstructions = await dismissPageObstructions(page);
        if (obstructions.dismissed.length > 0) {
          base.notes.push(`popups dismissed: ${obstructions.dismissed.join(", ")}`);
        }
      }
      // Answer spaces BEFORE planning — the same pipeline atsLiveFill got
      // in c9be0b5, which this dedicated runner never did. Live run
      // 2a9f9930 (neuralink): the relocation combobox got "Baltimore,
      // Maryland…" typed into it ("no option matches"), the season select
      // parked, and the report carried no harvested_options at all —
      // because this runner still planned HTML-only. Board API first (one
      // request, complete lists), then the DOM harvest for what's left.
      // G1: the board-API fetch runs in BOTH modes — it is a network
      // read, so plan_only's zero-interaction promise holds. Only the DOM
      // harvest stays execute-only.
      const declared = await fetchGreenhouseQuestions(verified.finalUrl).catch(
        () => null,
      );
      let harvest: OptionHarvestResult | null = null;
      let declaredOnly: {
        options: Map<string, string[]>;
        answerSpace: Map<string, AnswerSpace>;
      } | null = null;
      {
        let planFields = discoverFieldsFromHtml(verified.html);
        let apiOptions = new Map<string, string[]>();
        let apiAnswerSpace = new Map<string, AnswerSpace>();
        if (declared) {
          // G3: reconcile BEFORE the merge overwrites DOM option lists.
          base.schema_diff = diffDeclaredVsDom(planFields, declared);
          base.notes.push(summarizeSchemaDiff(base.schema_diff));
          const merged = mergeDeclaredQuestions(planFields, declared.byLabel);
          planFields = merged.fields;
          apiOptions = merged.options;
          apiAnswerSpace = merged.answerSpace;
          base.notes.push(
            `board API declared ${declared.questions.length} question(s); matched complete option lists onto ${merged.matched} field(s)${
              input.execute ? "" : " (plan_only — API options, no DOM harvest)"
            }`,
          );
        }
        if (input.execute) {
          harvest = await harvestFieldOptions(page, planFields);
          base.notes.push(...harvest.notes);
          for (const [id, options] of apiOptions) {
            harvest.options.set(id, options);
            harvest.answerSpace.set(id, "closed");
          }
          base.harvested_options = harvest.harvested.map((h) => ({
            field_id: h.field_id,
            label: h.label,
            answer_space: h.answer_space,
            option_count: h.options.length,
            options: h.options.slice(0, 25),
            other_option: h.other_option,
          }));
        } else if (apiOptions.size > 0) {
          declaredOnly = { options: apiOptions, answerSpace: apiAnswerSpace };
        }
      }
      const { adapter, plan, approvedPlan, fields: plannedFields, otherFallbacks } =
        await planApplicationFill({
          url: verified.finalUrl,
          html: verified.html,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.capture ? { capture: input.capture } : {}),
          ...(harvest ? { liveOptions: harvest.options } : {}),
          ...(harvest ? { answerSpace: harvest.answerSpace } : {}),
          ...(!harvest && declaredOnly
            ? {
                liveOptions: declaredOnly.options,
                answerSpace: declaredOnly.answerSpace,
              }
            : {}),
        });
      base.plan = plan;
      base.approved_plan = approvedPlan;

      if (!input.execute) {
        base.mode = "plan_only";
        base.validation_level = "LIVE_READ_ONLY_CONFIRMED";
        base.notes.push(
          "plan_only — no mutation. Set --execute with FORM_FILL_ENABLED=true and DRY_RUN=false to fill.",
        );
        return persist(base, input.capture);
      }

      // Re-assert immediately before the first mutation.
      assertFormFillAllowed("greenhouse.liveFill.execute");
      base.mutation_attempted = true;

      // Order: fill fields → verify/heal → upload last → freeze.
      // Combobox work re-renders job-boards and can wipe a pristine-zone
      // attach if we uploaded first; leave file inputs until values stick.
      logger.info("live fill: applying approved field plan", {
        service: "greenhouse",
        action: "fill",
        metadata: {
          fillable_count: approvedPlan.fillable_count,
          answer_keys: Object.keys(approvedPlan.answers),
        },
      });
      const knownFieldIds = new Set(plannedFields.map((f) => f.id));
      // Upload FIRST (night19 #49, DV Trading + Neuralink): job-boards
      // re-parses the resume on upload and re-renders the form; an upload
      // AFTER the fill wiped verified comboboxes and the re-fill on filled
      // react-selects mis-committed. Upload, let the parse settle, then
      // fill over whatever it prefilled, then verify.
      const uploads: Awaited<ReturnType<typeof adapter.uploadResume>>[] = [];
      if (input.resumePath) {
        const fileInputsBefore = await inventoryFileInputs(page);
        if (fileInputsBefore.length > 0) {
          logger.info("live fill: uploading resume before the fill", {
            service: "greenhouse",
            action: "upload",
          });
          const early = await adapter.uploadResume(page, input.resumePath);
          uploads.push(early);
          if (early.verified && !/already attached/.test(early.evidence)) {
            await page.waitForTimeout(RESUME_PARSE_SETTLE_MS);
          }
        }
      }
      base.fill = await adapter.fill(page, approvedPlan.answers);
      // "Other" chosen on a closed list reveals a specify box that only
      // exists after the option commits — the real answer goes in there.
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
        base.other_specify = specified;
        base.notes.push(...specified.map((s) => `other-specify: ${s.note}`));
      }
      logger.info("live fill: field plan applied", {
        service: "greenhouse",
        action: "fill",
        metadata: {
          filled: base.fill.filled.length,
          skipped: base.fill.skipped.length,
          errors: base.fill.errors.length,
        },
      });

      logger.info("live fill: verifying field read-back", {
        service: "greenhouse",
        action: "verify",
      });
      base.verify = await adapter.verify(page, approvedPlan.answers);

      // Phase 6a′: heal read-back failures (heuristic always; sidecar only
      // behind AGENT_FALLBACK_ENABLED), then re-verify deterministically.
      if (!base.verify.passed) {
        const failedBefore = failedApprovedEntries(approvedPlan, base.verify);
        if (failedBefore.length > 0) {
          const heal = await healFailedFillEntries({
            page,
            failedEntries: failedBefore,
          });
          base.heal = heal;
          // Always re-verify and derive the note from FINAL truth: fields
          // that actually flipped fail→pass — never from the heal report's
          // own claims (the 774cc9b-era "8/8 recovered" lie).
          base.verify = await adapter.verify(page, approvedPlan.answers);
          const failedAfter = new Set(
            failedApprovedEntries(approvedPlan, base.verify).map(
              (e) => e.field_id,
            ),
          );
          const recovered = failedBefore.filter(
            (e) => !failedAfter.has(e.field_id),
          ).length;
          base.notes.push(
            `heal pass: recovered ${recovered}/${failedBefore.length}; final verify passed: ${base.verify.passed}` +
              (heal.sidecar_used ? " (sidecar consulted)" : ""),
          );
        }
      }

      // Late upload only when the page had no file input before the fill
      // (revealed by the fill) — the pre-fill upload above is the norm.
      if (input.resumePath && uploads.length === 0) {
        const fileInputs = await inventoryFileInputs(page);
        if (fileInputs.length === 0) {
          base.notes.push(
            "resume on disk but this page has no file input — not an upload miss",
          );
        } else {
          logger.info("live fill: uploading resume", {
            service: "greenhouse",
            action: "upload",
          });
          uploads.push(await adapter.uploadResume(page, input.resumePath));
        }
      }
      if (input.coverLetterPath && adapter.uploadCoverLetter) {
        logger.info("live fill: uploading cover letter", {
          service: "greenhouse",
          action: "upload",
        });
        uploads.push(
          await adapter.uploadCoverLetter(page, input.coverLetterPath),
        );
      } else if (input.coverLetterPath) {
        base.notes.push(
          `cover letter skipped — ${adapter.id} has no cover-letter file input`,
        );
      }
      if (uploads.length > 0) {
        base.uploads = uploads;
        const bad = uploads.filter((u) => !u.verified);
        if (bad.length > 0) {
          base.notes.push(
            `upload not verified after fill: ${bad.map((u) => u.field).join(", ")}`,
          );
        }
      }

      base.notes.push(
        "frozen after fill→verify→upload — no further field mutation; submit never called",
      );
      const uploadsOk =
        !base.uploads?.length || base.uploads.every((u) => u.verified);
      base.validation_level =
        base.verify.passed && uploadsOk
          ? "LIVE_MUTATION_CONFIRMED"
          : "UNVERIFIED";
      if (base.validation_level === "UNVERIFIED" && base.verify) {
        const brief = buildOperatorFieldBrief({
          context: `Live fill — greenhouse ${base.final_url ?? base.url}`,
          verify: base.verify,
          fill: base.fill,
          upload: base.uploads?.find((u) => !u.verified) ?? null,
          planEntries: briefFromApproved(approvedPlan),
        });
        base.operator_brief = brief;
        printOperatorFieldBrief(brief);
      }
      return persist(base, input.capture);
    },
  );
}
