import type { Page } from "playwright";
import type {
  SubmissionAttempt,
  SubmissionReceipt,
  SubmitClickOptions,
} from "../adapter.js";
import { CLICK_WITHHELD_NOTE } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "../greenhouse/identityVerification.js";
import { workdaySelectorsV1 } from "./selectors.js";
import {
  SubmissionUncertainError,
  detectVisibleValidationError,
} from "../shared/submissionUncertain.js";

export { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export type WorkdaySubmissionClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

/**
 * Pure classification of the page after the FINAL wizard submit. Same
 * shape as the Lever/Workable classifier: confirmation text with the
 * wizard gone → confirmed; error signals beat everything; a remaining
 * wizard page → still_on_form; else unknown (errs to review).
 */
export function detectWorkdaySubmission(
  html: string,
  finalUrl: string,
): WorkdaySubmissionClassification {
  void finalUrl;
  if (
    workdaySelectorsV1.confirmationMarkers.test(html) &&
    !workdaySelectorsV1.wizard.pageMarkers.test(html)
  ) {
    return "confirmed";
  }
  if (detectErrorPageSignals(html, "")) {
    return "error_page";
  }
  if (workdaySelectorsV1.wizard.pageMarkers.test(html)) {
    return "still_on_form";
  }
  return "unknown";
}

/**
 * Click the FINAL Workday submit (bottom-navigation-submit-button). Only
 * the true submit — never a wizard "Next" — reaches here; assertSubmitAllowed
 * is the last line of defense.
 */
export async function workdaySubmit(
  page: Page,
  opts: SubmitClickOptions = {},
): Promise<SubmissionAttempt> {
  assertSubmitAllowed("workday.submit");
  let control = page.locator(workdaySelectorsV1.wizard.submitButton).first();
  const notes: string[] = [];
  if ((await control.count().catch(() => 0)) === 0) {
    // #106b (live tiaa): the tenant reuses pageFooterNextButton for the
    // Review Submit — only the TEXT distinguishes it. Exact-name "Submit"
    // inside the footer container can never be a wizard Next ("Save and
    // Continue"/"Next"/"Continue"), preserving the never-click-a-Next
    // invariant by text where the id cannot carry it.
    const footerSubmit = page
      .locator("[data-automation-id='pageFooter'], [data-automation-id='footerContainer'], [data-automation-id='bottom-navigation']")
      .getByRole("button", { name: "Submit", exact: true })
      .first();
    if ((await footerSubmit.count().catch(() => 0)) > 0) {
      control = footerSubmit;
      notes.push(
        "workday submit resolved by exact footer text \"Submit\" (tenant reuses the Next button's automation id)",
      );
    } else {
      return {
        clicked: false,
        notes: [
          "workday final submit control not found (not on the Review page?)",
        ],
      };
    }
  }
  if (await control.isDisabled().catch(() => false)) {
    return { clicked: false, notes: ["workday submit control disabled"] };
  }
  if (opts.beforeClick && !(await opts.beforeClick())) {
    return { clicked: false, notes: [CLICK_WITHHELD_NOTE] };
  }
  await control.click({ timeout: 10_000 });
  notes.push("workday submit control clicked");
  await page.waitForTimeout(2_000);
  return { clicked: true, notes };
}

export async function workdayVerifySubmission(
  page: Page,
  options: { screenshotPath: string; timeoutMs?: number },
): Promise<SubmissionReceipt> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let classification: WorkdaySubmissionClassification = "unknown";
  let html = "";
  let validationError: string | null = null;
  while (Date.now() < deadline) {
    try {
      html = await page.content();
    } catch {
      await page.waitForTimeout(500);
      continue;
    }
    classification = detectWorkdaySubmission(html, page.url());
    if (classification === "confirmed" || classification === "error_page") break;
    await page.waitForTimeout(1_000);
  }
  await page
    .screenshot({ path: options.screenshotPath, fullPage: true })
    .catch(() => undefined);
  if (classification !== "confirmed") {
    throw new SubmissionUncertainError(
      validationError
        ? `Workday submission rejected by the form: "${validationError}" (page classified: ${classification})`
        : `Workday submission not confirmed within ${timeoutMs}ms (page classified: ${classification})`,
      {
        classification,
        validation_error: validationError,
        final_url: page.url(),
        screenshot_path: options.screenshotPath,
        html_bytes: html.length,
      },
    );
  }
  const matched = html.match(workdaySelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text: matched?.[0] ?? "confirmation markers matched",
    application_identifier: null,
    screenshot_path: options.screenshotPath,
  };
}
