import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { readJobDetailSnapshot } from "../../src/jobright/jobDetails.js";

/**
 * #186 (live 2026-09-08): JobRight's detail page dropped its <main>
 * element; the description reader returned "" and fresh discovery skipped
 * every card as "requirements unavailable". The reader now walks the
 * registry's content regions and takes the first with text. FIXTURE_CONFIRMED.
 */
describe("job detail description regions (#186, FIXTURE_CONFIRMED)", () => {
  it("reads the description from the jobDetailContent region when <main> is absent", async () => {
    await withFixtureHtmlPage(
      `<div class="index_job-title__x1">Software Engineering Internship</div>
       <div class="index_company-name__x2">Hudson River Trading</div>
       <div class="index_jobDetailContent__rhs3U"><p>HRT is a quantitative trading firm. The intern will build tooling.</p></div>`,
      async (page) => {
        const snap = await readJobDetailSnapshot(page);
        expect(snap.description_text).toMatch(/quantitative trading firm/);
      },
    );
  }, 30_000);

  it("still reads a classic <main> page", async () => {
    await withFixtureHtmlPage(
      `<div class="index_job-title__x1">Intern</div><main><p>Requirements: Python.</p></main>`,
      async (page) => {
        const snap = await readJobDetailSnapshot(page);
        expect(snap.description_text).toMatch(/Requirements: Python/);
      },
    );
  }, 30_000);

  it("returns null, not an empty string, when no region has text", async () => {
    await withFixtureHtmlPage(`<div class="index_job-title__x1">Intern</div>`, async (page) => {
      const snap = await readJobDetailSnapshot(page);
      expect(snap.description_text).toBeNull();
    });
  }, 30_000);
});
