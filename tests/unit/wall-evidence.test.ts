import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { writeWallEvidence } from "../../src/navigation/wallEvidence.js";

/**
 * M1 of the LLM decision layer: navigation give-up points must leave
 * scrubbed evidence on disk. The capture is telemetry — it never throws,
 * and a planted credential never reaches the artifact. FIXTURE_CONFIRMED.
 */
describe("navigation give-up evidence (FIXTURE_CONFIRMED)", () => {
  it("writes scrubbed HTML + screenshot and returns their relpaths", async () => {
    const artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-wallev-"));
    const secret = "hunter2-super-secret-pw";
    const html = `<html><body>
      <h1>Sign in to continue</h1>
      <p>debug leak: ${secret}</p>
    </body></html>`;
    try {
      await withFixtureHtmlPage(html, async (page) => {
        const result = await writeWallEvidence({
          page,
          runId: "nav-test-run",
          wall: "auth",
          secretValues: [secret],
          artifactsDir: artDir,
        });
        expect(result.relpaths).toHaveLength(2);
        const htmlPath = path.join(artDir, result.relpaths[0]!);
        const written = fs.readFileSync(htmlPath, "utf8");
        expect(written).not.toContain(secret);
        expect(written).toContain("[REDACTED_SECRET]");
        expect(written).toContain("Sign in to continue");
        const pngPath = path.join(artDir, result.relpaths[1]!);
        expect(fs.statSync(pngPath).size).toBeGreaterThan(0);
        expect(result.notes).toEqual([]);
      });
    } finally {
      fs.rmSync(artDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a closed page yields notes, never a throw", async () => {
    const artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-wallev-"));
    try {
      let captured: Awaited<ReturnType<typeof writeWallEvidence>> | null = null;
      await withFixtureHtmlPage("<html><body>x</body></html>", async (page) => {
        await page.close();
        captured = await writeWallEvidence({
          page,
          runId: "nav-test-closed",
          wall: "budget",
          secretValues: [],
          artifactsDir: artDir,
        });
      });
      expect(captured).not.toBeNull();
      expect(captured!.relpaths).toEqual([]);
      expect(captured!.notes.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(artDir, { recursive: true, force: true });
    }
  }, 30_000);
});
