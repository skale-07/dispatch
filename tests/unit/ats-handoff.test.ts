import { describe, expect, it } from "vitest";
import { detectAtsHandoff } from "../../src/ats/shared/atsHandoff.js";

/**
 * Night19 #52 (2026-08-30): careers.leidos.com "APPLY NOW" landed on the
 * employer's Workday tenant; the generic adapter refused FORM_NOT_REACHED
 * instead of handing off. UNIT_CONFIRMED.
 */
describe("detectAtsHandoff", () => {
  const LEIDOS_WD =
    "https://leidos.wd5.myworkdayjobs.com/External/job/San-Diego-CA/Data-Science-Intern_R-00190740/apply?bid=0&tid=x_378d233f&source=";

  it("generic careers site → Workday tenant is a handoff to workday", () => {
    const h = detectAtsHandoff("generic", LEIDOS_WD);
    expect(h?.ats).toBe("workday");
    expect(h?.url).toMatch(/leidos\.wd5\.myworkdayjobs\.com/);
  });

  it("generic → greenhouse / ashby / lever are handoffs too", () => {
    expect(detectAtsHandoff("generic", "https://boards.greenhouse.io/acme/jobs/123")?.ats).toBe("greenhouse");
    expect(detectAtsHandoff("generic", "https://jobs.ashbyhq.com/acme/00000000-0000-0000-0000-000000000000/application")?.ats).toBe("ashby");
    expect(detectAtsHandoff("generic", "https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000/apply")?.ats).toBe("lever");
  });

  it("same vendor, a generic landing, or an unparseable URL is never a handoff", () => {
    expect(detectAtsHandoff("workday", LEIDOS_WD)).toBeNull();
    expect(detectAtsHandoff("greenhouse", "https://boards.greenhouse.io/embed/job_app?for=acme&token=1")).toBeNull();
    expect(detectAtsHandoff("generic", "https://careers.leidos.com/jobs/18184897-data-science-intern")).toBeNull();
    expect(detectAtsHandoff("generic", "not a url")).toBeNull();
  });
});
