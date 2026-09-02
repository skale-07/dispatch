import type { Page } from "playwright";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { matchCanonicalField } from "../../applications/fieldNormalization.js";
import { isDemographicsField } from "../../applications/essayDetector.js";
import { loadAnswerAliases } from "../../candidate/answerAliases.js";
import { getProfileValue, type PublicProfile } from "../../candidate/publicProfile.js";
import { loadPublicProfile } from "../../candidate/publicProfileIO.js";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";

/**
 * #149 (live UKG run 17, resume-review page): "State / Province" is a
 * DEPENDENT select — hidden with a lone placeholder until Country is
 * chosen, then revealed with 59 options. The plan is built from the
 * pre-fill HTML, so the control is either undiscovered or has no answer
 * space at plan time; the fill then picks Country and the page's own
 * validation refuses Save with "Please select a state/province." — a
 * value the profile holds.
 *
 * After a fill, one bounded pass over the page's NATIVE selects: any
 * visible select still at its placeholder that now offers a real option
 * list, whose label maps to a PUBLIC-profile canonical with a value that
 * matches one of those options verbatim (pickOptionLabel), is selected.
 *
 * Conservative by construction:
 *   - Deterministic profile tier only — no screener bank, no LLM, no
 *     "Other" fallback. An unmapped or unmatched select is left for the
 *     normal tiers on the next plan.
 *   - Demographic / self-ID selects never take this path (they fill only
 *     from the sensitive profile, elsewhere).
 *   - Already-answered selects are never re-chosen; the plan's own picks
 *     and page prefills stand.
 *   - Bounded: at most REVEALED_SELECT_CAP picks per pass.
 */

export const REVEALED_SELECT_CAP = 6;

/** Browser-side shape of a native <select> (no DOM lib in this build). */
type SelectLike = {
  value: string;
  selectedIndex: number;
  options: ArrayLike<{ textContent?: string | null }> &
    Iterable<{ textContent?: string | null }>;
};

export type RevealedSelectOutcome = {
  field_id: string;
  label: string;
  canonical_field: string;
  chose: string;
  verified: boolean;
};

const PLACEHOLDER = /^(|select( one)?|choose( one)?|please (select|choose)|--+|—|none|select\.{3}|choose\.{3})$/i;

function isPlaceholderOption(text: string): boolean {
  return PLACEHOLDER.test(text.trim().replace(/\.{3}$/, "").trim()) || /^(select|choose)\b/i.test(text.trim());
}

function selectorFor(field: { inputId?: string; name?: string }): string | null {
  if (field.inputId) {
    return `select[id="${field.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }
  if (field.name) return `select[name="${field.name.replace(/"/g, '\\"')}"]`;
  return null;
}

export async function fillRevealedProfileSelects(input: {
  page: Page;
  profile?: PublicProfile;
  aliases?: Record<string, string[]>;
}): Promise<{ outcomes: RevealedSelectOutcome[]; notes: string[] }> {
  const { page } = input;
  const notes: string[] = [];
  const outcomes: RevealedSelectOutcome[] = [];
  let html: string;
  try {
    html = await page.content();
  } catch {
    return { outcomes, notes: ["revealed-select: could not re-read the page after fill"] };
  }
  const aliases = input.aliases ?? loadAnswerAliases();
  let profile: PublicProfile;
  try {
    profile = input.profile ?? loadPublicProfile();
  } catch {
    return { outcomes, notes: ["revealed-select: no public profile on disk — pass skipped"] };
  }

  const candidates = discoverFieldsFromHtml(html).filter(
    (f) =>
      f.type === "select" &&
      (f.inputId || f.name) &&
      (f.options ?? []).filter((o) => !isPlaceholderOption(o)).length >= 2 &&
      !isDemographicsField(f),
  );

  for (const field of candidates) {
    if (outcomes.length >= REVEALED_SELECT_CAP) {
      notes.push(`revealed-select: cap of ${REVEALED_SELECT_CAP} picks reached`);
      break;
    }
    const canonical = matchCanonicalField(field, aliases);
    if (!canonical || canonical.startsWith("screener:")) continue;
    const raw = getProfileValue(profile, canonical);
    const expected = raw === undefined || raw === null ? "" : String(raw).trim();
    if (expected === "") continue;
    const selector = selectorFor(field);
    if (!selector) continue;
    const loc = page.locator(selector).first();
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    // Live read: the option list and the committed value as the page holds
    // them now (a dependent select's options arrive after the parent pick).
    const live = await loc
      .evaluate((el: SelectLike) => ({
        current: el.options[el.selectedIndex]?.textContent?.trim() ?? "",
        currentValue: el.value,
        options: Array.from(el.options).map((o) => o.textContent?.trim() ?? ""),
      }))
      .catch(() => null);
    if (!live) continue;
    const answered =
      live.currentValue !== "" && !isPlaceholderOption(live.current);
    if (answered) continue;
    const realOptions = live.options.filter((o) => !isPlaceholderOption(o));
    if (realOptions.length < 2) continue;
    const pick = pickOptionLabel(realOptions, expected);
    if (!pick.ok) {
      notes.push(
        `revealed-select: "${field.label.slice(0, 40)}" (${canonical}) offers no option for the profile value — left for review`,
      );
      continue;
    }
    try {
      await loc.selectOption({ label: pick.label }, { timeout: 5_000 });
      const readBack = await loc
        .evaluate((el: SelectLike) => el.options[el.selectedIndex]?.textContent?.trim() ?? "")
        .catch(() => "");
      const verified = readBack === pick.label;
      outcomes.push({
        field_id: field.id,
        label: field.label,
        canonical_field: canonical,
        chose: pick.label,
        verified,
      });
      notes.push(
        `revealed-select: "${field.label.slice(0, 40)}" (${canonical}) → "${pick.label}"${verified ? "" : " (read-back mismatch)"}`,
      );
    } catch (err) {
      notes.push(
        `revealed-select: "${field.label.slice(0, 40)}" could not be chosen: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
      );
    }
  }
  return { outcomes, notes };
}
