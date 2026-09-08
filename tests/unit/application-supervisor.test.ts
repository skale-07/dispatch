import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { superviseApplicationNavigation, navigationControlAllowed } from "../../src/navigation/applicationSupervisor.js";
import { useIsolatedFillEnv, applyControlledFillEnv } from "../helpers/fillEnvIsolation.js";

describe("application navigation supervisor (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  function enable() { applyControlledFillEnv({ NAVIGATION_ENABLED: "true", NAV_LLM_ASSIST_ENABLED: "true", AGENT_FALLBACK_ENABLED: "true", DRY_RUN: "false" }); }

  it("hands a failed fast path to the model with history and verifies the form", async () => {
    enable();
    await withFixtureHtmlPage(`<h1>Acme internship</h1><button type="button">Apply</button>
      <button type="button" onclick="document.body.innerHTML='<label>Email<input type=email name=email></label>'">Begin application</button>`, async page => {
      let calls = 0;
      const result = await superviseApplicationNavigation({ page, job: { company: "Acme", role: "Intern", url: "https://acme.test/job/1" }, maxSteps: 4, client: {
        generateJson: async input => {
          calls++;
          const context = JSON.parse(input.user);
          expect(input.effort).toBe("high");
          expect(input.image?.base64.length).toBeGreaterThan(10);
          expect(context.history[0].action).toBe("click");
          const target = context.observation.controls.find((c: { text: string }) => c.text === "Begin application");
          return { text: JSON.stringify({ action: "click", target: target.id, reason: "Apply did not change the page; use the other application entry" }), model: "fixture-planner" };
        },
      } });
      expect(calls).toBe(1);
      expect(result.report.outcome).toBe("form_ready");
      expect(await page.locator('input[type=email]').count()).toBe(1);
    });
  }, 30000);

  it("surfaces an Apply CTA buried past 80 DOM-order candidates (#187, live Merck)", async () => {
    enable();
    const nav = Array.from({ length: 95 }, (_, i) => `<a href="/cat/${i}">Category ${i}</a>`).join("");
    await withFixtureHtmlPage(`<nav>${nav}</nav><h1>Systems Biology Intern</h1>
      <button type="button" class="btn" onclick="document.body.innerHTML='<label>Email<input type=email name=email></label>'">Apply Now</button>`, async page => {
      const result = await superviseApplicationNavigation({ page, job: { company: "Merck", role: "Intern", url: page.url() }, maxSteps: 2, client: { generateJson: async () => { throw new Error("one visible Apply must take the fast path"); } } });
      expect(result.report.outcome).toBe("form_ready");
      expect(result.report.steps[0]?.reason).toMatch(/one unambiguous Apply control/);
    });
  }, 30000);

  it("refuses a model's invented control and false form-ready claim", async () => {
    enable();
    await withFixtureHtmlPage('<h1>Choose an application route</h1>', async page => {
      let calls = 0;
      const result = await superviseApplicationNavigation({ page, job: { url: "https://acme.test/job/1" }, maxSteps: 2, client: {
        generateJson: async () => ({ text: JSON.stringify(++calls === 1 ? { action: "click", target: "invented", reason: "try" } : { action: "form_ready", reason: "done" }), model: "fixture-planner" }),
      } });
      expect(result.report.outcome).toBe("budget");
      expect(result.report.steps[0]?.result).toMatch(/disallowed/);
      expect(result.report.steps[1]?.result).toMatch(/not independently observed/);
      expect(result.report.evidence.length).toBeGreaterThan(0);
    });
  }, 30000);

  it("does not call a model or click when disarmed", async () => {
    await withFixtureHtmlPage('<button type="button">Apply</button>', async page => {
      const result = await superviseApplicationNavigation({ page, job: { url: "https://acme.test/job/1" }, client: { generateJson: async () => { throw new Error("must not call"); } } });
      expect(result.report.outcome).toBe("disabled");
      expect(result.report.steps).toEqual([]);
    });
  }, 30000);

  it("returns the actual popup form for the caller to fill and submit", async () => {
    enable();
    await withFixtureHtmlPage("", async page => {
      await page.context().route("https://acme.test/**", route => route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/application") ? '<label>Email<input type="email" name="email"></label>' : '<a href="https://acme.test/application" target="_blank">Apply</a>' }));
      await page.goto("https://acme.test/posting");
      const result = await superviseApplicationNavigation({ page, job: { company: "Acme", role: "Intern", url: page.url() }, maxSteps: 2, client: { generateJson: async () => { throw new Error("simple apply should need no model"); } } });
      expect(result.report.outcome).toBe("form_ready");
      expect(result.page).not.toBe(page);
      expect(result.page.url()).toBe("https://acme.test/application");
      expect(result.page.isClosed()).toBe(false);
      await result.page.close();
    });
  }, 30000);
});

describe("supervisor action boundaries (UNIT_CONFIRMED)", () => {
  it("blocks submission, external schemes, and application-form navigation clicks", () => {
    expect(navigationControlAllowed({ text: "Submit application", href: null, type: "button" }, "unknown", "https://acme.test")).toBe(false);
    expect(navigationControlAllowed({ text: "Start", href: "javascript:alert(1)", type: null }, "posting", "https://acme.test")).toBe(false);
    expect(navigationControlAllowed({ text: "Apply", href: null, type: "submit" }, "form", "https://acme.test")).toBe(false);
    expect(navigationControlAllowed({ text: "Sign in", href: null, type: "submit" }, "auth", "https://acme.test")).toBe(true);
  });
});
