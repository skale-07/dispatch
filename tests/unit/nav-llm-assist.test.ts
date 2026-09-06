import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import { adjudicateAnchorCandidates } from "../../src/navigation/anchorLlmAdjudicate.js";
import { adjudicateDuplicate } from "../../src/navigation/dupAdjudicate.js";

/**
 * M6/M7 of the LLM decision layer: the model may only PROMOTE an
 * already-harvested candidate (verbatim set membership) or attach a
 * duplicate verdict as evidence — and with the flag off, neither surface
 * even calls the model. UNIT_CONFIRMED.
 */

const stub = (payload: unknown, counter?: { calls: number }): EmailLlmClient => ({
  generateJson: async () => {
    if (counter) counter.calls += 1;
    return { text: JSON.stringify(payload), model: "stub" };
  },
});

const CANDIDATES = [
  { url: "https://careers.acme.com/jobs/123", congruence: "unknown", detail: null },
  { url: "https://www.prnewswire.com/acme-raises", congruence: "unknown", detail: null },
];

describe("nav LLM assist (UNIT_CONFIRMED)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.NAV_LLM_ASSIST_ENABLED = process.env.NAV_LLM_ASSIST_ENABLED;
    process.env.NAV_LLM_ASSIST_ENABLED = "true";
    resetConfigCache();
  });

  afterEach(() => {
    if (saved.NAV_LLM_ASSIST_ENABLED === undefined)
      delete process.env.NAV_LLM_ASSIST_ENABLED;
    else process.env.NAV_LLM_ASSIST_ENABLED = saved.NAV_LLM_ASSIST_ENABLED;
    resetConfigCache();
  });

  it("flag off ⇒ abstains without calling the model", async () => {
    process.env.NAV_LLM_ASSIST_ENABLED = "false";
    resetConfigCache();
    const counter = { calls: 0 };
    const anchor = await adjudicateAnchorCandidates({
      company: "Acme",
      role: "SWE",
      candidates: CANDIDATES,
      client: stub({ choice: CANDIDATES[0]!.url }, counter),
    });
    const dup = await adjudicateDuplicate({
      company: "Acme",
      role: "SWE",
      url: "https://x.example/apply",
      holders: [{ company: "Acme Corp", role: "SWE", state: "QUEUED" }],
      client: stub({ verdict: "same_job" }, counter),
    });
    expect(anchor.choice).toBeNull();
    expect(dup.adjudication).toBeNull();
    expect(counter.calls).toBe(0);
  });

  it("promotes a verbatim member of the candidate set", async () => {
    const result = await adjudicateAnchorCandidates({
      company: "Acme",
      role: "SWE",
      candidates: CANDIDATES,
      client: stub({
        choice: "https://careers.acme.com/jobs/123",
        rationale: "employer careers host",
      }),
    });
    expect(result.choice).toBe("https://careers.acme.com/jobs/123");
  });

  it("rejects a minted URL that is not in the candidate set", async () => {
    const result = await adjudicateAnchorCandidates({
      company: "Acme",
      role: "SWE",
      candidates: CANDIDATES,
      client: stub({ choice: "https://evil.example/phish" }),
    });
    expect(result.choice).toBeNull();
    expect(result.note).toMatch(/not in the candidate set/);
  });

  it("garbage output abstains instead of throwing", async () => {
    const result = await adjudicateAnchorCandidates({
      company: "Acme",
      role: "SWE",
      candidates: CANDIDATES,
      client: { generateJson: async () => ({ text: "not json", model: "stub" }) },
    });
    expect(result.choice).toBeNull();
  });

  it("dup verdicts are set-membership validated; unknown demotes to unsure", async () => {
    const same = await adjudicateDuplicate({
      company: "Bennett Thrasher",
      role: "IT Intern - AI & Automation",
      url: "https://btcpa.rec.pro.ukg.net/x",
      holders: [
        { company: "Barbacane, Thornton & Company", role: "IT Intern - AI & Automation", state: "AMBIGUOUS_FIELD" },
      ],
      client: stub({ verdict: "same_job", rationale: "identical role, shared tenant" }),
    });
    expect(same.adjudication?.verdict).toBe("same_job");

    const weird = await adjudicateDuplicate({
      company: "A",
      role: "B",
      url: "https://x.example",
      holders: [{ company: "C", role: "D", state: "QUEUED" }],
      client: stub({ verdict: "definitely_maybe" }),
    });
    expect(weird.adjudication?.verdict).toBe("unsure");
  });
});
