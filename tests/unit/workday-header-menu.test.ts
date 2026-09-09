import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { closeWorkdayHeaderMenus } from "../../src/ats/workday/fill.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * #198 (live morningstar.wd5 2026-09-08): an open header account submenu
 * sat over the My Information page; every field click timed out
 * ("<ul role=menu aria-labelledby=account-submenu-button> … intercepts
 * pointer events") and verify read 12 empty fields. FIXTURE_CONFIRMED —
 * the menu shape is the live call log's.
 */
describe("workday header menu overlay (#198, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const HTML = `<!DOCTYPE html><html><body>
    <div data-automation-id="header" style="position:fixed;top:0;left:0;right:0;height:60px;z-index:10">
      <button id="acct" aria-expanded="true" aria-controls="menu">Account</button>
      <ul id="menu" role="menu" aria-labelledby="account-submenu-button"
          style="position:absolute;top:60px;left:0;width:100%;height:400px;background:#fff;z-index:20">
        <li role="menuitem" id="signout">Sign Out</li>
      </ul>
    </div>
    <main style="padding-top:80px">
      <h2>My Information</h2>
      <input id="name--legalName--firstName" type="text" />
    </main>
    <script>
      window.__signedOut = false;
      document.getElementById('signout').addEventListener('click', () => { window.__signedOut = true; });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { document.getElementById('menu').remove(); document.getElementById('acct').setAttribute('aria-expanded','false'); }
      });
    </script></body></html>`;

  it("closes the open menu with Escape and never touches a menu item", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const r = await closeWorkdayHeaderMenus(page);
      expect(r.closed).toBe(true);
      expect(r.notes.join(" ")).toMatch(/closed via Escape/);
      expect(await page.locator("#menu").count()).toBe(0);
      expect(await page.evaluate(() => (globalThis as unknown as { __signedOut: boolean }).__signedOut)).toBe(false);
      // The field is clickable now.
      await page.locator("#name--legalName--firstName").click({ timeout: 2_000 });
    });
  }, 30_000);

  it("no open menu ⇒ no-op", async () => {
    await withFixtureHtmlPage(
      `<html><body><div data-automation-id="header"><button aria-expanded="false">Account</button></div><main><h2>My Information</h2></main></body></html>`,
      async (page) => {
        const r = await closeWorkdayHeaderMenus(page);
        expect(r.closed).toBe(false);
        expect(r.notes).toEqual([]);
      },
    );
  }, 30_000);
});
