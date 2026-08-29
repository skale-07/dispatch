import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ashbyFillFromPlan,
  ashbyVerifyFromPlan,
} from "../../src/ats/ashby/fill.js";
import type { FieldMeta } from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyFixtureFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Regression for live session 1b93205e: the 2026-08 Ashby form variant
 * labels each question with <label for=FIELD_ID> where FIELD_ID exists on
 * no control, and renders choice questions as fieldset input groups with
 * NATIVE radio/checkbox inputs. Label-based lookup errored "control not
 * found on the page" for every such field at fill AND verify
 * (artifacts/ats-fill/ashby-live/live-executed-1787971385570.json) — the
 * wrapper's data-field-path / data-field-entry-id is the stable handle.
 */

const fixtureHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "ashby",
    "dom.variant-2026-08.html",
  ),
  "utf8",
);

const SPONSOR_ID = "11111111-aaaa-bbbb-cccc-000000000001";
const HOWHEARD_ID = "22222222-aaaa-bbbb-cccc-000000000002";
const DATE_ID = "33333333-aaaa-bbbb-cccc-000000000003";

// The live plan typed these fields WRONG (select/checkbox/text) — the fix
// classifies by the live DOM, so the fixture entries carry the same wrong
// types the session recorded.
const ENTRIES = [
  {
    field_id: SPONSOR_ID,
    label:
      "Will you now or at any time in the future require sponsorship for employment visa status (e.g. H1B, OPT)?",
    type: "select" as const,
    canonical_field: "requires_sponsorship",
    action: "FILL" as const,
    approved: true as const,
    value: "No",
    reason: "test",
  },
  {
    field_id: HOWHEARD_ID,
    label: "How did you hear about this opportunity? (select all that apply)",
    type: "checkbox" as const,
    canonical_field: "screener:how_heard",
    action: "FILL" as const,
    approved: true as const,
    value: "LinkedIn",
    reason: "test",
  },
  {
    field_id: DATE_ID,
    // Discovery captured the placeholder as the label — no such label exists.
    label: "Pick date...",
    type: "text" as const,
    canonical_field: "screener:custom:available_start_date",
    action: "FILL" as const,
    approved: true as const,
    value: "05/15/2027",
    reason: "test",
  },
];

const FIELD_META = new Map<string, FieldMeta>([
  [SPONSOR_ID, { type: "select" }],
  [HOWHEARD_ID, { type: "checkbox" }],
  [DATE_ID, { type: "text" }],
]);

describe("Ashby 2026-08 variant: wrapper-first resolution", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it(
    "fills fieldset input groups and the placeholder-labelled date via the data-field wrapper (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const result = await ashbyFillFromPlan(page, ENTRIES, FIELD_META);
          expect(result.errors).toEqual([]);
          expect(result.filled).toContain("requires_sponsorship");
          expect(result.filled).toContain("screener:how_heard");
          expect(result.filled).toContain(
            "screener:custom:available_start_date",
          );

          // Independent DOM read-backs, not the filler's own claims.
          expect(
            await page.locator("#deadbeef-sponsorship-radio-1").isChecked(),
          ).toBe(true);
          expect(
            await page.locator("#deadbeef-sponsorship-radio-0").isChecked(),
          ).toBe(false);
          expect(
            await page.locator("#deadbeef-howheard-check-0").isChecked(),
          ).toBe(true);
          expect(
            await page
              .locator('input[placeholder="Pick date..."]')
              .inputValue(),
          ).toBe("05/15/2027");

          const verify = await ashbyVerifyFromPlan(page, ENTRIES, FIELD_META);
          expect(verify.warnings).toEqual([]);
          expect(verify.passed).toBe(true);
          const sponsor = verify.fields.find(
            (f) => f.canonical_field === "requires_sponsorship",
          )!;
          expect(sponsor.observed).toBe("No");
          expect(sponsor.match).toBe(true);
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "refuses an option absent from the page instead of inventing one (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const forged = [{ ...ENTRIES[0]!, value: "Only with conditions" }];
          const result = await ashbyFillFromPlan(page, forged, FIELD_META);
          expect(result.errors).toHaveLength(1);
          expect(result.filled).toEqual([]);
          expect(
            await page
              .locator('input[type="radio"]:checked, input[type="checkbox"]:checked')
              .count(),
          ).toBe(0);
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );
});
