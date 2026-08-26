import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C1: the handoff brief hands a parked wall to the operator's own
 * browser agent (Claude in Chrome) — signed in as themselves, on the real
 * page. Text-level like the other frontend contracts (frontend/ is a
 * separate build): the brief's safety rules and its deliberate exclusions
 * are the product here, so they are pinned. UNIT_CONFIRMED.
 */

const SRC = path.join(process.cwd(), "frontend", "src");
const brief = fs.readFileSync(path.join(SRC, "lib", "handoffBrief.ts"), "utf8");
const panel = fs.readFileSync(
  path.join(SRC, "components", "ReviewActionPanel.tsx"),
  "utf8",
);

describe("handoff brief contract (UNIT_CONFIRMED)", () => {
  it("offered on AUTH_REQUIRED / UNSUPPORTED_ATS / MANUAL — and NEVER on CAPTCHA_REQUIRED", () => {
    const setLiteral = brief.match(/HANDOFF_KINDS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(setLiteral).toContain("AUTH_REQUIRED");
    expect(setLiteral).toContain("UNSUPPORTED_ATS");
    expect(setLiteral).toContain("MANUAL");
    // Pointing an agent at a CAPTCHA would be automating the check — the
    // line this product never crosses. The exclusion must stay deliberate.
    expect(setLiteral).not.toContain("CAPTCHA_REQUIRED");
  });

  it("the brief text carries the house rules verbatim", () => {
    expect(brief).toContain("STOP before clicking Submit");
    expect(brief).toContain("demographic / self-identification / EEO");
    expect(brief).toContain("never attempt to get past it");
    expect(brief).toContain("Never invent or guess personal information");
  });

  it("the review panel wires the copy button through the brief builder", () => {
    expect(panel).toContain("buildHandoffBrief");
    expect(panel).toContain("isHandoffBriefKind");
    expect(panel).toContain("Copy brief for a browser agent");
  });
});
