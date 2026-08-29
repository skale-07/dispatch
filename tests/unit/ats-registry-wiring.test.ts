import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAtsFixture,
  runAtsFixtureInspection,
} from "../../src/applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../../src/applications/applicationInspector.js";
import { detectAts, listAdapters } from "../../src/ats/registry.js";
import { LeverAdapterV1 } from "../../src/ats/lever/v1.js";
import { AshbyAdapterV1 } from "../../src/ats/ashby/v1.js";
import { SubmissionUncertainError as GreenhouseSubmissionUncertainError } from "../../src/ats/greenhouse/submission.js";
import { SubmissionUncertainError as LeverSubmissionUncertainError } from "../../src/ats/lever/submission.js";
import { SubmissionUncertainError as AshbySubmissionUncertainError } from "../../src/ats/ashby/submission.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { GreenhouseAdapterV1 } from "../../src/ats/greenhouse/v1.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

describe("ATS registry wiring (W1, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("registers all seven adapters", () => {
    expect(listAdapters().map((a) => a.id)).toEqual([
      "unsupported",
      "greenhouse",
      "lever",
      "ashby",
      "workable",
      "workday",
      "generic",
    ]);
  });

  it("Paylocity SPA inputs without a form tag are generic, not unsupported", async () => {
    const { adapter, detection } = await detectAts({
      url: "https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4429441",
      html: `<html><body>
        <input name="ctl00$MainContent$txtFirst" />
        <input name="ctl00$MainContent$txtLast" />
      </body></html>`,
    });
    expect(adapter.id).toBe("generic");
    expect(detection.atsId).toBe("generic");
  });

  it("first-party greenhouse embed (company host + gh_jid) routes to greenhouse", async () => {
    // Issue #18 (2026-08-29): boards.greenhouse.io/samsara/jobs/<id> 302s to
    // samsara.com/...?gh_jid=<id>; submit-time re-detection read "generic"
    // and the ATS-mismatch check refused 7 READY_TO_SUBMIT apps.
    const { adapter, detection } = await detectAts({
      url: "https://www.samsara.com/company/careers/roles/8097345?gh_jid=8097345",
      html: `<html><body>
        <div id="grnhse_app"></div>
        <form action="#"><input name="first_name" /><input name="last_name" /></form>
      </body></html>`,
    });
    expect(adapter.id).toBe("greenhouse");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.5);
    expect(detection.evidence).toContain("greenhouse embed gh_jid param");
  });

  it("gh_jid param alone (no embed markers) still routes to greenhouse", async () => {
    const { adapter } = await detectAts({
      url: "https://careers.example.com/detail/123?gh_jid=123",
      html: `<html><body><form><input name="first_name" /></form></body></html>`,
    });
    expect(adapter.id).toBe("greenhouse");
  });

  it("company careers page without gh_jid or embed markers stays generic", async () => {
    const { adapter } = await detectAts({
      url: "https://www.samsara.com/company/careers/roles/8097345",
      html: `<html><body><form><input name="first_name" /><input name="last_name" /></form></body></html>`,
    });
    expect(adapter.id).toBe("generic");
  });

  it("embed markers without gh_jid do not reach the greenhouse threshold alone", async () => {
    // 0.3 embed evidence < 0.5 — a page merely referencing the embed script
    // is not claimed without the vendor URL or param (conservative side).
    const { adapter } = await detectAts({
      url: "https://www.example.com/careers",
      html: `<html><body><div id="grnhse_app"></div></body></html>`,
    });
    expect(adapter.id).toBe("generic");
  });

  it("routes the lever fixture to the lever adapter", async () => {
    const { adapter, detection } = await detectAts(loadAtsFixture("lever"));
    expect(adapter.id).toBe("lever");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("routes the ashby fixture to the ashby adapter", async () => {
    const { adapter, detection } = await detectAts(loadAtsFixture("ashby"));
    expect(adapter.id).toBe("ashby");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("greenhouse routing unchanged; workday now routes to its adapter", async () => {
    const g = await detectAts(loadAtsFixture("greenhouse"));
    expect(g.adapter.id).toBe("greenhouse");
    const w = await detectAts(loadAtsFixture("workday"));
    expect(w.adapter.id).toBe("workday");
    expect(w.detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("inspector treats lever and ashby as supported (essay route, not unsupported)", async () => {
    // Both fixtures carry an essay textarea; with the essay gate on,
    // needs_essay wins — the point is they no longer fall to
    // skip_unsupported_ats/inspect_only.
    applyControlledFillEnv({ ESSAY_REQUIRED_GATE_ENABLED: "true" });
    for (const name of ["lever", "ashby"] as const) {
      const report = await inspectApplicationHtml(loadAtsFixture(name));
      expect(report.inspection.ats).toBe(name);
      expect(report.route).toBe("needs_essay");
    }
  });

  it("essay-free lever/ashby forms stay on supported routes, never unsupported", async () => {
    // With the textareas stripped, the unmapped custom questions route to
    // human review — the invariant under test is that lever/ashby never
    // fall to the unsupported/inspect-only buckets anymore.
    for (const name of ["lever", "ashby"] as const) {
      const fixture = loadAtsFixture(name);
      const html = fixture.html.replace(/<textarea[\s\S]*?<\/textarea>/gi, "");
      const report = await inspectApplicationHtml({ ...fixture, html });
      expect(report.inspection.ats).toBe(name);
      expect(["ready_for_fill_later", "needs_review_unmapped"]).toContain(
        report.route,
      );
      expect(report.route).not.toBe("skip_unsupported_ats");
      expect(report.route).not.toBe("inspect_only");
    }
  });

  it("fixture inspection runs cleanly for the new names", async () => {
    for (const name of ["lever", "ashby"] as const) {
      const { report } = await runAtsFixtureInspection(name);
      expect(report.inspection.ats).toBe(name);
      expect(report.form_fill_enabled).toBe(false);
    }
  });

  it("setApprovedFillPlan without a profile fails closed on lever/ashby, not greenhouse", () => {
    const plan = toApprovedFillPlan([]);
    expect(() => new LeverAdapterV1().setApprovedFillPlan(plan)).toThrow(
      /requires the public profile/,
    );
    expect(() => new AshbyAdapterV1().setApprovedFillPlan(plan)).toThrow(
      /requires the public profile/,
    );
    expect(() =>
      new GreenhouseAdapterV1().setApprovedFillPlan(plan),
    ).not.toThrow();
  });

  it("SubmissionUncertainError is one class across all three ATSes", () => {
    expect(LeverSubmissionUncertainError).toBe(
      GreenhouseSubmissionUncertainError,
    );
    expect(AshbySubmissionUncertainError).toBe(
      GreenhouseSubmissionUncertainError,
    );
    const thrown = new LeverSubmissionUncertainError("x", { a: 1 });
    expect(thrown instanceof GreenhouseSubmissionUncertainError).toBe(true);
  });
});
