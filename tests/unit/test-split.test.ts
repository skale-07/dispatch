import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEAVY_SAFE_PREFIXES,
  allTestFiles,
  heavyTestFiles,
  isHeavySource,
  needsHeavySuite,
} from "../../scripts/testSplit.js";

/**
 * The fast/heavy split (vitest.config.ts) is derived from what each test
 * file references, and the gate's "does this change need the heavy
 * project" rule is pure — both pinned here so neither can drift.
 * UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");

describe("test split (UNIT_CONFIRMED)", () => {
  it("heavy files are exactly those that reach a browser, the CDP port, a child process, or an engine loop", () => {
    const all = allTestFiles(ROOT);
    const heavy = heavyTestFiles(ROOT);
    expect(all.length).toBeGreaterThan(150);
    expect(heavy.length).toBeGreaterThan(50);
    expect(heavy.length).toBeLessThan(all.length);
    for (const rel of all) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(heavy.includes(rel), rel).toBe(isHeavySource(src));
    }
    // The two files that made "fast" take nine minutes on 2026-09-12, and
    // the browser families, are heavy; pure registries are not.
    for (const f of ["auto-cycle", "automation-worker", "portal-auth", "ashby-native-group", "ats-live-fill", "pipeline-run"]) {
      expect(heavy, f).toContain(`tests/unit/${f}.test.ts`);
    }
    for (const f of ["onboarding-steps", "field-suggestions", "design-tokens", "test-split"]) {
      expect(heavy, f).not.toContain(`tests/unit/${f}.test.ts`);
    }
  });

  it("the vitest config's two projects partition the suite and the scripts exist", () => {
    const cfg = fs.readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    expect(cfg).toMatch(/name: "fast"/);
    expect(cfg).toMatch(/name: "heavy"/);
    expect(cfg).toMatch(/exclude: \["\*\*\/node_modules\/\*\*", \.\.\.heavy\]/);
    expect(cfg).toMatch(/include: heavy/);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test"]).toBe("vitest run");
    expect(pkg.scripts["test:fast"]).toBe("vitest run --project fast");
    expect(pkg.scripts["test:heavy"]).toBe("vitest run --project heavy");
    expect(pkg.scripts["test:gate"]).toBe("tsx scripts/test-gate.ts");
    // The house rules name the gate command.
    const rules = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    expect(rules).toMatch(/npm run test:gate -- <the paths you are committing>/);
  });

  it("the gate runs the heavy project only when a change can reach the engine", () => {
    const heavy = ["tests/unit/portal-auth.test.ts"];
    const no = (paths: string[]): void => expect(needsHeavySuite(paths, heavy).needed, paths.join(",")).toBe(false);
    const yes = (paths: string[]): void => expect(needsHeavySuite(paths, heavy).needed, paths.join(",")).toBe(true);
    no(["frontend/src/public/LandingPage.tsx", "docs/roadmap/cloud-deploy.md", "CLAUDE.md"]);
    no(["supabase/migrations/20260912000100_realtime_publication.sql", "src/cloud/schema.ts"]);
    no(["tests/unit/onboarding-steps.test.ts"]);
    no([]);
    yes(["src/applications/fieldNormalization.ts"]);
    yes(["src/ats/greenhouse/fill.ts", "frontend/src/main.tsx"]);
    yes(["tests/unit/portal-auth.test.ts"]);
    yes(["tests/helpers/fillEnvIsolation.ts"]);
    yes(["tests/fixtures/ats/ashby/education-block.commure.html"]);
    yes(["package.json"]);
    yes(["vitest.config.ts"]);
    yes(["scripts/check-forbidden.ts"]);
    // Windows separators are normalised before matching.
    no(["frontend\\src\\public\\data.ts"]);
    expect(needsHeavySuite(["src/ats/lever/fill.ts"], heavy).because).toMatch(/can reach the engine/);
    expect(HEAVY_SAFE_PREFIXES).not.toContain("src/");
  });
});
