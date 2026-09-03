import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { waitForRenderedContentDetailed } from "../../src/ats/shared/preMutationGate.js";

/**
 * #160 (2026-09-03 cycles): seven apps parked UNKNOWN_LANDING across five
 * hosts and the artifact recorded none of what the gate saw, so a slow SPA
 * could not be told apart from an iframe-served posting (#159) without a
 * live re-probe.
 *
 * Two properties are pinned here: the wait now also stops once the page
 * CLASSIFIES (a posting satisfies no form marker and used to burn the whole
 * timeout), and it reports how it ended. FIXTURE_CONFIRMED.
 */
const FORM_MARKERS = /<form|<input/i;

/** Renders an Apply-only posting after a delay — no form marker, ever. */
const LATE_POSTING = `
<html><body>
  <div id="root">loading…</div>
  <script>
    setTimeout(function () {
      document.getElementById('root').innerHTML =
        '<h1>Software Engineer Intern</h1>' +
        '<a href="/apply/1">Apply for this job online</a>';
    }, 700);
  </script>
</body></html>`;

/** Never resolves into anything classifiable. */
const NEVER_RESOLVES = `
<html><body><div id="root">loading…</div></body></html>`;

const IMMEDIATE_FORM = `
<html><body><form>
  <label for="e">Email</label><input id="e" name="email" type="email">
</form></body></html>`;

describe("#160 render wait reports how it ended", () => {
  it("stops on CLASSIFIED for a posting that never grows a form marker", async () => {
    const result = await withFixtureHtmlPage(LATE_POSTING, async (page) =>
      waitForRenderedContentDetailed(page, FORM_MARKERS, 8_000, 200),
    );
    expect(result.settledAs).toBe("classified");
    // The whole point: it returned early instead of burning the timeout.
    expect(result.waitedMs).toBeLessThan(6_000);
    expect(result.html).toContain("Apply for this job online");
  }, 30_000);

  it("reports timeout, with poll count and size, when nothing resolves", async () => {
    const result = await withFixtureHtmlPage(NEVER_RESOLVES, async (page) =>
      waitForRenderedContentDetailed(page, FORM_MARKERS, 1_500, 300),
    );
    expect(result.settledAs).toBe("timeout");
    expect(result.polls).toBeGreaterThan(1);
    expect(result.htmlChars ?? result.html.length).toBeGreaterThan(0);
  }, 30_000);

  it("stops immediately on the form marker without polling", async () => {
    const result = await withFixtureHtmlPage(IMMEDIATE_FORM, async (page) =>
      waitForRenderedContentDetailed(page, FORM_MARKERS, 8_000, 200),
    );
    expect(result.settledAs).toBe("marker");
    expect(result.polls).toBe(1);
  }, 30_000);
});
