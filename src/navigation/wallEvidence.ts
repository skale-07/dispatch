import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

/**
 * Evidence capture at navigation give-up points (M1 of the LLM decision
 * layer). Navigation used to read the landing page's HTML, decide, and
 * discard it — so neither the operator nor any later triage/adjudication
 * step could see what the run saw. This writes a scrubbed HTML snapshot
 * and a screenshot under the run's artifact directory.
 *
 * Telemetry only: every failure inside is a note, never a failed run.
 */

const MAX_HTML_CHARS = 300_000;
const SCREENSHOT_TIMEOUT_MS = 8_000;

export type WallEvidenceResult = {
  /** artifact-relative paths of whatever was captured */
  relpaths: string[];
  notes: string[];
};

export async function writeWallEvidence(input: {
  page: Page;
  runId: string;
  wall: string;
  secretValues: string[];
  artifactsDir: string;
}): Promise<WallEvidenceResult> {
  const relpaths: string[] = [];
  const notes: string[] = [];
  const outDir = path.join(input.artifactsDir, "navigation", input.runId);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return {
      relpaths,
      notes: [
        `giveup evidence dir failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
      ],
    };
  }

  try {
    let html = await input.page.content();
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS);
    // Same doctrine as persist(): the literal secret never reaches disk —
    // scrub the raw form and the JSON-escaped form.
    for (const secret of input.secretValues) {
      if (!secret) continue;
      const escaped = JSON.stringify(secret).slice(1, -1);
      for (const needle of new Set([secret, escaped])) {
        html = html.split(needle).join("[REDACTED_SECRET]");
      }
    }
    const htmlPath = path.join(outDir, `giveup-${input.wall}.html`);
    fs.writeFileSync(htmlPath, html, "utf8");
    relpaths.push(path.relative(input.artifactsDir, htmlPath));
  } catch (err) {
    notes.push(
      `giveup html capture failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    );
  }

  try {
    const pngPath = path.join(outDir, `giveup-${input.wall}.png`);
    await input.page.screenshot({ path: pngPath, timeout: SCREENSHOT_TIMEOUT_MS });
    relpaths.push(path.relative(input.artifactsDir, pngPath));
  } catch (err) {
    notes.push(
      `giveup screenshot failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    );
  }

  return { relpaths, notes };
}
