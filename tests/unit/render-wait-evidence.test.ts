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
    expect(result.html.length).toBeGreaterThan(0);
  }, 30_000);

  it("stops immediately on a page that already classifies as a form", async () => {
    const result = await withFixtureHtmlPage(IMMEDIATE_FORM, async (page) =>
      waitForRenderedContentDetailed(page, FORM_MARKERS, 8_000, 200),
    );
    expect(result.settledAs).toBe("classified");
    expect(result.polls).toBe(1);
  }, 30_000);

  // #161, live careers.philips.com 2026-09-03 — found by #160's own note:
  // "marker after 2 poll(s) / 1256ms, final html 1679240 chars". The SPA
  // shell carried an <input> long before the posting painted, the wait
  // returned on it, and the half-rendered page classified `unknown`.
  //
  // The shell input is the site's SEARCH box, which #157 drops at
  // discovery — so the page has zero fillable fields and no Apply CTA
  // yet, i.e. `unknown`, while the raw html still satisfies the <input>
  // form marker. That combination is exactly what made the old wait
  // return too early.
  it("keeps polling when the marker matched but the page is still unknown", async () => {
    const SHELL_THEN_POSTING = `
      <html><body>
        <div id="shell"><input id="keyword-search" name="keyword-search" type="text"></div>
        <div id="root"></div>
        <script>
          setTimeout(function () {
            document.getElementById('root').innerHTML =
              '<h1>Graduate Level Co-op</h1>' +
              '<a href="/apply/1">Apply for this job online</a>';
          }, 900);
        </script>
      </body></html>`;

    const result = await withFixtureHtmlPage(SHELL_THEN_POSTING, async (page) =>
      waitForRenderedContentDetailed(page, FORM_MARKERS, 8_000, 200),
    );

    // The old behavior returned "marker" on poll 1 with an unknown page.
    expect(result.settledAs).toBe("classified");
    expect(result.polls).toBeGreaterThan(1);
    expect(result.html).toContain("Apply for this job online");
  }, 30_000);
});
