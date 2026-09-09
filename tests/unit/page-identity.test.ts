import { describe, expect, it } from "vitest";
import { checkUrlCongruence, pageNamesCompany } from "../../src/navigation/congruence.js";
import { confirmEmployerOnPage } from "../../src/navigation/pageIdentity.js";

/**
 * #197 (live Daylit 2026-09-08, night27): jobs.polymer.co/lendica/41094 —
 * "polymer" was read as the employer (vendor host), and once that is
 * fixed the path slug "lendica" (the company's FORMER name) still accuses
 * a page titled "… at Daylit (Formerly Lendica)". Page text is the
 * stronger evidence; the URL alone may not refuse a page that names the
 * company. UNIT_CONFIRMED; the title/text are the live probe's.
 */
describe("page-level employer identity (#197, UNIT_CONFIRMED)", () => {
  it("polymer.co is a vendor host: the org comes from the path, never the hostname", () => {
    const v = checkUrlCongruence("Daylit", "https://jobs.polymer.co/lendica/41094");
    expect(v.slug).not.toBe("polymer");
    expect(v.verdict).toBe("mismatch");
    expect(v.slug).toBe("lendica");
  });

  it("names a single-token company from the page title (rebrand slug case)", () => {
    const title = "Full Stack AI Engineer Co-Op (Northeastern Students only) Spring 2027 at Daylit (Formerly Lendica)";
    expect(pageNamesCompany("Daylit", title)).toEqual({ named: true, hit: "daylit" });
    expect(pageNamesCompany("Lendica", title).named).toBe(true);
    expect(pageNamesCompany("Coinbase", title).named).toBe(false);
  });

  it("multi-token companies need the phrase or the joined form, never one common word", () => {
    expect(pageNamesCompany("Energy Systems Group", "Careers at Energy Systems Group — apply").named).toBe(true);
    expect(pageNamesCompany("Energy Systems Group", "Energy sector jobs at Acme Systems").named).toBe(false);
    expect(pageNamesCompany("Jump Trading", "JumpTrading Careers").named).toBe(true);
    expect(pageNamesCompany("Bank of America", "Bank of America careers portal").named).toBe(true);
    expect(pageNamesCompany("Energy Systems Group (ESG)", "Welcome to ESG careers").named).toBe(true);
  });

  it("short or placeholder names never match", () => {
    expect(pageNamesCompany("Unknown company (manual enqueue)", "Unknown company").named).toBe(false);
    expect(pageNamesCompany("IBM", "Careers at IBM").named).toBe(false); // 3 chars: too short to trust as a word
    expect(pageNamesCompany("", "anything").named).toBe(false);
  });

  it("confirmEmployerOnPage: page names the company ⇒ named with evidence; bot-check ⇒ not named", async () => {
    const ok = await confirmEmployerOnPage({
      url: "https://jobs.polymer.co/lendica/41094",
      company: "Daylit",
      cdpUrl: "http://127.0.0.1:1",
      readPage: async () => ({
        title: "Full Stack AI Engineer Co-Op at Daylit (Formerly Lendica)",
        text: "Daylit (Formerly Lendica) Subscribe View jobs Name Email address Phone number",
        final_url: "https://jobs.polymer.co/lendica/41094",
      }),
    });
    expect(ok.named).toBe(true);
    expect(ok.hit).toBe("daylit");
    expect(ok.error).toBeNull();

    const wall = await confirmEmployerOnPage({
      url: "https://jobs.polymer.co/lendica/41094",
      company: "Daylit",
      cdpUrl: "http://127.0.0.1:1",
      readPage: async () => ({ title: "Just a moment...", text: "", final_url: "x" }),
    });
    expect(wall.named).toBe(false);
    expect(wall.error).toMatch(/interstitial/);

    const other = await confirmEmployerOnPage({
      url: "https://jobs.polymer.co/acme/1",
      company: "Daylit",
      cdpUrl: "http://127.0.0.1:1",
      readPage: async () => ({ title: "Engineer at Acme", text: "Acme careers", final_url: "x" }),
    });
    expect(other.named).toBe(false);
    expect(other.error).toBeNull();

    const thrown = await confirmEmployerOnPage({
      url: "https://jobs.polymer.co/acme/1",
      company: "Daylit",
      cdpUrl: "http://127.0.0.1:1",
      readPage: async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
    });
    expect(thrown.named).toBe(false);
    expect(thrown.error).toMatch(/CONNECTION_RESET/);
  });
});
