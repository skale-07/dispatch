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
    // Click-created dropzone (Appian 2026-08-29: "Please upload a copy of
    // an unofficial undergraduate transcript" renders Attach/Dropbox/Drive
    // buttons and NO input[type=file] until Attach is clicked). Intercept
    // the filechooser on a transcript-section Attach trigger.
    const viaChooser = await attachTranscriptViaChooser(page, transcriptPath);
    if (viaChooser) {
      result.attached.push(viaChooser);
    } else {
      result.notes.push("no empty transcript-labeled file input found");
    }
  }
  return result;
}

async function attachTranscriptViaChooser(
  page: Page,
  transcriptPath: string,
): Promise<SupplementalAttachment | null> {
  const main = page.mainFrame();
  for (const frame of [main, ...page.frames().filter((f) => f !== main)]) {
    const triggers = frame.locator('button, [role="button"], label');
    const n = Math.min(await triggers.count().catch(() => 0), 80);
    for (let i = 0; i < n; i++) {
      const t = triggers.nth(i);
      const text = ((await t.innerText().catch(() => "")) ?? "").trim();
      if (!text || text.length > 40) continue;
      if (!/^(attach|upload|browse|select file|choose file)$/i.test(text)) {
        continue;
      }
      // closest("div") is usually the Attach/Dropbox/Drive button ROW
      // (live Appian receipt 2026-08-29: its text never says "transcript").
      // Walk ancestors until one carries real question text.
      const sectionText = await t
        .evaluate(
          (el: {
            parentElement: { textContent?: string | null; parentElement: unknown } | null;
          }) => {
            let node = el.parentElement as {
              textContent?: string | null;
              parentElement: unknown;
            } | null;
            for (let depth = 0; depth < 6 && node; depth++) {
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              if (/transcript|resume|\bcv\b|cover\s*letter/i.test(text)) {
                return text.slice(0, 300);
              }
              node = node.parentElement as typeof node;
            }
            return "";
          },
        )
        .catch(() => "");
      if (!/transcript/i.test(sectionText)) continue;
      if (/resume|\bcv\b|cover[\s_-]*letter/i.test(sectionText)) continue;
      if (!(await t.isVisible().catch(() => false))) continue;
      assertFormFillAllowed("supplemental.transcript");
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5_000 }),
          t.click({ timeout: 5_000 }),
        ]);
        await chooser.setFiles(transcriptPath);
      } catch {
        continue;
      }
      // Read-back: the section (or page) should acknowledge the filename.
      await page.waitForTimeout(600);
      const filename = path.basename(transcriptPath);
      const stem = filename.replace(/\.[^.]+$/, "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const verified =
        bodyText.includes(filename) ||
        (stem.length >= 8 && bodyText.includes(stem.slice(0, 20)));
      return {
        kind: "transcript",
        label: "transcript (filechooser fallback)",
        verified,
      };
    }
  }
  return null;
}
