import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { greenhouseUploadFile } from "../../src/ats/greenhouse/fill.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const SAMPLE_RESUME = path.join(process.cwd(), "tests", "fixtures", "ats", "greenhouse", "sample-resume.pdf");

/**
 * #183 (live Stripe Toronto 2026-09-07): job-boards unmounts #resume on
 * change and renders the filename chip only when its upload request
 * completes. The read-back must wait for that chip, and an unmounted
 * input with no chip is a FAILED upload, never a phantom success.
 * FIXTURE_CONFIRMED.
 */
describe("greenhouse upload chip read-back (#183, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  beforeEach(() => {
    if (!fs.existsSync(SAMPLE_RESUME)) {
      fs.writeFileSync(SAMPLE_RESUME, "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    }
    applyControlledFillEnv({ FORM_FILL_ENABLED: "true", DRY_RUN: "false" });
  });

  const widget = (chipDelayMs: number | null) => `<!DOCTYPE html><html><body>
    <form id="application-form">
      <label>First Name<input id="first_name" /></label>
      <section class="attach"><label class="visually-hidden" for="resume">Resume/CV Attach</label>
        <input id="resume" class="visually-hidden" type="file" accept=".pdf" />
        <button type="button" id="attach">Attach</button><span id="chip"></span></section>
    </form>
    <script>
      const input = document.getElementById("resume");
      input.addEventListener("change", (e) => {
        const name = e.target.files[0].name;
        e.target.remove();
        ${chipDelayMs === null ? "" : `setTimeout(() => { document.getElementById("chip").textContent = name; }, ${chipDelayMs});`}
      });
    </script></body></html>`;

  it(
    "waits for a chip that lands well after the input unmounts and reports chip=true",
    async () => {
      await withFixtureHtmlPage(widget(1500), async (page) => {
        const upload = await greenhouseUploadFile(page, "resume", SAMPLE_RESUME);
        expect(upload.verified).toBe(true);
        expect(upload.evidence).toMatch(/chip=true/);
      });
    },
    30_000,
  );

  it(
    "an unmounted input with no acknowledgment is NOT verified and names the widget",
    async () => {
      await withFixtureHtmlPage(widget(null), async (page) => {
        const upload = await greenhouseUploadFile(page, "resume", SAMPLE_RESUME);
        expect(upload.verified).toBe(false);
        expect(upload.evidence).toMatch(/stillAttached=false; chip=false/);
        expect(upload.evidence).toMatch(/no filename acknowledgment/);
        expect(upload.evidence).toMatch(/widget text/);
      });
    },
    40_000,
  );
});
