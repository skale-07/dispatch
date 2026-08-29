/**
 * Supplemental material uploads beyond the resume — currently the
 * operator's unofficial transcript (private/candidate/transcript.pdf).
 *
 * Live 2026-08-29 (Appian 52578119): the form was fully filled and the
 * click bounced off "Please upload a copy of an unofficial undergraduate
 * transcript" while the file sat on disk. This pass attaches KNOWN
 * operator materials to file inputs whose own label/context names them.
 * Fail-closed: no file on disk ⇒ note and skip; no matching input ⇒
 * nothing touched; attachment is verified by reading input.files back.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getConfig } from "../../config/index.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";

export type SupplementalAttachment = {
  kind: "transcript";
  label: string;
  verified: boolean;
};

export type SupplementalResult = {
  attached: SupplementalAttachment[];
  notes: string[];
};

export function defaultTranscriptPath(): string {
  return path.join(getConfig().privateDir, "candidate", "transcript.pdf");
}

export async function attachSupplementalMaterials(
  page: Page,
  options?: { transcriptPath?: string },
): Promise<SupplementalResult> {
  const result: SupplementalResult = { attached: [], notes: [] };
  const transcriptPath = options?.transcriptPath ?? defaultTranscriptPath();
  if (!fs.existsSync(transcriptPath)) {
    result.notes.push("no transcript on file — transcript inputs left alone");
    return result;
  }

  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  for (const frame of frames) {
    const inputs = frame.locator('input[type="file"]');
    const n = Math.min(await inputs.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      const input = inputs.nth(i);
      const meta = await input
        .evaluate(
          (el: {
            id?: string;
            getAttribute: (n: string) => string | null;
            files?: ArrayLike<unknown> | null;
            closest: (sel: string) => { textContent?: string | null } | null;
            ownerDocument: {
              querySelector: (
                s: string,
              ) => { textContent?: string | null } | null;
            };
          }) => {
            const idname = `${el.id ?? ""} ${el.getAttribute("name") ?? ""}`;
            let label = "";
            if (el.id) {
              const lab = el.ownerDocument.querySelector(
                `label[for="${el.id}"]`,
              );
              if (lab?.textContent) label = lab.textContent;
            }
            const context =
              el.closest("section, fieldset, div")?.textContent ?? "";
            return {
              idname,
              label: label.replace(/\s+/g, " ").trim().slice(0, 120),
              context: context.replace(/\s+/g, " ").trim().slice(0, 300),
              fileCount: el.files ? el.files.length : 0,
            };
          },
        )
        .catch(() => null);
      if (!meta || meta.fileCount > 0) continue;
      const blob = `${meta.idname} ${meta.label} ${meta.context}`;
      if (!/transcript/i.test(blob)) continue;
      // Never place the transcript into a resume/cover input that merely
      // mentions transcripts in surrounding copy.
      if (/resume|\bcv\b|cover[\s_-]*letter/i.test(`${meta.idname} ${meta.label}`)) {
        continue;
      }
      assertFormFillAllowed("supplemental.transcript");
      try {
        await input.setInputFiles(transcriptPath, { timeout: 10_000 });
      } catch (err) {
        result.notes.push(
          `transcript attach failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        );
        continue;
      }
      const verified = await input
        .evaluate(
          (el: { files?: ArrayLike<unknown> | null }) =>
            (el.files ? el.files.length : 0) > 0,
        )
        .catch(() => false);
      result.attached.push({
        kind: "transcript",
        label: meta.label || meta.context.slice(0, 60),
        verified,
      });
    }
  }
  if (result.attached.length === 0) {
    result.notes.push("no empty transcript-labeled file input found");
  }
  return result;
}
