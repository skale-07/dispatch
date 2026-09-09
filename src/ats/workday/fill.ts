import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { FormResetResult, UploadVerification } from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../shared/uploadResolve.js";
import { workdaySelectorsV1 } from "./selectors.js";

/**
 * Workday-bound fill helpers. Native-input fill reuses the generic
 * executor (../greenhouse/fill.ts); only upload and the resume-autofill
 * kickoff need Workday's own selectors.
 */

export async function workdayUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`workday.upload.${kind}`);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: 0,
      verified: false,
      evidence: "file missing",
    };
  }
  const stat = fs.statSync(abs);
  const filename = path.basename(abs);
  const resolution = await resolveResumeFileInput(page, {
    css: workdaySelectorsV1.wizard.resumeUpload,
  });
  if (!resolution.found) {
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: `resume file input not found; ${resolution.notes.join("; ")}`,
    };
  }
  await resolution.input.setInputFiles(abs);
  const commit = await detectUploadCommit(page, resolution.input, {
    filename,
    sizeBytes: stat.size,
  });
  return {
    field: kind,
    path: abs,
    filename,
    size_bytes: stat.size,
    verified: commit.verified,
    evidence: `${commit.evidence}; resolved via ${resolution.via}`,
  };
}

/**
 * #198: close any open Workday header menu that sits over the wizard.
 * Escape first (Workday menus honour it), then a click on the page's own
 * heading as a neutral blur target. Never clicks inside the menu. Bounded
 * to two rounds; returns what it saw for the run notes.
 */
export async function closeWorkdayHeaderMenus(
  page: Page,
): Promise<{ closed: boolean; notes: string[] }> {
  const notes: string[] = [];
  const open = page.locator(workdaySelectorsV1.header.openMenu).first();
  const visible = async (): Promise<boolean> =>
    (await open.count().catch(() => 0)) > 0 && (await open.isVisible().catch(() => false));
  if (!(await visible())) return { closed: false, notes };
  notes.push("workday header: an open menu overlays the page — closing before fill (#198)");
  for (let round = 0; round < 2; round++) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(300);
    if (!(await visible())) {
      notes.push("workday header: menu closed via Escape");
      return { closed: true, notes };
    }
    const heading = page.locator("main h1, main h2, h1, h2").first();
    if ((await heading.count().catch(() => 0)) > 0) {
      await heading.click({ timeout: 1_500, position: { x: 2, y: 2 } }).catch(() => undefined);
      await page.waitForTimeout(300);
      if (!(await visible())) {
        notes.push("workday header: menu closed via heading click");
        return { closed: true, notes };
      }
    }
  }
  notes.push("workday header: menu still open after Escape + heading click");
  return { closed: false, notes };
}

export async function workdayResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("workday.resetForm");
  // Workday wizards have no single <form> reset — this is a no-op that
  // reports honestly rather than pretending to have cleared state.
  void page;
  return {
    reset: false,
    notes: ["Workday multi-page wizard: no form-level reset available"],
  };
}
