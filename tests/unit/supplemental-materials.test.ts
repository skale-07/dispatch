import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { attachSupplementalMaterials } from "../../src/ats/shared/supplementalMaterials.js";
import {
  applyFixtureFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Supplemental-material attach (Appian 52578119, 2026-08-29): a required
 * transcript upload bounced the click while transcript.pdf sat on disk.
 * FIXTURE_CONFIRMED.
 */
describe("supplemental materials attach (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");
  beforeEach(() => applyFixtureFillEnv());

  const tmpTranscript = path.join(os.tmpdir(), `jaa-tr-${randomUUID()}.pdf`);
  fs.writeFileSync(tmpTranscript, "%PDF-1.1\n%%EOF\n");
  afterAll(() => {
    if (fs.existsSync(tmpTranscript)) fs.unlinkSync(tmpTranscript);
  });

  const APPIAN_SHAPE = `
    <form>
      <div>
        <label for="tr">Please upload a copy of an unofficial undergraduate transcript</label>
        <input type="file" id="tr" required />
      </div>
      <div>
        <label for="resume">Resume/CV</label>
        <input type="file" id="resume" required />
      </div>
      <div>
        <label for="cl">Cover Letter</label>
        <input type="file" id="cl" />
      </div>
    </form>`;

  it("attaches the transcript to the transcript-labeled input only", async () => {
    await withFixtureHtmlPage(APPIAN_SHAPE, async (page) => {
      const r = await attachSupplementalMaterials(page, {
        transcriptPath: tmpTranscript,
      });
      expect(r.attached).toHaveLength(1);
      expect(r.attached[0]!.kind).toBe("transcript");
      expect(r.attached[0]!.verified).toBe(true);
      const count = async (id: string) =>
        page
          .locator(`#${id}`)
          .evaluate(
            (el: { files?: ArrayLike<unknown> | null }) =>
              el.files ? el.files.length : 0,
          );
      expect(await count("tr")).toBe(1);
      expect(await count("resume")).toBe(0);
      expect(await count("cl")).toBe(0);
    });
  }, 45_000);

  it("click-created transcript dropzone attaches via the filechooser fallback", async () => {
    // Appian 2026-08-29: Attach/Dropbox/Drive buttons, no input[type=file]
    // until Attach is clicked — the section-scoped trigger must be picked
    // (never the resume section's Attach) and the chip verifies.
    const html = `
      <form>
        <div>
          <h4>Resume/CV</h4>
          <button id="res-attach" type="button">Attach</button>
        </div>
        <div>
          <p>Please upload a copy of an unofficial undergraduate transcript</p>
          <div class="button-row"><!-- live Appian: triggers sit in their own row div -->
            <button id="tr-attach" type="button">Attach</button>
            <button type="button">Dropbox</button>
            <button type="button">Google Drive</button>
          </div>
          <span id="tr-chip"></span>
        </div>
      </form>
      <script>
        document.getElementById("tr-attach").addEventListener("click", () => {
          const i = document.createElement("input");
          i.type = "file"; i.style.display = "none";
          i.addEventListener("change", () => {
            document.getElementById("tr-chip").textContent = i.files[0].name;
            i.remove();
          });
          document.body.appendChild(i); i.click();
        });
      </script>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await attachSupplementalMaterials(page, {
        transcriptPath: tmpTranscript,
      });
      expect(r.attached).toHaveLength(1);
      expect(r.attached[0]!.verified).toBe(true);
      expect(await page.locator("#tr-chip").innerText()).toContain(".pdf");
    });
  }, 45_000);

  // Live mastercard Workday 2026-08-31 (#113c): the dropzone link reads
  // "Select files" (plural) and the input's nearest div says only "Drop
  // files here" — the transcript legend sits levels above.
  it("Workday dropzone: 'Select files' trigger + distant legend attach (#113c)", async () => {
    const html = `
      <form>
        <div>
          <p>Please upload your college/university transcript.<span>*</span></p>
          <div class="zone-wrap">
            <div class="dropzone">
              <div>Drop files here</div>
              <div>or <button id="tr-select" type="button">Select files</button></div>
            </div>
          </div>
          <span id="tr-chip"></span>
        </div>
      </form>
      <script>
        document.getElementById("tr-select").addEventListener("click", () => {
          const i = document.createElement("input");
          i.type = "file"; i.style.display = "none";
          i.addEventListener("change", () => {
            document.getElementById("tr-chip").textContent = i.files[0].name;
            i.remove();
          });
          document.body.appendChild(i); i.click();
        });
      </script>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await attachSupplementalMaterials(page, {
        transcriptPath: tmpTranscript,
      });
      expect(r.attached).toHaveLength(1);
      expect(r.attached[0]!.verified).toBe(true);
      expect(await page.locator("#tr-chip").innerText()).toContain(".pdf");
    });
  }, 45_000);

  it("no transcript on disk ⇒ nothing touched, note says so", async () => {
    await withFixtureHtmlPage(APPIAN_SHAPE, async (page) => {
      const r = await attachSupplementalMaterials(page, {
        transcriptPath: path.join(os.tmpdir(), "does-not-exist.pdf"),
      });
      expect(r.attached).toEqual([]);
      expect(r.notes.join(" ")).toMatch(/no transcript on file/);
    });
  }, 45_000);

  it("an already-filled transcript input is left alone", async () => {
    await withFixtureHtmlPage(APPIAN_SHAPE, async (page) => {
      await page.setInputFiles("#tr", {
        name: "mine.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.1"),
      });
      const r = await attachSupplementalMaterials(page, {
        transcriptPath: tmpTranscript,
      });
      expect(r.attached).toEqual([]);
    });
  }, 45_000);
});
