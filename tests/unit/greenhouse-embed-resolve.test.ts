import { describe, expect, it } from "vitest";
import {
  boardTokenFromEmbedHtml,
  resolveTokenOnlyGreenhouseEmbed,
  tokenOnlyGreenhouseEmbed,
} from "../../src/navigation/greenhouseEmbedResolve.js";
import { validateGreenhouseApplicationUrl } from "../../src/ats/greenhouse/urlValidation.js";

/**
 * Night19 #50 (2026-08-30): JobRight's Greenhouse anchors are token-only
 * embeds; Greenhouse serves the form for them and names the board in the
 * form action (live: token 7796180003 → for=oldmissioncapital). One
 * read-only GET replaces an agent budget. UNIT_CONFIRMED with a fake
 * fetcher shaped like the live response.
 */
const LIVE_ANCHOR =
  "https://boards.greenhouse.io/embed/job_app?token=7796180003&utm_source=jobright&jr_id=6a57c970a791c6211bf00ff5";
const LIVE_HTML = `<html><head><title>Job Application for Software Engineer – 2027 Internship Program at Old Mission</title>
  <link rel="canonical" href="https://boards.greenhouse.io/embed/job_app?for=oldmissioncapital&amp;token=7796180003"></head>
  <body><form method="get" action="/embed/job_app?for=oldmissioncapital&amp;token=7796180003" id="application-form" class="application-form">
  <input id="first_name" /><input id="last_name" /></form>
  <a href="/embed/job_board?for=oldmissioncapital">All jobs</a></body></html>`;

describe("token-only greenhouse embed anchors", () => {
  it("recognises JobRight's token-only shape and ignores canonical / foreign URLs", () => {
    expect(tokenOnlyGreenhouseEmbed(LIVE_ANCHOR)).toEqual({ jobId: "7796180003", base: "https://boards.greenhouse.io" });
    expect(tokenOnlyGreenhouseEmbed("https://boards.greenhouse.io/embed/job_app?for=flyzipline&token=7980874003")).toBeNull();
    expect(tokenOnlyGreenhouseEmbed("https://boards.greenhouse.io/oldmissioncapital/jobs/7796180003")).toBeNull();
    expect(tokenOnlyGreenhouseEmbed("https://jobs.lever.co/acme/123")).toBeNull();
    expect(tokenOnlyGreenhouseEmbed("https://boards.greenhouse.io/embed/job_app?token=abc")).toBeNull();
  });

  it("reads the board from the served page's form action, else the most frequent for=", () => {
    expect(boardTokenFromEmbedHtml(LIVE_HTML)).toBe("oldmissioncapital");
    expect(boardTokenFromEmbedHtml('<a href="/embed/job_board?for=acme">x</a><a href="?for=acme">y</a><a href="?for=other">z</a>')).toBe("acme");
    expect(boardTokenFromEmbedHtml("<html>no board here</html>")).toBeNull();
  });

  it("resolves the live anchor to a canonical URL the strict validator accepts, with ONE GET", async () => {
    const calls: string[] = [];
    const r = await resolveTokenOnlyGreenhouseEmbed(LIVE_ANCHOR, async (url) => {
      calls.push(url);
      return { ok: true, text: LIVE_HTML };
    });
    expect(calls).toEqual(["https://boards.greenhouse.io/embed/job_app?token=7796180003"]);
    expect(r?.board).toBe("oldmissioncapital");
    expect(r?.url).toBe("https://boards.greenhouse.io/embed/job_app?for=oldmissioncapital&token=7796180003");
    expect(validateGreenhouseApplicationUrl(r!.url).passed).toBe(true);
    expect(validateGreenhouseApplicationUrl(LIVE_ANCHOR).passed).toBe(false);
  });

  it("fetch failure, non-200, or a page without a board ⇒ null (never a guessed board)", async () => {
    expect(await resolveTokenOnlyGreenhouseEmbed(LIVE_ANCHOR, async () => null)).toBeNull();
    expect(await resolveTokenOnlyGreenhouseEmbed(LIVE_ANCHOR, async () => ({ ok: false, text: "" }))).toBeNull();
    expect(await resolveTokenOnlyGreenhouseEmbed(LIVE_ANCHOR, async () => ({ ok: true, text: "<html>Job not found</html>" }))).toBeNull();
    // Canonical anchors never trigger a fetch.
    let fetched = 0;
    expect(
      await resolveTokenOnlyGreenhouseEmbed("https://boards.greenhouse.io/embed/job_app?for=x&token=1", async () => {
        fetched += 1;
        return { ok: true, text: LIVE_HTML };
      }),
    ).toBeNull();
    expect(fetched).toBe(0);
  });
});
