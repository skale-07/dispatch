import fs from "node:fs";
import path from "node:path";

/**
 * The test suite in two projects (vitest.config.ts):
 *
 *   fast   pure tests — no browser, no spawned process, no CDP port.
 *          A minute or two; runs on every commit.
 *   heavy  everything that drives a real Chromium (Playwright fixture
 *          pages), attaches to the debug port, spawns a child process, or
 *          runs the automation worker / pipeline / auto-cycle end to end.
 *          ~10 min, and it must run SOLO on this box — never alongside a
 *          live headed run: the overlap fakes 8–13 timeouts, and the CDP
 *          probes touch the loop's own Chrome.
 *
 * Membership is DERIVED from what a test file imports or references,
 * never maintained by hand; tests/unit/test-split.test.ts pins the
 * derivation. Over-classifying is harmless (a heavy file still runs when
 * the heavy project runs); under-classifying is the bug this fixes (two
 * "fast" files took 237 s and 284 s on 2026-09-12).
 *
 * The gate (scripts/test-gate.ts) runs `fast` always and `heavy` only
 * when a change can reach the engine — see `needsHeavySuite`.
 */

export const HEAVY_MARKERS: readonly RegExp[] = [
  // a real browser
  /from "playwright"/,
  /src\/browser\/fixtureSession/,
  /src\/auth\/serviceSession/,
  /src\/auth\/loginFlow/,
  /chromium\./,
  // the debug port / CDP
  /connectOverCDP|127\.0\.0\.1:9222|localhost:9222|restartCdpChrome|probeCdp|cdpProbe/,
  // spawned processes
  /from "node:child_process"|from "child_process"|spawnSync|execFileSync|\bspawn\(/,
  // end-to-end engine loops
  /src\/console\/autoCycle|runAutoCycle|auto:cycle/,
  /src\/automation\/|runAutomationWorker|automationWorker/,
  /runAtsLiveFill|atsLiveFill/,
  /src\/pipeline\/|runPipeline|pipelineRun/,
  // modules whose import alone drags the browser graph in (a cold
  // `await import` of portalAuth took 16 s), and the fill dispatcher,
  // which executes fixture fills through a page
  /src\/verification\/portalAuth/,
  /src\/applications\/applicationFiller/,
  // a test that labels itself FIXTURE_CONFIRMED claims to drive a fixture
  // page; believe it (over-classifying is harmless, the reverse is not)
  /FIXTURE_CONFIRMED/,
];

const TESTS_DIR = path.join("tests", "unit");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const posix = (p: string): string => p.split(path.sep).join("/");

/** Repo-relative posix paths of every test file, sorted. */
export function allTestFiles(root = process.cwd()): string[] {
  return walk(path.join(root, TESTS_DIR))
    .map((f) => posix(path.relative(root, f)))
    .sort();
}

export function isHeavySource(source: string): boolean {
  return HEAVY_MARKERS.some((re) => re.test(source));
}

/** Repo-relative posix paths of the heavy test files, sorted. */
export function heavyTestFiles(root = process.cwd()): string[] {
  return allTestFiles(root).filter((rel) => isHeavySource(fs.readFileSync(path.join(root, rel), "utf8")));
}

/**
 * Paths a change can touch WITHOUT reaching the engine. Anything else —
 * src/ (except the cloud plane), tests/helpers, fixtures, the tool config
 * — brings the heavy project into the gate.
 */
export const HEAVY_SAFE_PREFIXES: readonly string[] = [
  "frontend/",
  "docs/",
  "supabase/",
  "design/",
  "site/",
  "deploy/",
  "artifacts/",
  "private/",
  ".claude/",
  ".cursor/",
  ".github/",
  "src/cloud/",
];

/** Config and shared code whose change must re-run everything. */
const ALWAYS_HEAVY = new Set([
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "tsconfig.json",
  "scripts/testSplit.ts",
  "scripts/test-gate.ts",
]);

export type HeavyDecision = { needed: boolean; because: string };

export function needsHeavySuite(changed: readonly string[], heavyFiles: readonly string[]): HeavyDecision {
  const heavy = new Set(heavyFiles);
  for (const raw of changed) {
    const p = posix(raw.trim());
    if (!p) continue;
    if (ALWAYS_HEAVY.has(p)) return { needed: true, because: `${p} changed (tool config)` };
    if (heavy.has(p)) return { needed: true, because: `${p} is a heavy test` };
    if (p.startsWith("tests/helpers/") || p.startsWith("tests/fixtures/")) {
      return { needed: true, because: `${p} is shared test infrastructure` };
    }
    if (p.startsWith("tests/unit/")) continue; // a fast test: the fast project covers it
    if (/^[^/]+\.md$/.test(p)) continue; // root markdown
    if (HEAVY_SAFE_PREFIXES.some((prefix) => p.startsWith(prefix))) continue;
    return { needed: true, because: `${p} can reach the engine` };
  }
  return { needed: false, because: "every changed path is outside the engine" };
}
