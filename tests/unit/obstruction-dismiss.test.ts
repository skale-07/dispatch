import { describe, expect, it } from "vitest";
import { dismissPageObstructions } from "../../src/browser/obstructions.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * Popup/interstitial dismisser: overlays NOT associated with the
 * application (cookie banners, upsell modals) are cleared; anything with
 * progression/submission semantics is refused even inside a dialog.
 * FIXTURE_CONFIRMED against synthetic DOMs.
 */
describe("obstruction dismisser (FIXTURE_CONFIRMED)", () => {
  it(
    "dismisses a cookie banner and an upsell modal, leaving the page's Apply button intact",
    async () => {
      const html = `<html><body>
        <div id="cookie-banner" style="position:fixed;bottom:0">
          We use cookies.
          <button onclick="document.getElementById('cookie-banner').remove()">Accept all</button>
        </div>
        <div role="dialog" id="upsell" aria-modal="true">
          Upgrade to premium for more matches!
          <button aria-label="Close" onclick="document.getElementById('upsell').remove()">✕</button>
          <button>Upgrade now</button>
        </div>
        <button id="apply">Apply</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed.length).toBe(2);
        expect(await page.locator("#cookie-banner").count()).toBe(0);
        expect(await page.locator("#upsell").count()).toBe(0);
        // The page's own Apply control is untouched and still there.
        expect(await page.locator("#apply").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "never clicks progression/submission controls, even inside a dialog",
    async () => {
      // A modal that ONLY offers submit/continue-style actions must be
      // left alone — it might be part of the application itself.
      const html = `<html><body>
        <div role="dialog" id="appmodal" aria-modal="true">
          Ready to send your application?
          <button>Submit application</button>
          <button>Continue</button>
          <button>Sign in</button>
        </div>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed).toEqual([]);
        expect(await page.locator("#appmodal").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "caps dismissals — a popup farm cannot stall the flow",
    async () => {
      const modals = Array.from(
        { length: 6 },
        (_, i) =>
          `<div role="dialog" id="m${i}">Promo ${i}<button onclick="document.getElementById('m${i}').remove()">Got it</button></div>`,
      ).join("\n");
      await withFixtureHtmlPage(`<html><body>${modals}</body></html>`, async (page) => {
        const r = await dismissPageObstructions(page, { settleMs: 50 });
        expect(r.dismissed.length).toBe(3); // default cap
      });
    },
    45_000,
  );

  it(
    "dismisses Workday's legalNotice cookie banner (live tiaa.wd1 2026-08-31 — it sat over every auth click)",
    async () => {
      // Workday's banner carries only data-automation-id markers — no
      // cookie/consent class or role — so the container scan missed it
      // while it intercepted the Sign In / Create Account clicks below.
      const html = `<html><body>
        <div data-automation-id="legalNotice" style="position:fixed;top:0;left:0;right:0;background:#fff">
          This website uses cookies to improve your browsing experience.
          <button data-automation-id="legalNoticeDeclineButton" onclick="this.parentElement.remove()">Decline</button>
          <button data-automation-id="legalNoticeAcceptButton" onclick="this.parentElement.remove()">Accept Cookies</button>
        </div>
        <button data-automation-id="adventureButton">Apply</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed.length).toBe(1);
        expect(await page.locator("[data-automation-id='legalNotice']").count()).toBe(0);
        expect(await page.locator("[data-automation-id='adventureButton']").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "an APPLICATION-FLOW dialog (Start Your Application chooser) is never dismissed — not even via its close-X (#75, live tiaa)",
    async () => {
      const html = `<html><body>
        <div role="dialog" id="chooser" aria-modal="true">
          <button aria-label="Close">✕</button>
          <h2>Start Your Application</h2>
          <button>Autofill with Resume</button>
          <button>Apply Manually</button>
          <button>Use My Last Application</button>
        </div>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed).toEqual([]);
        expect(await page.locator("#chooser").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "a clean page returns fast with nothing dismissed",
    async () => {
      await withFixtureHtmlPage(
        `<html><body><form><input name="email"><button type="submit">Apply</button></form></body></html>`,
        async (page) => {
          const r = await dismissPageObstructions(page);
          expect(r.dismissed).toEqual([]);
          expect(r.notes).toEqual([]);
        },
      );
    },
    45_000,
  );
});
