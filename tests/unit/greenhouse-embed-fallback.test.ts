import { describe, expect, it } from "vitest";
import { greenhouseEmbedFallbackUrl } from "../../src/ats/greenhouse/liveFill.js";

/**
 * Issue #39 (2026-08-30, Zipline): a ?gh_jid= shell with nothing to hop to
 * gets one deterministic navigation to Greenhouse's canonical embed app,
 * built from the board token + job id already in hand. UNIT_CONFIRMED.
 */
describe("greenhouseEmbedFallbackUrl", () => {
  const REQUESTED = "https://job-boards.greenhouse.io/flyzipline/jobs/7980874003";

  it("builds the embed app URL for the live zipline shape", () => {
    expect(
      greenhouseEmbedFallbackUrl(
        REQUESTED,
        REQUESTED,
        "https://www.zipline.com/open-roles?gh_jid=7980874003",
      ),
    ).toBe("https://job-boards.greenhouse.io/embed/job_app?for=flyzipline&token=7980874003");
  });

  it("harder: job id only on the final page, board only on the requested URL", () => {
    expect(
      greenhouseEmbedFallbackUrl(
        "https://boards.greenhouse.io/samsara/jobs/",
        null,
        "https://www.samsara.com/company/careers/roles?gh_jid=8097345",
      ),
    ).toBe("https://job-boards.greenhouse.io/embed/job_app?for=samsara&token=8097345");
  });

  it("returns null when the page is already the embed app", () => {
    expect(
      greenhouseEmbedFallbackUrl(
        REQUESTED,
        REQUESTED,
        "https://job-boards.greenhouse.io/embed/job_app?for=flyzipline&token=7980874003",
      ),
    ).toBeNull();
  });

  it("returns null without a board token or without a job id", () => {
    expect(
      greenhouseEmbedFallbackUrl(
        "https://job-boards.greenhouse.io/embed/job_app?token=7980874003",
        null,
        "https://www.zipline.com/open-roles?gh_jid=7980874003",
      ),
    ).toBeNull();
    expect(
      greenhouseEmbedFallbackUrl(
        "https://job-boards.greenhouse.io/flyzipline/jobs/",
        null,
        "https://www.zipline.com/open-roles",
      ),
    ).toBeNull();
  });

  it("never emits a URL off greenhouse.io and encodes the parts", () => {
    const u = greenhouseEmbedFallbackUrl(
      "https://job-boards.greenhouse.io/fly_zip-line/jobs/42",
      null,
      "https://example.com/?gh_jid=42",
    );
    expect(u).toBe("https://job-boards.greenhouse.io/embed/job_app?for=fly_zip-line&token=42");
    expect(new URL(u!).hostname).toBe("job-boards.greenhouse.io");
  });
});
