import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  buildCaptchaIncident,
  classifyCaptchaProvider,
  pageStillBlockedByCaptcha,
  pauseForHumanCaptcha,
} from "../../src/ats/shared/captchaPause.js";

/**
 * C2: pause-in-place for attended CAPTCHA hits. The stance is unchanged —
 * humans solve challenges, never services — this only removes the
 * park + requeue round-trip when the human is already at the window.
 * FIXTURE_CONFIRMED for the pause loop, UNIT_CONFIRMED for the classing.
 */

const BLOCKED_HTML = `
  <html><head><title>Just a moment...</title></head><body>
    <p>Please verify you are human to continue.</p>
    <iframe src="https://challenges.cloudflare.com/turnstile/v0/x"></iframe>
    <div class="cf-turnstile" data-sitekey="k"></div>
  </body></html>`;

const FORM_HTML = `
  <html><body><form>
    <label for="n">Name</label><input id="n" />
    <label for="e">Email</label><input id="e" type="email" />
  </form></body></html>`;

describe("classifyCaptchaProvider (UNIT_CONFIRMED)", () => {
  it("classes from detector signal names only", () => {
    expect(classifyCaptchaProvider(["recaptcha_widget_container"])).toBe("recaptcha");
    expect(classifyCaptchaProvider(["hcaptcha_widget_container"])).toBe("hcaptcha");
    expect(classifyCaptchaProvider(["turnstile_widget_container"])).toBe("turnstile");
    expect(
      classifyCaptchaProvider(["interstitial_challenge_page", "turnstile_widget_container"]),
    ).toBe("interstitial");
    expect(classifyCaptchaProvider(["human_verification_prompt"])).toBe("unknown");
  });

  it("incident carries host + provider only — cleared is null when never paused", () => {
    const incident = buildCaptchaIncident({
      surface: "ats_live_fill:greenhouse",
      url: "https://job-boards.greenhouse.io/acme/jobs/1?token=secret",
      signals: ["recaptcha_widget_container"],
      pause: { paused: false, cleared: false, waited_ms: 0, polls: 0, notes: [] },
    });
    expect(incident.host).toBe("job-boards.greenhouse.io");
    expect(incident.provider).toBe("recaptcha");
    expect(incident.paused).toBe(false);
    expect(incident.cleared).toBeNull();
    expect(JSON.stringify(incident)).not.toContain("token=secret");
  });
});

describe("pauseForHumanCaptcha (FIXTURE_CONFIRMED)", () => {
  it("unattended never pauses — the park path is byte-for-byte unchanged", async () => {
    await withFixtureHtmlPage(BLOCKED_HTML, async (page) => {
      const out = await pauseForHumanCaptcha(page, {
        attended: false,
        isCleared: async () => {
          throw new Error("must not poll unattended");
        },
      });
      expect(out).toMatchObject({ paused: false, cleared: false, polls: 0 });
      expect(out.notes[0]).toContain("unattended");
    });
  }, 30_000);

  it("attended: continues the moment the operator clears the challenge", async () => {
    await withFixtureHtmlPage(BLOCKED_HTML, async (page) => {
      let checks = 0;
      const announced: string[] = [];
      const out = await pauseForHumanCaptcha(page, {
        attended: true,
        intervalMs: 60,
        timeoutMs: 3_000,
        isCleared: async () => {
          checks += 1;
          return checks >= 2;
        },
        announce: (m) => announced.push(m),
      });
      expect(out.paused).toBe(true);
      expect(out.cleared).toBe(true);
      expect(out.polls).toBe(2);
      expect(announced[0]).toContain("CAPTCHA needs you");
      expect(out.notes[0]).toContain("continuing");
    });
  }, 30_000);

  it("attended timeout: bounded polls, then falls back to the park", async () => {
    await withFixtureHtmlPage(BLOCKED_HTML, async (page) => {
      const out = await pauseForHumanCaptcha(page, {
        attended: true,
        intervalMs: 60,
        timeoutMs: 300,
        isCleared: async () => false,
        announce: () => undefined,
      });
      expect(out.paused).toBe(true);
      expect(out.cleared).toBe(false);
      expect(out.polls).toBeLessThanOrEqual(Math.ceil(300 / 60));
      expect(out.notes[0]).toContain("parking for review");
    });
  }, 30_000);

  it("pageStillBlockedByCaptcha reads the live page: blocked page yes, plain form no", async () => {
    await withFixtureHtmlPage(BLOCKED_HTML, async (page) => {
      expect(await pageStillBlockedByCaptcha(page)).toBe(true);
    });
    await withFixtureHtmlPage(FORM_HTML, async (page) => {
      expect(await pageStillBlockedByCaptcha(page)).toBe(false);
    });
  }, 30_000);
});
