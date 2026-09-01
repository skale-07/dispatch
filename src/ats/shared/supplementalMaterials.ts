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
            // The nearest div can be a bare dropzone ("Drop files here")
            // — walk up until an ancestor carries real question text
            // (live mastercard 2026-08-31: the transcript legend sits 3
            // levels above the hidden input).
            let context = "";
            let node = el.closest("section, fieldset, div") as {
              textContent?: string | null;
              parentElement: unknown;
            } | null;
            for (let depth = 0; depth < 6 && node; depth++) {
              const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              if (/transcript|resume|\bcv\b|cover\s*letter/i.test(t)) {
                context = t;
                break;
              }
              if (!context && t) context = t;
              node = node.parentElement as typeof node;
            }
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
  // Click-created dropzones (Appian 2026-08-29: "Please upload a copy of
  // an unofficial undergraduate transcript" renders Attach/Dropbox/Drive
  // buttons and NO input[type=file] until Attach is clicked). Run for
  // EVERY still-empty transcript section — not only when nothing attached:
  // live databricks 2026-09-01 (#123) carries TWO required transcript
  // slots (undergrad + "graduate studies (if applicable)"); the first
  // attached via its input, the `attached.length === 0` gate skipped the
  // second, and the submit click bounced off its "This field is required".
  const viaChooser = await attachTranscriptsViaChooser(page, transcriptPath);
  result.attached.push(...viaChooser);
  if (result.attached.length === 0) {
    result.notes.push("no empty transcript-labeled file input found");
  }
  return result;
}

async function attachTranscriptsViaChooser(
  page: Page,
  transcriptPath: string,
): Promise<SupplementalAttachment[]> {
  const out: SupplementalAttachment[] = [];
  const filename = path.basename(transcriptPath);
  const main = page.mainFrame();
  for (const frame of [main, ...page.frames().filter((f) => f !== main)]) {
    const triggers = frame.locator('button, [role="button"], label');
    const n = Math.min(await triggers.count().catch(() => 0), 80);
    for (let i = 0; i < n && out.length < 3; i++) {
      const t = triggers.nth(i);
      const text = ((await t.innerText().catch(() => "")) ?? "").trim();
      if (!text || text.length > 40) continue;
      // Plural "Select files" is Workday's dropzone link (live
      // mastercard 2026-08-31).
      if (!/^(attach|upload|browse|select files?|choose files?)$/i.test(text)) {
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
      // A section already showing the transcript filename is DONE — the
      // per-section check is what lets a multi-slot form (#123) fill its
      // remaining empty slots without re-attaching to the first.
      if (sectionText.includes(filename)) continue;
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
      const stem = filename.replace(/\.[^.]+$/, "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const verified =
        bodyText.includes(filename) ||
        (stem.length >= 8 && bodyText.includes(stem.slice(0, 20)));
      out.push({
        kind: "transcript",
        label: `transcript (filechooser): ${sectionText.slice(0, 60)}`,
        verified,
      });
    }
  }
  return out;
}
