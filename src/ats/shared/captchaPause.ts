/**
 * C2: CAPTCHA ergonomics — pause in place instead of parking, when a
 * human is actually there to solve it.
 *
 * The stance is unchanged and non-negotiable: CAPTCHAs are solved by the
 * operator or not at all — never by a solver service; they defeat checks
 * sites run on purpose. What changes is the cost of that stance. Today a
 * blocking CAPTCHA on a HEADED run parks the application
 * (CAPTCHA_REQUIRED + review item) even though the operator is sitting in
 * front of the very browser window showing the challenge — solving it
 * later costs a full requeue round-trip. Pausing the run for a bounded
 * window (default 90s) lets the operator solve it in place and the run
 * continue; the timeout falls back to exactly today's park.
 *
 * Attended means HEADED: a headless run has no window a human could
 * solve, so it never pauses (unattended behavior is byte-for-byte
 * unchanged). Bounded in both dimensions — wall clock AND poll count —
 * per the no-unbounded-loops house rule.
 *
 * Every hit also becomes a classed incident record (provider + host +
 * signals, no candidate data) so the artifact corpus can finally answer
 * "how often do we actually hit CAPTCHAs, where, and of what kind".
 */
import type { Page } from "playwright";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";

export type CaptchaProvider =
  | "recaptcha"
  | "hcaptcha"
  | "turnstile"
  | "interstitial"
  | "unknown";

/** Classed from the detector's signal names — never from page content. */
export function classifyCaptchaProvider(signals: string[]): CaptchaProvider {
  const s = signals.join(" ");
  if (s.includes("interstitial")) return "interstitial";
  if (s.includes("recaptcha")) return "recaptcha";
  if (s.includes("hcaptcha")) return "hcaptcha";
  if (s.includes("turnstile")) return "turnstile";
  return "unknown";
}

export type CaptchaIncident = {
  at: string;
  /** Host only — never the full URL's query, never any candidate data. */
  host: string;
  /** Which runner hit it, e.g. "ats_live_fill:greenhouse". */
  surface: string;
  provider: CaptchaProvider;
  signals: string[];
  paused: boolean;
  /** null when the run never paused (unattended). */
  cleared: boolean | null;
  waited_ms: number;
};

export type CaptchaPauseResult = {
  paused: boolean;
  cleared: boolean;
  waited_ms: number;
  polls: number;
  notes: string[];
};

const PAUSE_TIMEOUT_MS = 90_000;
const PAUSE_POLL_MS = 5_000;

/** Fresh read of the live page: is the blocking challenge still there? */
export async function pageStillBlockedByCaptcha(page: Page): Promise<boolean> {
  try {
    const html = await page.content();
    const title = await page.title().catch(() => "");
    const fields = discoverFieldsFromHtml(html);
    return detectBlockingCaptcha({
      finalUrl: page.url(),
      html,
      title,
      formDetected: fields.length > 0,
      fieldCount: fields.length,
    }).detected;
  } catch {
    // A page we cannot read is not a page the operator has cleared.
    return true;
  }
}

/**
 * Attended: announce the challenge (terminal bell + the page URL) and
 * poll until the operator clears it or the window closes. Unattended:
 * immediate no-op — park exactly as before.
 */
export async function pauseForHumanCaptcha(
  page: Page,
  options: {
    attended: boolean;
    isCleared?: () => Promise<boolean>;
    timeoutMs?: number;
    intervalMs?: number;
    /** Test seam for the announcement side effect. */
    announce?: (message: string) => void;
  },
): Promise<CaptchaPauseResult> {
  if (!options.attended) {
    return {
      paused: false,
      cleared: false,
      waited_ms: 0,
      polls: 0,
      notes: ["captcha: unattended run — parked without pausing"],
    };
  }
  const timeoutMs = options.timeoutMs ?? PAUSE_TIMEOUT_MS;
  const intervalMs = Math.max(50, options.intervalMs ?? PAUSE_POLL_MS);
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  const isCleared =
    options.isCleared ?? (async () => !(await pageStillBlockedByCaptcha(page)));
  const announce =
    options.announce ??
    ((message: string) => {
      // Bell + message on stderr: reaches the operator's terminal without
      // touching the JSON report on stdout. No notification dependency.
      process.stderr.write(`${message}\n`);
    });

  announce(
    `CAPTCHA needs you: solve it in the open browser window (${page.url()}) — ` +
      `waiting up to ${Math.round(timeoutMs / 1000)}s, then parking for review.`,
  );

  const startedAt = Date.now();
  let polls = 0;
  while (polls < maxPolls && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(intervalMs).catch(() => undefined);
    polls += 1;
    if (await isCleared()) {
      const waited = Date.now() - startedAt;
      return {
        paused: true,
        cleared: true,
        waited_ms: waited,
        polls,
        notes: [
          `captcha: operator cleared the challenge after ${Math.round(waited / 1000)}s — continuing`,
        ],
      };
    }
  }
  const waited = Date.now() - startedAt;
  return {
    paused: true,
    cleared: false,
    waited_ms: waited,
    polls,
    notes: [
      `captcha: not cleared within ${Math.round(timeoutMs / 1000)}s — parking for review (solve, then requeue)`,
    ],
  };
}

export function buildCaptchaIncident(input: {
  surface: string;
  url: string;
  signals: string[];
  pause: CaptchaPauseResult;
}): CaptchaIncident {
  let host = "unknown";
  try {
    host = new URL(input.url).host;
  } catch {
    // keep "unknown"
  }
  return {
    at: new Date().toISOString(),
    host,
    surface: input.surface,
    provider: classifyCaptchaProvider(input.signals),
    signals: input.signals,
    paused: input.pause.paused,
    cleared: input.pause.paused ? input.pause.cleared : null,
    waited_ms: input.pause.waited_ms,
  };
}
