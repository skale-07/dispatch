import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export type JobDetailSnapshot = {
  jobright_job_id: string | null;
  url: string;
  role: string | null;
  company: string | null;
  location: string | null;
  description_text: string | null;
  apply_with_autofill_visible: boolean;
  improve_resume_visible: boolean;
  copy_cover_letter_visible: boolean;
};

export function extractJobIdFromUrl(url: string): string | null {
  const m = url.match(jobrightSelectorsV1.urls.jobInfoUrlPattern);
  return m?.[1] ?? null;
}

export async function readJobDetailSnapshot(page: Page): Promise<JobDetailSnapshot> {
  const url = page.url();
  const jobright_job_id = extractJobIdFromUrl(url);

  // Bounded reads: an absent element must cost seconds, not the 30 s
  // default (a page without a company chip stalled the whole snapshot).
  const READ_TIMEOUT = { timeout: 3_000 } as const;
  const role =
    (await page.locator(jobrightSelectorsV1.feed.jobTitle).first().textContent(READ_TIMEOUT).catch(() => null))?.trim() ??
    null;
  const company =
    (await page
      .locator(jobrightSelectorsV1.feed.companyName)
      .first()
      .textContent(READ_TIMEOUT)
      .catch(() => null))?.trim() ?? null;
  const location =
    (await page
      .locator(jobrightSelectorsV1.feed.primaryLocation)
      .first()
      .textContent(READ_TIMEOUT)
      .catch(() => null))?.trim() ?? null;

  // First region with text wins (#186: the page's <main> disappeared).
  let description_text: string | null = null;
  for (const region of jobrightSelectorsV1.jobDetail.contentRegions) {
    const text = (await page.locator(region).first().innerText({ timeout: 3_000 }).catch(() => null))?.trim();
    if (text) {
      description_text = text.slice(0, 20_000);
      break;
    }
  }

  const apply_with_autofill_visible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.applyWithAutofill.role, {
      name: jobrightSelectorsV1.jobDetail.applyWithAutofill.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  const improve_resume_visible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.improveResume.role, {
      name: jobrightSelectorsV1.jobDetail.improveResume.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  const copy_cover_letter_visible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.copyCoverLetter.role, {
      name: jobrightSelectorsV1.jobDetail.copyCoverLetter.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  return {
    jobright_job_id,
    url,
    role,
    company,
    location,
    description_text,
    apply_with_autofill_visible,
    improve_resume_visible,
    copy_cover_letter_visible,
  };
}

export type DownloadVerification = {
  path: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  verified: boolean;
  evidence: string;
};

export function verifyPdfDownload(filePath: string): DownloadVerification {
  const filename = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      filename,
      size_bytes: 0,
      sha256: "",
      verified: false,
      evidence: "File does not exist",
    };
  }
  const buf = fs.readFileSync(filePath);
  const size_bytes = buf.byteLength;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const isPdf =
    filename.toLowerCase().endsWith(".pdf") &&
    buf.subarray(0, 4).toString("utf8") === "%PDF";
  const verified = isPdf && size_bytes > 0;
  return {
    path: filePath,
    filename,
    size_bytes,
    sha256,
    verified,
    evidence: verified
      ? "PDF magic bytes present and size > 0"
      : "Not a non-empty PDF",
  };
}
