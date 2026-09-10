import type { Page, Locator } from "playwright";
import { DATE_INPUT_SELECTOR } from "../shared/dateInputs.js";
import fs from "node:fs";
import path from "node:path";
import type {
  FieldFillMeta,
  FillResult,
  FormResetResult,
  FormVerificationResult,
  ResolvedApplicationAnswers,
  UploadVerification,
} from "../adapter.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { isDemographicsField } from "../../applications/essayDetector.js";
import {
  detectControlKind,
  fillComboboxControl,
  labelsCompatible,
  pickOptionLabel,
  readComboboxValue,
} from "./comboboxFill.js";
import { logger } from "../../logging/logger.js";
import { locationsMatch } from "../../applications/locationQuery.js";
import { loadPublicProfile } from "../../candidate/publicProfileIO.js";

export type FieldMeta = {
  name?: string;
  inputId?: string;
  type: FillPlanEntry["type"];
};

export type ExecutableFillEntry = ApprovedFillPlanEntry | FillPlanEntry;

export function locatorForField(
  page: Page,
  entry: Pick<FillPlanEntry, "field_id" | "label"> & {
    name?: string;
    inputId?: string;
  },
  /**
   * The entry's planned control type. Live 2026-08-16 (neuralink run): a
   * URL entry labeled "LinkedIn" resolved via getByLabel onto the
   * how-did-you-hear "LinkedIn" CHECKBOX — the URL was written into a
   * checkbox, verify read `true`, and the real LinkedIn input stayed
   * empty. Labels are not unique on a page; the control CLASS is the
   * discriminator. When provided, the label fallback only matches
   * controls compatible with the type — a text/url entry never lands on
   * a checkbox/radio, and a checkbox/radio entry never lands on a text
   * input. id/name lookups are already unambiguous and skip the filter.
   */
  type?: FillPlanEntry["type"],
  opts?: {
    /**
     * Restrict the label-based tiers to VISIBLE controls. Live tiaa.wd1
     * 2026-08-30 (#61): "Phone" document-first matched a HIDDEN Workday
     * decoy input carrying a hex token — the fill hung 30s on it while
     * the real visible input sat empty. Callers ladder: visible-first,
     * then the unrestricted match. id/name lookups are exact and skip
     * this; checkbox/radio tiers never filter (painted inputs are
     * legitimately hidden behind styled spans).
     */
    visibleOnly?: boolean;
  },
): Locator {
  if (entry.inputId) {
    // Greenhouse free-text / EEO question ids are pure digits (e.g. 4010536008).
    // Those are invalid as bare CSS `#id` — always attribute-select.
    const escaped = entry.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`[id="${escaped}"]`).first();
  }
  if (entry.name) {
    const byName = page.locator(`[name="${entry.name.replace(/"/g, '\\"')}"]`);
    // #139 (live UKG AuthCode/Register 2026-09-01): web-component hosts
    // MIRROR the name attribute — `<ukg-input name="firstName">` wraps the
    // native `<input name="firstName">`, and the bare [name=…].first()
    // resolved the HOST (document order), which Playwright cannot fill or
    // read. Prefer the match that IS a control, else descend into the
    // host; plain pages resolve exactly as before.
    const NAME_CONTROL =
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
    return byName
      .and(page.locator(NAME_CONTROL))
      .or(byName.locator(NAME_CONTROL))
      .first();
  }
  const byLabel = page.getByLabel(entry.label, { exact: false });
  // Workday (live huntington 2026-08-30 #54): <label for> points at a
  // WRAPPER div (data-automation-id container), so getByLabel resolves to
  // an element Playwright cannot fill ("Element is not an <input>…").
  // Accept the labelled element when it IS a control, else descend to the
  // first real control inside it.
  const CONTROL = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
  const labelledControl = byLabel.and(page.locator(CONTROL));
  const innerControl = byLabel.locator(CONTROL);
  // #114b (live sierra 2026-09-01): Ashby anchors its extra-question and
  // demographic fields by `data-field-path="<field id>"` on a WRAPPER div —
  // no element id, name, or label[for] anywhere, so every tier missed and
  // four discovered controls were "not found". The wrapper's first control
  // (or its member boxes) is the target; absent attribute = empty union.
  const fpEsc = entry.field_id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const fieldPathWrap = page.locator(`[data-field-path="${fpEsc}"]`);
  const vis = (l: Locator): Locator =>
    opts?.visibleOnly ? l.and(page.locator(":visible")) : l;
  if (type === "checkbox" || type === "radio") {
    const boxes = 'input[type="checkbox"], input[type="radio"]';
    return fieldPathWrap
      .locator(boxes)
      .or(byLabel.and(page.locator(boxes)))
      .or(byLabel.locator(boxes))
      .first();
  }
  if (type !== undefined && type !== "select") {
    const notBox = ':not(input[type="checkbox"]):not(input[type="radio"])';
    return vis(fieldPathWrap.locator(CONTROL).and(page.locator(notBox)))
      .or(vis(labelledControl.and(page.locator(notBox))))
      .or(vis(innerControl.and(page.locator(notBox))))
      .or(vis(labelForDescend(page, entry.label, CONTROL_XPATH).and(page.locator(notBox))))
      .first();
  }
  // NOTE: .or() is a union and .first() takes DOCUMENT order — an ancestor
  // wrapper would always beat its inner control. Never include the bare
  // labelled element: only real controls may win.
  return vis(fieldPathWrap.locator(CONTROL))
    .or(vis(labelledControl))
    .or(vis(innerControl))
    .or(vis(labelForDescend(page, entry.label, CONTROL_XPATH)))
    .first();
}

const CONTROL_XPATH =
  '/descendant::*[self::input[not(@type="hidden")] or self::textarea or self::select or @contenteditable="true"][1]';

/**
 * #112 (live nuvo on jobs.gem.com 2026-08-31): captions are bare spans and
 * the inputs carry NO id/name/label/aria/placeholder — every earlier tier
 * finds nothing. Locate the caption text run itself (a short text node
 * whose element does NOT contain a control, so `following::` cannot skip
 * into the next field's subtree) and take the first control after it.
 * LAST matching caption wins: page furniture mentioning the same word
 * (job description "Email …") sits above the form.
 */
export function captionFollowControl(page: Page, label: string): Locator {
  const text = label.replace(/\s+/g, " ").trim().slice(0, 80);
  if (text.length < 3) return page.locator("__no_such_control__");
  const lit = text.includes('"') ? `'${text.replace(/'/g, "")}'` : `"${text}"`;
  const caption =
    `//*[self::span or self::div or self::p or self::b or self::strong]` +
    `[not(descendant::input) and not(descendant::textarea) and not(descendant::select)]` +
    `[starts-with(normalize-space(.), ${lit})]` +
    `[string-length(normalize-space(.)) <= ${text.length + 8}]`;
  return page.locator(
    `xpath=((${caption})[last()]/following::*[self::input[not(@type="hidden")] or self::textarea or self::select][1])`,
  );
}

/**
 * Playwright's getByLabel only associates a <label for> with FORM controls;
 * when `for` targets a wrapper div (Workday) nothing is found at all. Walk
 * it explicitly: label text → @for → element with that id → first control
 * inside. Literal label text, quoted safely for XPath.
 */
function labelForDescend(page: Page, label: string, controlXpath: string): Locator {
  const text = label.replace(/\s+/g, " ").trim().slice(0, 120);
  const lit = text.includes('"') ? `'${text.replace(/'/g, "")}'` : `"${text}"`;
  return page.locator(
    `xpath=(//*[@id = //label[contains(normalize-space(.), ${lit})]/@for])[1]${controlXpath}`,
  );
}

/**
 * Check a box/radio whose native input is PAINTED OVER (live tiaa.wd1
 * 2026-08-30 #61: display-hidden inputs behind styled spans — check()
 * waited 30s on "element is not visible" for the SMS/WhatsApp opt-ins).
 * A hidden input's <label for> still activates it; verify keeps reading
 * the input's own checked state, so nothing is trusted on faith.
 */
async function checkPaintedControl(page: Page, input: Locator): Promise<void> {
  // #63b: a detached control (Workday's regenerated ids) must fail FAST
  // and named — force-check would otherwise wait 30s for re-attachment.
  if ((await input.count().catch(() => 0)) === 0) {
    throw new Error("control detached before check (stale generated id)");
  }
  if (await input.isVisible().catch(() => false)) {
    // #68 (live tiaa #22q): a VISIBLE Workday radio can still sit under a
    // painted overlay div that intercepts pointer events — check() waited
    // its full 30s and the ladder below never ran. Bounded try, then fall
    // through to the label-click / JS-click tiers; read-back arbitrates.
    try {
      await input.check({ timeout: 5_000 });
      return;
    } catch {
      // fall through to the painted-control ladder
    }
  }
  const id = await input.getAttribute("id").catch(() => null);
  if (id) {
    const lab = page
      .locator(`label[for="${id.replace(/"/g, '\\"')}"]`)
      .first();
    if ((await lab.count().catch(() => 0)) > 0) {
      await lab.click({ timeout: 8_000 }).catch(() => undefined);
      if (await input.isChecked().catch(() => false)) return;
    }
  }
  // Live tiaa.wd1 #22g: the SMS/WhatsApp opt-ins have NO label[for] at
  // all (the consent text is a richText div) and force-check throws
  // "Element is not visible" on a display-hidden input. A JS click on
  // the input itself still toggles it and fires the framework's change
  // pipeline; the read-back stays the arbiter.
  await input
    .evaluate((el: { click: () => void }) => el.click())
    .catch(() => undefined);
  if (await input.isChecked().catch(() => false)) return;
  // Last resort, still verified afterwards by the read-back.
  await input.check({ force: true });
}

/**
 * Choose a radio-group member by the planned value: the member's own
 * label text or value attribute (same matching the radio branch always
 * used), clicked painted-safe. No match ⇒ named refusal, never a guess.
 */
async function checkRadioGroupMember(
  page: Page,
  group: Locator,
  value: unknown,
): Promise<string> {
  const wanted = String(value).toLowerCase();
  const count = await group.count();
  for (let i = 0; i < count; i++) {
    const opt = group.nth(i);
    const val = ((await opt.getAttribute("value")) ?? "").toLowerCase();
    const labelText = await opt.evaluate(
      (el: {
        getAttribute: (name: string) => string | null;
        parentElement?: { textContent?: string | null } | null;
      }) => {
        const id = el.getAttribute("id");
        if (id) {
          const doc = (
            globalThis as unknown as {
              document?: {
                querySelector: (s: string) => { textContent?: string | null } | null;
              };
            }
          ).document;
          const lab = doc?.querySelector(`label[for="${id}"]`);
          if (lab?.textContent) return lab.textContent.trim();
        }
        return el.parentElement?.textContent?.trim() ?? "";
      },
    );
    if (val === wanted || labelText.toLowerCase().includes(wanted)) {
      await checkPaintedControl(page, opt);
      return labelText || val;
    }
  }
  throw new Error(`No radio option for "${String(value)}"`);
}

/**
 * Consent-style values mean "set THIS checkbox's state"; anything else on a
 * checkbox control is an option label that must match a group member
 * (issue #21/#10 — blind-checking turned "United States" into `true`).
 */
function isCheckboxBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  const s = String(value).trim().toLowerCase();
  return ["true", "false", "yes", "no", "on", "off", "1", "0"].includes(s);
}

/**
 * Labeled options around a checkbox control. Scope is conservative:
 * the nearest fieldset / role=group only — a whole-form scan could hand
 * an unrelated same-text checkbox to the fill. No group ⇒ just the
 * control itself (its own label may still match the planned text).
 */
async function collectCheckboxGroupOptions(
  loc: Locator,
): Promise<Array<{ id: string; label: string; checked: boolean }>> {
  return loc.evaluate(
    (el: {
      name?: string;
      closest: (sel: string) => {
        querySelectorAll: (sel: string) => ArrayLike<unknown>;
      } | null;
      ownerDocument: {
        querySelector: (s: string) => { textContent?: string | null } | null;
        querySelectorAll: (s: string) => ArrayLike<unknown>;
      };
    }) => {
      const doc = el.ownerDocument;
      type Box = {
        id?: string;
        parentElement?: { textContent?: string | null } | null;
        checked?: boolean;
      };
      const scope =
        el.closest("fieldset") ?? el.closest('[role="group"]') ?? null;
      let boxes: Box[];
      if (scope) {
        boxes = Array.from(scope.querySelectorAll('input[type="checkbox"]')) as Box[];
      } else if (el.name) {
        // #230 (live Palantir/Lever, day28): Lever renders a multi-select
        // question as sibling checkboxes that share one `name`
        // (cards[<uuid>][field0]) and sit in no fieldset or role=group —
        // so the scoped lookup above saw a group of ONE and refused
        // ("no option matching \"Washington, DC\" (options: New York, NY)").
        // A shared name IS the HTML definition of a checkbox group, so it
        // is the right fallback for any ATS, not a Lever special case.
        const escaped = el.name.replace(/["\\]/g, "\\$&");
        boxes = Array.from(
          doc.querySelectorAll(`input[type="checkbox"][name="${escaped}"]`),
        ) as Box[];
        if (boxes.length === 0) boxes = [el as unknown as Box];
      } else {
        boxes = [el as unknown as Box];
      }
      return boxes.map((b) => {
        let label = "";
        if (b.id) {
          const lab = doc.querySelector(`label[for="${b.id}"]`);
          if (lab?.textContent) label = lab.textContent;
        }
        if (!label) label = b.parentElement?.textContent ?? "";
        return {
          id: b.id ?? "",
          label: label.replace(/\s+/g, " ").trim(),
          checked: Boolean(b.checked),
        };
      });
    },
  );
}

async function setSelectByValueOrLabel(
  locator: Locator,
  value: unknown,
): Promise<void> {
  const text = String(value);
  // Read the list first. Playwright's selectOption waits ~30s for a
  // missing label to appear — that is what made the gauntlet look like
  // it "stopped" on Yes/No fields planned as company/major strings.
  const options = await locator.locator("option").allTextContents();
  const match = options.find(
    (o) => o.trim().toLowerCase() === text.toLowerCase(),
  );
  if (match) {
    await locator.selectOption({ label: match }, { timeout: 2_000 });
    return;
  }
  const partial = options.find((o) =>
    o.toLowerCase().includes(text.toLowerCase()),
  );
  if (partial) {
    await locator.selectOption({ label: partial }, { timeout: 2_000 });
    return;
  }
  const pick = pickOptionLabel(options, text);
  if (pick.ok) {
    await locator.selectOption({ label: pick.label }, { timeout: 2_000 });
    return;
  }
  throw new Error(
    `No select option matching "${text}" (options: ${options.join(", ")})`,
  );
}

function isLocationStyleField(entry: {
  field_id: string;
  label: string;
  canonical_field?: string | null;
  name?: string;
  inputId?: string;
}): boolean {
  const label = entry.label.replace(/\(.*?\)/g, "").trim().toLowerCase();
  // Split address "City" is a text box, not a Places typeahead.
  if (/^city$/.test(label)) return false;
  if (entry.canonical_field === "address.city") return true;
  const blob = `${entry.field_id} ${entry.label} ${entry.name ?? ""} ${entry.inputId ?? ""}`.toLowerCase();
  return (
    blob.includes("location-input") ||
    /\bcurrent location\b/.test(blob) ||
    /^location$/.test(entry.label.trim().toLowerCase())
  );
}

/**
 * Lever/GH "Current location" style fields: type city (prefer city + state),
 * wait for an autocomplete dropdown, click a match or the first row, then
 * keyboard ArrowDown+Enter as last resort. Plain fill alone does NOT commit
 * Places-style widgets (they clear unselected text on blur).
 */
async function fillLocationStyleText(
  page: Page,
  loc: Locator,
  value: unknown,
): Promise<{ notes: string[] }> {
  const text = String(value).trim();
  const notes: string[] = [];
  if (!text) {
    notes.push("location fill skipped — empty value");
    return { notes };
  }

  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await loc.click({ timeout: 5_000 });
  // Clear residual/autocomplete cache
  await loc.fill("");
  await loc.press("Control+A").catch(() => undefined);
  await loc.press("Backspace").catch(() => undefined);

  // Type so key events fire (many widgets ignore .fill for suggestions).
  await loc.pressSequentially(text, { delay: 40 });
  // Nudge filters that key up only after a pause
  await page.waitForTimeout(350);

  const suggestionSelectors = [
    ".pac-item:visible",
    ".pac-container .pac-item",
    '[role="listbox"] [role="option"]:visible',
    '[role="option"]:visible',
    "ul.dropdown-menu li:visible",
    ".tt-suggestion:visible",
    ".autocomplete-suggestion:visible",
    ".location-typeahead-option:visible",
    "[class*='suggestion']:visible",
    "[class*='dropdown'] li:visible",
    "[class*='Dropdown'] [class*='option']:visible",
    "[data-testid*='location'] [role='option']",
  ];

  const itemsLocator = page.locator(suggestionSelectors.join(", "));

  let chose = false;
  const deadline = Date.now() + 3_500;
  while (Date.now() < deadline && !chose) {
    const count = await itemsLocator.count().catch(() => 0);
    if (count > 0) {
      notes.push(`suggestions visible: ${count}`);
      const lower = text.toLowerCase();
      // Prefer a row that contains the typed city token.
      let pickIndex = 0;
      for (let i = 0; i < Math.min(count, 12); i++) {
        const t = ((await itemsLocator.nth(i).innerText().catch(() => "")) ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!t) continue;
        const cityToken = lower.split(/[,\s]+/)[0] ?? lower;
        if (t.includes(cityToken) || cityToken.length >= 4 && t.includes(cityToken.slice(0, 4))) {
          pickIndex = i;
          notes.push(`matched suggestion index ${i}: ${t.slice(0, 80)}`);
          break;
        }
      }
      if (pickIndex === 0 && count > 0) {
        notes.push("no city-token match — clicking first suggestion");
      }
      try {
        await itemsLocator.nth(pickIndex).click({ timeout: 2_000 });
        chose = true;
        notes.push(`clicked suggestion index ${pickIndex}`);
      } catch (err) {
        notes.push(
          `click suggestion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      break;
    }
    await page.waitForTimeout(150);
  }

  if (!chose) {
    // Keyboard commit: first highlighted option (standard autocomplete contract).
    notes.push("no clickable suggestion list within timeout — ArrowDown+Enter");
    await loc.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("Enter");
    chose = true;
    notes.push("keyboard ArrowDown+Enter");
  }

  await page.waitForTimeout(200);
  await loc.evaluate(
    (el: {
      dispatchEvent: (e: Event) => void;
      getAttribute: (n: string) => string | null;
      textContent: string | null;
      closest: (s: string) => {
        querySelector: (s: string) => { textContent: string | null } | null;
      } | null;
      parentElement: {
        querySelector: (s: string) => { textContent: string | null } | null;
      } | null;
    }) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
  );

  let readBack = (await loc.inputValue().catch(() => "")).trim();
  // Some Lever UIs put the committed value in a nearby selected label.
  if (!readBack) {
    readBack = (
      await loc.evaluate(
        (el: {
          getAttribute: (n: string) => string | null;
          textContent: string | null;
          closest: (s: string) => {
            querySelector: (s: string) => { textContent: string | null } | null;
          } | null;
          parentElement: {
            querySelector: (s: string) => { textContent: string | null } | null;
          } | null;
        }) => {
          const root =
            el.closest(".application-field") ??
            el.closest("label") ??
            el.parentElement;
          const selected =
            root?.querySelector?.("[class*='selected']") ??
            root?.querySelector?.("[data-selected]");
          return (
            (selected?.textContent ??
              el.getAttribute("value") ??
              el.textContent ??
              "")
              .replace(/\s+/g, " ")
              .trim()
          );
        },
      ).catch(() => "")
    ).trim();
  }

  if (!readBack) {
    // Final keyboard Tab often forces commit in Google Places.
    await loc.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    readBack = (await loc.inputValue().catch(() => "")).trim();
  }

  if (!readBack) {
    notes.push("location still empty after suggestion pick — will fail verify");
    throw new Error(
      `location autocomplete did not commit (typed "${text}"; tried click-first + ArrowDown/Enter). ${notes.join("; ")}`,
    );
  }

  // Blur-stability check — the live METR run reported "committed" here yet
  // verify later read an EMPTY field: Places-style widgets silently clear
  // typed-but-unselected text when focus leaves. Verify happens after
  // blur, so blur NOW and confirm the value survives; if it clears, one
  // bounded retry with the bare city token (shorter queries surface the
  // suggestion list more reliably), else fail loudly at fill time where
  // the retry is still possible.
  await loc.blur().catch(() => undefined);
  await page.waitForTimeout(300);
  let postBlur = (await loc.inputValue().catch(() => "")).trim();
  if (!postBlur) {
    notes.push("location cleared on blur — retrying with city token only");
    const cityToken = text.split(/[,]/)[0]?.trim() || text;
    await loc.click({ timeout: 5_000 });
    await loc.fill("");
    await loc.pressSequentially(cityToken, { delay: 60 });
    await page.waitForTimeout(700);
    const retryItems = page.locator(suggestionSelectors.join(", "));
    const retryCount = await retryItems.count().catch(() => 0);
    if (retryCount > 0) {
      await retryItems
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      notes.push(`retry: clicked first of ${retryCount} suggestions`);
    } else {
      await loc.focus();
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
      notes.push("retry: keyboard ArrowDown+Enter");
    }
    await loc.blur().catch(() => undefined);
    await page.waitForTimeout(300);
    postBlur = (await loc.inputValue().catch(() => "")).trim();
    if (!postBlur) {
      notes.push("location still empty after blur-stable retry");
      throw new Error(
        `location autocomplete cleared on blur and the retry did not commit (typed "${text}"). ${notes.join("; ")}`,
      );
    }
  }

  notes.push(`location committed (blur-stable): ${postBlur.slice(0, 120)}`);
  return { notes };
}

/** Digits only; used so ITI formatting ("(555) 123-4567") can match raw profile. */
function phoneDigits(s: string): string {
  return s.replace(/\D/g, "");
}

function phonesMatch(expected: string, observed: string): boolean {
  const e = phoneDigits(expected);
  const o = phoneDigits(observed);
  // Require a real national number fragment; refuse short codes / empty.
  if (e.length < 7 || o.length < 7) return false;
  return e === o || e.endsWith(o) || o.endsWith(e);
}

/**
 * Country name from profile vs job-boards collapse to dial-only ("+1").
 * +1 is shared by several countries — only accept US primary names for +1,
 * and unambiguous single-country dials for the rest. Never invent Canada→US.
 */
function countryDialCompatible(expected: string, observed: string): boolean {
  const dial = observed.trim();
  if (!/^\+\d{1,4}$/.test(dial)) return false;
  const name = expected
    .replace(/\s*\+\d+\s*$/u, "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "");
  if (name.length < 2) return false;

  // Unambiguous dials (single primary country on common GH job boards).
  const UNIQUE: Record<string, string[]> = {
    "+44": ["united kingdom", "uk", "great britain", "england"],
    "+91": ["india"],
    "+61": ["australia"],
    "+81": ["japan"],
    "+49": ["germany"],
    "+33": ["france"],
    "+86": ["china"],
    "+52": ["mexico"],
  };
  const unique = UNIQUE[dial];
  if (unique) {
    return unique.some((n) => name === n || name.includes(n) || n.includes(name));
  }

  // +1: US board defaults are almost always "United States +1". Canada is
  // also +1 — only accept explicit US wording, never bare "North America".
  if (dial === "+1") {
    return (
      name === "united states" ||
      name === "united states of america" ||
      name === "usa" ||
      name === "us" ||
      name.startsWith("united states")
    );
  }
  return false;
}

/**
 * #101 (live tiaa): Workday date widgets are a `dateInputWrapper` group of
 * Month/Day/Year spinbutton inputs (`<wrapperId>-dateSectionMonth-input`…).
 * Discovery collapses the trio into one field; the fill writes each
 * section with focus+keyboard (mouse clicks are swallowed on the widget).
 */
const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function parseDateParts(
  v: unknown,
): { month: number; day: number | null; year: number } | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  // "May 2029" / "May 15, 2029" / "may 1st 2029"
  let m = s.match(/^([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+)?(\d{4})$/);
  if (m) {
    const name = m[1]!.toLowerCase();
    const month =
      MONTH_NAMES[name] ??
      Object.entries(MONTH_NAMES).find(([k]) => k.startsWith(name.slice(0, 3)))?.[1] ??
      null;
    if (!month) return null;
    return { month, day: m[2] ? Number(m[2]) : null, year: Number(m[3]) };
  }
  // "05/2029", "05/01/2029"
  m = s.match(/^(\d{1,2})\/(?:(\d{1,2})\/)?(\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    if (month < 1 || month > 12) return null;
    return { month, day: m[2] ? Number(m[2]) : null, year: Number(m[3]) };
  }
  // "2029-05", "2029-05-01"
  m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { month, day: m[3] ? Number(m[3]) : null, year: Number(m[1]) };
  }
  return null;
}

async function workdayDateWrapperId(loc: Locator): Promise<string | null> {
  return loc
    .evaluate(
      (el: {
        id?: string;
        getAttribute: (n: string) => string | null;
        closest: (s: string) => { id?: string } | null;
      }) => {
        if (el.getAttribute("data-automation-id") === "dateInputWrapper") {
          return el.id ?? null;
        }
        return el.closest("[data-automation-id='dateInputWrapper']")?.id ?? null;
      },
    )
    .catch(() => null);
}

async function readWorkdayDateSections(
  page: Page,
  wrapperId: string,
): Promise<{ month: number | null; day: number | null; year: number | null } | null> {
  const read = async (part: string): Promise<number | null> => {
    const sec = page
      .locator(`[id="${wrapperId.replace(/"/g, '\\"')}-dateSection${part}-input"]`)
      .first();
    if ((await sec.count().catch(() => 0)) === 0) return null;
    const raw =
      (await sec.inputValue().catch(() => "")) ||
      ((await sec.getAttribute("aria-valuetext").catch(() => null)) ?? "");
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const [month, day, year] = [await read("Month"), await read("Day"), await read("Year")];
  if (month === null && day === null && year === null) return null;
  return { month, day, year };
}

async function fillWorkdayDateSections(
  page: Page,
  wrapperId: string,
  value: unknown,
): Promise<string[]> {
  const notes: string[] = [];
  const parts = parseDateParts(value);
  if (!parts) {
    throw new Error(
      `date widget: cannot parse "${String(value).slice(0, 40)}" into month/year — refusing to type into spinbuttons`,
    );
  }
  const write = async (part: string, num: number, width: number): Promise<boolean> => {
    const sec = page
      .locator(`[id="${wrapperId.replace(/"/g, '\\"')}-dateSection${part}-input"]`)
      .first();
    if ((await sec.count().catch(() => 0)) === 0) return false;
    // Mouse clicks are swallowed on this widget (live: 5s click timeouts
    // every pass) — focus + keyboard is the write path.
    await sec.evaluate((el: { focus: () => void }) => el.focus()).catch(() => undefined);
    await page.keyboard.type(String(num).padStart(width, "0"), { delay: 60 });
    await page.waitForTimeout(150);
    return true;
  };
  if (!(await write("Month", parts.month, 2))) {
    throw new Error("date widget: Month section not found");
  }
  const daySection =
    (await page
      .locator(`[id="${wrapperId.replace(/"/g, '\\"')}-dateSectionDay-input"]`)
      .count()
      .catch(() => 0)) > 0;
  if (daySection) {
    const day = parts.day ?? 1;
    if (parts.day === null) {
      notes.push("date widget: day not on file — 01 (month-precision answer)");
    }
    await write("Day", day, 2);
  }
  if (!(await write("Year", parts.year, 4))) {
    throw new Error("date widget: Year section not found");
  }
  const back = await readWorkdayDateSections(page, wrapperId);
  notes.push(
    `date widget wrote ${String(parts.month).padStart(2, "0")}/${String(parts.day ?? 1).padStart(2, "0")}/${parts.year}; read back ${back ? `${back.month ?? "?"}/${back.day ?? "?"}/${back.year ?? "?"}` : "(empty)"}`,
  );
  return notes;
}

function valuesMatch(
  expected: unknown,
  observed: unknown,
  canonical?: string | null,
): boolean {
  if (expected === observed) return true;
  const eRaw = String(expected ?? "").trim();
  const oRaw = String(observed ?? "").trim();
  if (eRaw === "" || oRaw === "") return eRaw === oRaw && eRaw !== "";
  const e = eRaw.toLowerCase();
  const o = oRaw.toLowerCase();
  if (e === o) return true;
  if (e === "yes" && ["yes", "y", "true", "1"].includes(o)) return true;
  if (e === "no" && ["no", "n", "false", "0"].includes(o)) return true;
  // Combobox displays may be truncated / dial-code-only ("United States" → "+1")
  // or taxonomy-shifted ("Bachelor of Science" → "Bachelor's Degree").
  if (labelsCompatible(eRaw, oRaw)) return true;
  if (labelsCompatible(oRaw, eRaw)) return true;
  if (pickOptionLabel([oRaw], eRaw).ok) return true;
  // #101: "May 2029" (bank) ↔ "05/01/2029" (date-widget sections). A
  // month-precision expectation accepts any day; mismatched month/year
  // never match.
  {
    const eD = parseDateParts(eRaw);
    const oD = parseDateParts(oRaw);
    if (
      eD &&
      oD &&
      eD.year === oD.year &&
      eD.month === oD.month &&
      (eD.day === null || oD.day === null || eD.day === oD.day)
    ) {
      return true;
    }
  }
  // Multi-select readback "Man, Woman" vs expected "Man": require exclusive match.
  if (oRaw.includes(",")) {
    const parts = oRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (
      parts.length > 0 &&
      parts.every(
        (p) =>
          labelsCompatible(eRaw, p) ||
          pickOptionLabel([p], eRaw).ok ||
          phonesMatch(eRaw, p),
      )
    ) {
      return true;
    }
  }
  // "United States" (profile) vs "+1" (collapsed country control).
  if (countryDialCompatible(eRaw, oRaw) || countryDialCompatible(oRaw, eRaw)) {
    return true;
  }
  // ITI phone formatting vs profile digits.
  if (phonesMatch(eRaw, oRaw)) return true;
  // Places commit "Baltimore, MD, USA" vs plan "Baltimore" / "Baltimore,
  // Maryland, USA". ONLY for location fields — the city-token containment
  // inside locationsMatch is far too loose for arbitrary values and would
  // quietly weaken the pre-click verify gate everywhere else.
  if (
    canonical === "address.city" &&
    (locationsMatch(eRaw, oRaw) || locationsMatch(oRaw, eRaw))
  ) {
    return true;
  }
  return false;
}

/**
 * #147: the evidence line for a control that resolved but never painted.
 * Says WHICH rung matched it and what the DOM element actually is, so a
 * "hidden control — skipped fast" note can be read back without a rerun.
 * Read-only and never throws: a diagnostic must not fail a fill.
 */
async function describeHiddenResolution(
  loc: Locator,
  idArgs: { field_id: string; label: string; name?: string; inputId?: string },
  type: string,
): Promise<string> {
  const rung = idArgs.inputId
    ? `id=${idArgs.inputId}`
    : idArgs.name
      ? `name=${idArgs.name}`
      : `label="${idArgs.label.slice(0, 40)}"`;
  const shape = await loc
    .first()
    .evaluate(
      (el: {
        tagName: string;
        type?: string;
        closest: (s: string) => unknown;
      }) => {
        const style = (
          globalThis as unknown as {
            getComputedStyle?: (n: unknown) => {
              display: string;
              visibility: string;
            };
          }
        ).getComputedStyle?.(el);
        return {
          tag: el.tagName.toLowerCase(),
          type: typeof el.type === "string" ? el.type : "",
          display: style?.display ?? "",
          visibility: style?.visibility ?? "",
          // An unopened editor hides the ANCESTOR, not the control itself.
          hiddenAncestor: el.closest("[hidden], [aria-hidden='true']") != null,
        };
      },
    )
    .catch(() => null);
  const count = await loc.count().catch(() => -1);
  if (!shape) {
    return `resolved by ${rung} (planned ${type}), ${count} match(es); DOM shape unreadable`;
  }
  return (
    `resolved by ${rung} (planned ${type}), ${count} match(es): ` +
    `<${shape.tag}${shape.type ? ` type=${shape.type}` : ""}> ` +
    `display=${shape.display} visibility=${shape.visibility}` +
    (shape.hiddenAncestor ? " inside a hidden ancestor" : "")
  );
}

function isApprovedExecutable(
  entry: ExecutableFillEntry,
): entry is ApprovedFillPlanEntry & { approved: true; action: "FILL" } {
  return (
    "approved" in entry &&
    entry.approved === true &&
    entry.action === "FILL"
  );
}

/** Bare profile year against a seasonal combobox needs the month. */
/**
 * #68 (live tiaa 2026-08-31): "How did you hear about us?" lists often
 * offer channel CLASSES, not brands — the operator's stored "LinkedIn"
 * matched none of TIAA's options (College Event | … | Job Board | …).
 * Deterministic class fallbacks, scoped to how_heard only, tried in
 * order and still option-verified against the page's own list. Nothing
 * here invents an answer: LinkedIn IS social media / a job board.
 */
export function comboboxAlternates(
  canonical: string | null,
  value: unknown,
): string[] {
  if (canonical !== "how_heard") return [];
  const key = String(value ?? "").trim().toLowerCase();
  const table: Record<string, string[]> = {
    // #225 (live Leidos 2026-09-09: 13 real options harvested, none of
    // them LinkedIn or any class below). Operator: "first try searching
    // LinkedIn. if it doesn't show, then just click on job board." All of
    // these are truthful for a posting found through a job board — the
    // list is ordered most to least specific.
    linkedin: [
      "LinkedIn.com",
      "Social Media",
      "Social Network",
      "Professional Network",
      "Job Board",
      "Job Boards",
      "Online Job Board",
      "Internet Job Board",
      "Job Search Website",
      "Online Job Posting",
      "Online Search",
      "Internet Search",
      "Search Engine",
      "Internet",
      "Online",
    ],
    indeed: ["Job Board", "Online Job Board"],
    jobright: ["Job Board", "Online Job Board"],
    handshake: ["Job Board", "Online Job Board", "College Event"],
  };
  return table[key] ?? [];
}

export function comboboxExpected(
  canonical: string | null,
  value: unknown,
  profileForTest?: { address?: { state?: string; country?: string } },
): unknown {
  if (canonical === "address.city") {
    // Places typeaheads need state context to name ONE city. Live
    // 2026-08-28 (Databricks ×4): plan "Baltimore" alone stayed ambiguous
    // across doubled rows / New Baltimore / Baltimore Highlands (and any
    // international namesake past the note's 5-entry cap). The profile owns
    // state+country — compose the comma shape the multi-part location
    // matcher resolves by exact parts. Verify already accepts either shape
    // for address.city (locationsMatch both directions).
    const city = String(value ?? "").trim();
    if (!city || city.includes(",")) return value;
    try {
      const addr = profileForTest?.address ?? loadPublicProfile().address;
      const state = addr?.state?.trim();
      const country = addr?.country?.trim();
      if (state) {
        return [city, state, ...(country ? [country] : [])].join(", ");
      }
    } catch {
      return value;
    }
    return value;
  }
  if (canonical !== "graduation_year") return value;
  const raw = String(value ?? "").trim();
  if (!/^(20\d{2}|19\d{2})$/.test(raw)) return value;
  try {
    const month = loadPublicProfile().graduation_month?.trim() ?? "";
    if (month && !/\d{4}/.test(month)) return `${month} ${raw}`;
  } catch {
    return value;
  }
  return value;
}

/**
 * Fill Greenhouse fields from an approved fill plan.
 * Rejects essay/textarea/demographic/unapproved entries even if present.
 * Call assertFormFillAllowed first. Does not click submit.
 */
export async function greenhouseFillFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
  opts: {
    /**
     * #88 (live stryker, deterministic): Workday text values written via
     * fill() can pass EVERY read-back (immediate, blur, 1.5s settle) and
     * still vanish at the next server sync — React state never took the
     * programmatic value. The paced diagnostic proved real keystrokes
     * stick. Workday passes true; short values type at keystroke level.
     */
    keystrokeText?: boolean;
  } = {},
): Promise<FillResult> {
  assertFormFillAllowed("greenhouse.fill");
  const filled: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const field_meta: FieldFillMeta[] = [];

  const deduped = dedupeAnchorlessCanonicalTwins(entries, fieldMeta);
  for (const ghost of deduped.dropped) {
    skipped.push(`${ghost} — anchorless twin of an anchored canonical (#69)`);
  }

  for (const entry of deduped.entries) {
    if (!isApprovedExecutable(entry)) {
      if (
        entry.action === "fill" ||
        entry.action === "FILL" ||
        ("approved" in entry && entry.approved)
      ) {
        errors.push(
          `${entry.field_id}: rejected — entry is not an approved FILL action`,
        );
      } else {
        skipped.push(entry.field_id);
      }
      continue;
    }

    try {
      assertExecutableApprovedEntry(entry);
      // Demographics only when approved via sensitive-profile values
      // (assertExecutableApprovedEntry already gates the allowlist).
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const meta = fieldMeta.get(entry.field_id);
    try {
      const type = meta?.type ?? entry.type;
      const idArgs = {
        field_id: entry.field_id,
        label: entry.label,
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      };
      // Reachability before mutation, with a bounded ladder instead of a
      // 30s hang (#61 adds the visible-first rung): VISIBLE type-filtered
      // → type-filtered → unfiltered; still nothing ⇒ an INSTANT named
      // error. Live f_28 burned 30s waiting on a label that was never
      // going to appear; live tiaa "Phone" burned 30s on a HIDDEN decoy.
      let loc = locatorForField(page, idArgs, type, { visibleOnly: true });
      if ((await loc.count()) === 0) {
        loc = locatorForField(page, idArgs, type);
      }
      if ((await loc.count()) === 0) {
        const unfiltered = locatorForField(page, idArgs);
        if ((await unfiltered.count()) === 0) {
          // #63b (live tiaa #22h): Workday regenerates its short random
          // ids on every re-render, so a discovery-time id can be DEAD by
          // fill time. Drop id/name and run the label tiers before failing.
          const labelOnly = { field_id: entry.field_id, label: entry.label };
          let byLabel = locatorForField(page, labelOnly, type, { visibleOnly: true });
          if ((await byLabel.count()) === 0) {
            byLabel = locatorForField(page, labelOnly, type);
          }
          if ((await byLabel.count()) === 0) {
            byLabel = locatorForField(page, labelOnly);
          }
          if ((await byLabel.count()) === 0) {
            // #78 (live exa #cycle-1): an option-typed question can be an
            // Ashby-style RADIO fieldset — hidden inputs behind painted
            // circles, no select control anywhere, and the question text
            // lives in the fieldset, not a label[for]. When a fieldset
            // matching the question holds radios, pick the member
            // painted-safe (same matching + refusals as the radio branch).
            if (type === "select" && typeof entry.value === "string") {
              const fieldset = page
                .locator("fieldset")
                .filter({ hasText: entry.label.slice(0, 60) })
                .first();
              const radios = fieldset.locator("input[type='radio']");
              if ((await radios.count().catch(() => 0)) > 0) {
                const picked = await checkRadioGroupMember(page, radios, entry.value);
                field_meta.push({
                  field_id: entry.field_id,
                  canonical_field: entry.canonical_field,
                  control_kind: "button_group",
                  selected_option: picked,
                });
                filled.push(entry.canonical_field ?? entry.field_id);
                continue;
              }
            }
            // #112 last rung: Gem-style caption span → first following control.
            const byCaption = captionFollowControl(page, entry.label);
            if ((await byCaption.count().catch(() => 0)) === 0) {
              throw new Error(
                `control not found on the page (label "${entry.label.slice(0, 60)}") — failing fast instead of waiting 30s`,
              );
            }
            byLabel = byCaption;
          }
          loc = byLabel;
        } else {
          loc = unfiltered;
        }
      }
      if (type !== "checkbox" && type !== "radio" && type !== "file") {
        // #147 (live UKG run 16 → #145c): a control that exists but is NOT
        // painted (collapsed section, unopened section editor, hidden
        // wizard step) makes fill()/selectOption() burn their full
        // timeout each — eight hidden address/phone inputs cost 4 minutes
        // and the app deadline. id/name tiers resolve hidden controls
        // exactly (no visible filter), so probe here after resolution:
        // give a late mount 1.5s, then skip with the real reason. The
        // section/editor walks re-plan the page once the controls are
        // painted. Painted-invisible checkbox/radio inputs keep their
        // JS-click path — judged by the RESOLVED element's type (a plan
        // typed 'text' can still land on a Workday radio member).
        const resolvedBox = await loc
          .first()
          .evaluate((el: { type?: string }) =>
            el.type === "radio" || el.type === "checkbox" || el.type === "file",
          )
          .catch(() => false);
        const paintedSoon =
          resolvedBox ||
          (await loc
            .first()
            .waitFor({ state: "visible", timeout: 1_500 })
            .then(() => true, () => false));
        if (!paintedSoon) {
          skipped.push(
            `${entry.field_id} — control is not visible (collapsed section or unopened editor)`,
          );
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "text",
            notes: [
              "hidden control — skipped fast, not filled",
              await describeHiddenResolution(loc, idArgs, type),
            ],
          });
          continue;
        }
      }
      if (type === "select" && Array.isArray(entry.value)) {
        // #73 (operator directive): multi-VALUE pickers — Workday Skills.
        // Each value is picked option-verified; values the taxonomy does
        // not offer are named, never invented. At least one must land.
        const items = (entry.value as unknown[])
          .map((v) => String(v))
          .filter((s) => s.trim() !== "")
          .slice(0, 10);
        const picked: string[] = [];
        const misses: string[] = [];
        for (const item of items) {
          const r = await fillComboboxControl(page, loc, item, {
            preserveExistingChips: true,
          });
          if (r.committed) picked.push(r.selectedLabel ?? item);
          else misses.push(item);
        }
        field_meta.push({
          field_id: entry.field_id,
          canonical_field: entry.canonical_field,
          control_kind: "multiselect",
          selected_option: picked.join("; ") || null,
          notes:
            misses.length > 0
              ? [`not offered by the page: ${misses.slice(0, 8).join(", ")}`]
              : [],
        });
        if (picked.length === 0) {
          throw new Error(
            `multiselect: none of ${items.length} planned values matched the page's options`,
          );
        }
      } else if (type === "select") {
        // Offline discovery types both native selects and React-select
        // comboboxes as "select"; only the live element tells them apart.
        const kind = await detectControlKind(loc);
        if (kind === "native_select") {
          await setSelectByValueOrLabel(loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "native_select",
            selected_option: String(entry.value),
            match_via: "exact",
          });
        } else {
          const result = await fillComboboxControl(
            page,
            loc,
            comboboxExpected(entry.canonical_field, entry.value),
            {
              alternates: comboboxAlternates(entry.canonical_field, entry.value),
              // #223: a planned answer that is not on the OPEN list takes
              // the form's own "Other", with the intended answer typed in
              // the specify box. Never for demographics/EEO — a wrong
              // guess there puts words in the candidate's mouth.
              allowOtherFallback: !isDemographicsField({
                id: entry.field_id,
                label: entry.label ?? "",
                type: "text",
                required: false,
              }),
              otherSpecifyValue: String(entry.value),
              // #225 (operator directive 2026-09-09): how-did-you-hear is
              // an irrelevant question that must never block a submit.
              // When neither the stored answer, the class alternates, nor
              // the form's "Other" is on the list, take the first real
              // option. Scoped to THIS canonical field only.
              lastResortFirstOption: entry.canonical_field === "how_heard",
            },
          );
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "combobox",
            selected_option: result.selectedLabel,
            match_via: result.pickVia ?? null,
            notes: result.notes,
            ...(result.optionsSample
              ? { options_sample: result.optionsSample }
              : {}),
          });
          if (!result.committed) {
            throw new Error(
              `combobox option not committed: ${result.notes.join("; ")}`,
            );
          }
        }
      } else if (type === "checkbox") {
        // A MULTI-member group takes the option path even for Yes/No: on
        // neuralink's "Are you currently authorized…?" [Yes | No] group a
        // consent-style "No" would have UNCHECKED the first box instead of
        // checking the "No" member. Only a lone box reads Yes/No as its state.
        const doCheckbox = async (box: Locator): Promise<void> => {
          const groupOptions = await collectCheckboxGroupOptions(box).catch(() => []);
          const multiMember = groupOptions.length > 1;
          if (isCheckboxBooleanValue(entry.value) && !multiMember) {
            // Consent-style: the plan speaks about THIS box's state.
            const s = String(entry.value).trim().toLowerCase();
            const on =
              typeof entry.value === "boolean"
                ? entry.value
                : !["false", "no", "off", "0"].includes(s);
            if (on) await checkPaintedControl(page, box);
            else await box.uncheck();
            field_meta.push({
              field_id: entry.field_id,
              canonical_field: entry.canonical_field,
              control_kind: "text",
            });
          } else {
            // Option-labeled answer on a checkbox control (issue #21/#10:
            // export-control "United States", veteran "I am not a veteran"
            // were blind-checked as `true`). Pick the group member whose
            // label matches the planned text; no match ⇒ named refusal,
            // never a blind check.
            const options =
              groupOptions.length > 0 ? groupOptions : await collectCheckboxGroupOptions(box);
            const pick = pickOptionLabel(
              options.map((o) => o.label),
              String(entry.value),
            );
            const target = pick.ok
              ? options.find((o) => o.label === pick.label)
              : undefined;
            if (!target || !target.id) {
              throw new Error(
                `checkbox group has no option matching "${entry.value}"` +
                  (options.length > 0
                    ? ` (options: ${options
                        .map((o) => o.label)
                        .slice(0, 8)
                        .join(", ")})`
                    : " (no labeled group found around the control)"),
              );
            }
            const escapedId = target.id
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"');
            await checkPaintedControl(page, page.locator(`[id="${escapedId}"]`).first());
            field_meta.push({
              field_id: entry.field_id,
              canonical_field: entry.canonical_field,
              control_kind: "checkbox_group",
              selected_option: target.label,
            });
          }
        };
        try {
          await doCheckbox(loc);
        } catch (err) {
          // #63b: a mid-fill re-render can detach an id-resolved box
          // between resolution and the check (live tiaa: the opt-ins
          // render last; earlier fills re-render their section). ONE
          // bounded retry through label resolution — same body, same
          // refusals, and the read-back still arbitrates.
          const staleShaped = /timeout|not visible|detached|stale generated id/i.test(
            err instanceof Error ? err.message : String(err),
          );
          if (!staleShaped || (!meta?.inputId && !meta?.name)) throw err;
          const fresh = locatorForField(
            page,
            { field_id: entry.field_id, label: entry.label },
            "checkbox",
          );
          if ((await fresh.count()) === 0) throw err;
          await doCheckbox(fresh);
        }
      } else if (type === "radio") {
        const name = meta?.name;
        const group = name
          ? page.locator(`[name="${name.replace(/"/g, '\\"')}"]`)
          : page.locator('input[type="radio"]');
        const picked = await checkRadioGroupMember(page, group, entry.value);
        field_meta.push({
          field_id: entry.field_id,
          canonical_field: entry.canonical_field,
          control_kind: "text",
          selected_option: picked,
        });
      } else {
        // Text-typed entries can still be combobox inner inputs live
        // (discovery saw <input>, the widget is a React-select).
        const kind = await detectControlKind(loc);
        if (kind === "combobox") {
          const result = await fillComboboxControl(
            page,
            loc,
            comboboxExpected(entry.canonical_field, entry.value),
            {
              alternates: comboboxAlternates(entry.canonical_field, entry.value),
              // #223: a planned answer that is not on the OPEN list takes
              // the form's own "Other", with the intended answer typed in
              // the specify box. Never for demographics/EEO — a wrong
              // guess there puts words in the candidate's mouth.
              allowOtherFallback: !isDemographicsField({
                id: entry.field_id,
                label: entry.label ?? "",
                type: "text",
                required: false,
              }),
              otherSpecifyValue: String(entry.value),
              // #225 (operator directive 2026-09-09): how-did-you-hear is
              // an irrelevant question that must never block a submit.
              // When neither the stored answer, the class alternates, nor
              // the form's "Other" is on the list, take the first real
              // option. Scoped to THIS canonical field only.
              lastResortFirstOption: entry.canonical_field === "how_heard",
            },
          );
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "combobox",
            selected_option: result.selectedLabel,
            match_via: result.pickVia ?? null,
            notes: result.notes,
            ...(result.optionsSample
              ? { options_sample: result.optionsSample }
              : {}),
          });
          if (!result.committed) {
            const noList = result.notes.some((n) =>
              n.includes("listbox did not open after click"),
            );
            // Places-style address inputs advertise combobox but the list
            // only appears after typing (Paylocity Address Line 1). Don't
            // refuse a street we can type.
            if (noList) {
              await loc.fill(String(entry.value));
              field_meta[field_meta.length - 1] = {
                field_id: entry.field_id,
                canonical_field: entry.canonical_field,
                control_kind: "text",
                notes: [...result.notes, "fell back to text fill — no listbox"],
              };
            } else {
              throw new Error(
                `combobox option not committed: ${result.notes.join("; ")}`,
              );
            }
          }
        } else if (kind === "native_select") {
          await setSelectByValueOrLabel(loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "native_select",
            selected_option: String(entry.value),
            match_via: "exact",
          });
        } else {
          if (
            isLocationStyleField({
              field_id: entry.field_id,
              label: entry.label,
              canonical_field: entry.canonical_field,
              ...(meta?.name ? { name: meta.name } : {}),
              ...(meta?.inputId ? { inputId: meta.inputId } : {}),
            })
          ) {
            // Operator directive (2026-08-31, resumed drafts like tiaa):
            // a field already holding a value verify would accept is
            // VERIFIED IN PLACE, never retyped — rewriting a correct
            // value risks the re-render wipe classes (#63f/#65) and
            // burns walk time on recurrent applications.
            const preLoc = (await loc.inputValue().catch(() => null))?.trim() ?? "";
            if (preLoc !== "" && valuesMatch(entry.value, preLoc, entry.canonical_field)) {
              field_meta.push({
                field_id: entry.field_id,
                canonical_field: entry.canonical_field,
                control_kind: "text",
                notes: [
                  `already holds "${preLoc.slice(0, 40)}" — verified in place, not retyped`,
                ],
              });
            } else {
              const locFill = await fillLocationStyleText(page, loc, entry.value);
              field_meta.push({
                field_id: entry.field_id,
                canonical_field: entry.canonical_field,
                control_kind: "text",
                notes: locFill.notes,
              });
            }
          } else {
            // Live tiaa.wd1 2026-08-30 (#61): discovery typed the
            // previousWorker RADIO group "text"; the unfiltered ladder
            // rung resolved a member radio and fill("No") crashed. A
            // radio is an option CHOICE whatever the plan called it —
            // route it through the same member-matching the radio branch
            // uses; no matching member parks with the real reason.
            const resolvedType = await loc
              .evaluate(
                (el: {
                  tagName: string;
                  getAttribute: (n: string) => string | null;
                }) =>
                  el.tagName.toLowerCase() === "input"
                    ? (el.getAttribute("type") ?? "text").toLowerCase()
                    : el.tagName.toLowerCase(),
              )
              .catch(() => "text");
            if (resolvedType === "radio") {
              const groupName = await loc.getAttribute("name");
              const group = groupName
                ? page.locator(
                    `input[type="radio"][name="${groupName.replace(/"/g, '\\"')}"]`,
                  )
                : loc;
              const picked = await checkRadioGroupMember(page, group, entry.value);
              field_meta.push({
                field_id: entry.field_id,
                canonical_field: entry.canonical_field,
                control_kind: "text",
                selected_option: picked,
              });
            } else {
              // #101: a Workday date widget takes the section-wise write —
              // never prose into a spinbutton. Already-correct sections
              // are verified in place (resumed drafts).
              const dateWrapper = await workdayDateWrapperId(loc);
              if (dateWrapper) {
                const want = parseDateParts(entry.value);
                const have = await readWorkdayDateSections(page, dateWrapper);
                if (
                  want &&
                  have &&
                  have.year === want.year &&
                  have.month === want.month &&
                  (want.day === null || have.day === null || have.day === want.day)
                ) {
                  field_meta.push({
                    field_id: entry.field_id,
                    canonical_field: entry.canonical_field,
                    control_kind: "text",
                    notes: ["date widget already holds the planned date — verified in place"],
                  });
                } else {
                  const dNotes = await fillWorkdayDateSections(page, dateWrapper, entry.value);
                  field_meta.push({
                    field_id: entry.field_id,
                    canonical_field: entry.canonical_field,
                    control_kind: "text",
                    notes: dNotes,
                  });
                }
                filled.push(entry.canonical_field ?? entry.field_id);
                continue;
              }
              let v = String(entry.value);
              if (await loc.and(page.locator(DATE_INPUT_SELECTOR)).count()) {
                const parts = parseDateParts(entry.value);
                if (!parts?.month) throw new Error("date input requires an approved month and year");
                // Datepicker masks force day granularity; when only
                // month+year were approved, day-01 is the forced-format
                // convention — verify's comparator asserts month+year
                // only, so the fabricated day is never treated as a fact.
                v = `${String(parts.month).padStart(2, "0")}/${String(parts.day ?? 1).padStart(2, "0")}/${parts.year}`;
              }
              // Same verify-in-place rule as the location branch: a
              // resumed draft's already-correct value is never retyped
              // (strictly: skip only when verify's own comparator would
              // pass it; anything else refills exactly as before).
              const pre = (await loc.inputValue().catch(() => null))?.trim() ?? "";
              if (pre !== "" && valuesMatch(entry.value, pre, entry.canonical_field)) {
                field_meta.push({
                  field_id: entry.field_id,
                  canonical_field: entry.canonical_field,
                  control_kind: "text",
                  notes: [
                    `already holds "${pre.slice(0, 40)}" — verified in place, not retyped`,
                  ],
                });
                filled.push(entry.canonical_field ?? entry.field_id);
                continue;
              }
              // #146 (live UKG run 15): PreferredName/FormerName are
              // readonly BY DESIGN (account-owned names; the page says
              // change them on "My presence") — fill() on a readonly
              // control burns its full 30s timeout. Skip fast with the
              // real reason instead.
              const lockedShaped = await loc
                .evaluate(
                  (el: {
                    readOnly?: boolean;
                    disabled?: boolean;
                    getAttribute: (n: string) => string | null;
                  }) =>
                    el.readOnly === true ||
                    el.disabled === true ||
                    el.getAttribute("aria-readonly") === "true",
                )
                .catch(() => false);
              if (lockedShaped) {
                skipped.push(
                  `${entry.field_id} — control is readonly/disabled (page-owned value)`,
                );
                field_meta.push({
                  field_id: entry.field_id,
                  canonical_field: entry.canonical_field,
                  control_kind: "text",
                  notes: ["readonly/disabled — skipped, the page owns this value"],
                });
                continue;
              }
              if (opts.keystrokeText && v.length <= 80 && v.length > 0) {
                // #88: keystroke-level entry — the only write Workday's
                // handlers reliably keep.
                await loc.click({ timeout: 5_000 });
                await loc.fill("");
                await loc.pressSequentially(v, { delay: 25 });
              } else {
                await loc.fill(v);
              }
              // #63f (live tiaa: phone verified "" while every sibling
              // matched): a just-rendered React control can DROP the
              // written value on its next render. Read it back; if it
              // vanished, settle briefly and type once more — verify
              // stays the arbiter.
              const took = await loc.inputValue().catch(() => null);
              if (
                took !== null &&
                took.trim() === "" &&
                String(entry.value).trim() !== ""
              ) {
                await page.waitForTimeout(400);
                await loc.fill(String(entry.value)).catch(() => undefined);
              }
              // #65 (live tiaa #22n, DRAFT probe): the immediate read-back
              // is not enough — the DOM held the phone value but React
              // state never took it, the server draft saved "", and the
              // next re-render wiped the field before verify. Same class
              // the location widget solves with its blur-stability check:
              // blur to force the commit/re-render NOW; if the value
              // clears, one keystroke-level retype (real key events reach
              // the handlers fill() can miss) + blur, then read back.
              if (took !== null && String(entry.value).trim() !== "") {
                await loc.blur().catch(() => undefined);
                await page.waitForTimeout(300);
                const postBlur = (await loc.inputValue().catch(() => "")).trim();
                if (postBlur === "") {
                  await loc.click({ timeout: 5_000 }).catch(() => undefined);
                  await loc
                    .pressSequentially(String(entry.value), { delay: 30 })
                    .catch(() => undefined);
                  await loc.blur().catch(() => undefined);
                  await page.waitForTimeout(300);
                  const retyped = (await loc.inputValue().catch(() => "")).trim();
                  if (retyped === "") {
                    errors.push(
                      `${entry.field_id}: value cleared on blur twice (React state never took it)`,
                    );
                  }
                }
              }
              field_meta.push({
                field_id: entry.field_id,
                canonical_field: entry.canonical_field,
                control_kind: "text",
              });
            }
          }
        }
      }
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { filled, skipped, errors, field_meta };
}

export async function greenhouseReadFieldValue(
  page: Page,
  entry: FillPlanEntry & { name?: string; inputId?: string },
): Promise<unknown> {
  // Same type-aware resolution as the fill side — verify must read the
  // control the fill wrote, not a same-label sibling (live: verify read
  // `true` off the "LinkedIn" checkbox while the URL input sat empty).
  // #61: the visible-first rung mirrors the fill ladder so verify reads
  // the same control the fill chose, never the hidden decoy.
  let loc = locatorForField(page, entry, entry.type, { visibleOnly: true });
  if ((await loc.count()) === 0) {
    loc = locatorForField(page, entry, entry.type);
  }
  if ((await loc.count()) === 0) {
    const unfiltered = locatorForField(page, entry);
    if ((await unfiltered.count()) === 0) {
      // #63b: stale generated id — verify falls back to the label tiers
      // exactly like the fill ladder, so both read the same live control.
      const labelOnly = { field_id: entry.field_id, label: entry.label };
      let byLabel = locatorForField(page, labelOnly, entry.type, { visibleOnly: true });
      if ((await byLabel.count()) === 0) {
        byLabel = locatorForField(page, labelOnly, entry.type);
      }
      if ((await byLabel.count()) === 0) {
        byLabel = locatorForField(page, labelOnly);
      }
      if ((await byLabel.count()) === 0) {
        // #112: same caption rung as the fill ladder — verify must read
        // the control the fill wrote.
        const byCaption = captionFollowControl(page, entry.label);
        if ((await byCaption.count().catch(() => 0)) === 0) {
          throw new Error(
            `control not found on the page (label "${entry.label.slice(0, 60)}") — failing fast instead of waiting 30s`,
          );
        }
        byLabel = byCaption;
      }
      loc = byLabel;
    } else {
      loc = unfiltered;
    }
  }
  // #101: date-widget entries resolve to the wrapper (or descend to a
  // section input) — observed is the joined sections, comparable to the
  // bank's "May 2029" via valuesMatch's date rule.
  const dateWrapper = await workdayDateWrapperId(loc);
  if (dateWrapper) {
    const have = await readWorkdayDateSections(page, dateWrapper);
    if (!have || (have.month === null && have.year === null)) return "";
    const mm = String(have.month ?? 0).padStart(2, "0");
    return have.day === null
      ? `${mm}/${have.year ?? ""}`
      : `${mm}/${String(have.day).padStart(2, "0")}/${have.year ?? ""}`;
  }
  const tag = await loc.evaluate((el: { tagName: string }) =>
    el.tagName.toLowerCase(),
  );
  if (tag === "select") {
    const value = await loc.inputValue();
    const label = await loc.evaluate(
      (el: {
        selectedOptions?: ArrayLike<{ textContent?: string | null }>;
      }) => {
        const opt = el.selectedOptions?.[0];
        return opt?.textContent?.trim() ?? "";
      },
    );
    return { value, label };
  }
  const type = await loc.getAttribute("type");
  if (type === "checkbox") {
    // #236 (live Rocket Lab greenhouse 2026-09-10, three apps): the FILL
    // decides between "this box's state" and "an option label" with
    // `isCheckboxBooleanValue(value) && !multiMember` — a MULTI-member
    // group takes the option path even for Yes/No, so "No" on a [Yes|No]
    // group checks the NO member. The read-back tested only the first
    // half, so it reported `loc.isChecked()` → `true` for a correctly
    // checked "No", verify compared "No" against `true`, and three
    // correctly filled applications parked AMBIGUOUS_FIELD. The two
    // decisions must be the same decision.
    const options = await collectCheckboxGroupOptions(loc);
    if (isCheckboxBooleanValue(entry.value) && options.length <= 1) {
      return loc.isChecked();
    }
    // Option-labeled expectation: report the checked group member's label
    // (radio-style {value,label}) so verify compares text to text, never
    // text to `true` (issue #21).
    const checked = options.filter((o) => o.checked);
    if (checked.length === 0) return { value: "", label: "" };
    const expectedText = String(entry.value);
    const hit =
      checked.find(
        (o) => o.label.toLowerCase() === expectedText.toLowerCase(),
      ) ?? checked[0]!;
    return { value: hit.label, label: hit.label };
  }
  if (type === "radio") {
    const name = await loc.getAttribute("name");
    const group = name
      ? page.locator(
          `input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`,
        )
      : page.locator('input[type="radio"]');
    const n = await group.count();
    for (let i = 0; i < n; i++) {
      const opt = group.nth(i);
      if (!(await opt.isChecked())) continue;
      const value = (await opt.getAttribute("value")) ?? "";
      const attrLabel = (await opt.getAttribute("label")) ?? "";
      const labelText = await opt.evaluate((el: {
        id: string;
        parentElement?: { textContent?: string | null } | null;
      }) => {
        if (el.id) {
          const lab = (
            globalThis as unknown as {
              document?: {
                querySelector: (s: string) => { textContent?: string | null } | null;
              };
            }
          ).document?.querySelector(`label[for="${el.id}"]`);
          if (lab?.textContent) return lab.textContent.trim();
        }
        return el.parentElement?.textContent?.trim() ?? "";
      });
      const label = (attrLabel || labelText || value).replace(/\s+/g, " ").trim();
      return { value, label };
    }
    return { value: "", label: "" };
  }
  // Combobox inner inputs: inputValue() is the transient filter text and
  // LIES about commitment — read the committed display instead, null while
  // the placeholder shows. A half-open menu now verifies false.
  const kind = await detectControlKind(loc);
  if (kind === "combobox") {
    const committed = await readComboboxValue(loc);
    return { value: committed ?? "", label: committed ?? "" };
  }
  return loc.inputValue();
}

/**
 * #69 (live tiaa #22r): discovery can emit an anchorless GHOST twin of a
 * real field — f_13 "Phone" (no id, no name) duplicated canonical
 * `phone` beside the precisely-anchored phoneNumber--phoneNumber. The
 * ghost's fill typed into whatever a bare ambiguous label resolved to,
 * its verify row double-counted the miss, and the #66b retype's locator
 * could never resolve it. When an ANCHORED entry (inputId/name) claims a
 * canonical, anchorless FILL twins of that canonical are dropped.
 */
export function dedupeAnchorlessCanonicalTwins(
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): { entries: ExecutableFillEntry[]; dropped: string[] } {
  const normLabel = (s: string): string =>
    s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  const anchored = new Set<string>();
  const anchoredLabels = new Set<string>();
  for (const e of entries) {
    const m = fieldMeta.get(e.field_id);
    if (
      (e.action === "fill" || e.action === "FILL") &&
      (m?.inputId || m?.name)
    ) {
      if (e.canonical_field) anchored.add(e.canonical_field);
      if (e.label) anchoredLabels.add(normLabel(e.label));
    }
  }
  const dropped: string[] = [];
  const out = entries.filter((e) => {
    const m = fieldMeta.get(e.field_id);
    const anchorless =
      (e.action === "fill" || e.action === "FILL") && !m?.inputId && !m?.name;
    // #85b (live stryker): questionnaire buttons and their anchorless
    // companion-input ghosts share the exact QUESTION label but get
    // DIFFERENT canonicals (per-field screener uniquing), so the
    // canonical-based dedupe missed them — the ghosts then failed
    // resolution, broke the submit waiver, and the fallback re-fill
    // smeared their errors. Same-label twins of an anchored entry drop
    // too.
    const ghost =
      anchorless &&
      ((e.canonical_field !== null &&
        e.canonical_field !== undefined &&
        anchored.has(e.canonical_field)) ||
        (e.label !== undefined && anchoredLabels.has(normLabel(e.label))));
    if (ghost) dropped.push(`${e.field_id} (${e.canonical_field ?? e.label})`);
    return !ghost;
  });
  return { entries: out, dropped };
}

export async function greenhouseVerifyFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const fields: FormVerificationResult["fields"] = [];
  const warnings: string[] = [];

  const deduped = dedupeAnchorlessCanonicalTwins(entries, fieldMeta);
  const fillable = deduped.entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true),
  );

  for (const entry of fillable) {
    const meta = fieldMeta.get(entry.field_id);
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const observed = await greenhouseReadFieldValue(page, {
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "fill",
        value: entry.value,
        reason: "verify",
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      });
      const expected = entry.value;
      let match = false;
      if (Array.isArray(expected)) {
        // #73 multi-value pickers (Skills): the chips must be a NON-EMPTY
        // subset of the planned list — no foreign values, at least one
        // landed. The fill already named the values the page refused.
        const chipString =
          typeof observed === "string"
            ? observed
            : observed && typeof observed === "object" && "label" in observed
              ? String((observed as { label: unknown }).label ?? "")
              : "";
        const chips = chipString
          .split(";")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        match =
          chips.length > 0 &&
          chips.every((c) =>
            (expected as unknown[]).some((e) => labelsCompatible(String(e), c)),
          );
        fields.push({ canonical_field: canonical, expected, observed, match });
        continue;
      }
      if (
        observed &&
        typeof observed === "object" &&
        "value" in observed &&
        "label" in observed
      ) {
        const o = observed as { value: unknown; label: unknown };
        match =
          valuesMatch(expected, o.value, canonical) ||
          valuesMatch(expected, o.label, canonical);
      } else {
        match = valuesMatch(expected, observed, canonical);
        // #69 (live tiaa #22r): verify was STRICTER than the fill — the
        // fill's already-committed check accepted the chip "United States
        // of America (+1)" for the profile value via labelsCompatible,
        // then verify mismatched the same pair. Verify accepts exactly
        // what the fill's commit check accepts.
        if (
          !match &&
          typeof expected === "string" &&
          typeof observed === "string" &&
          labelsCompatible(expected, observed)
        ) {
          match = true;
        }
      }
      if (!match) {
        // #146 (live UKG run 15): readonly/disabled controls are
        // PAGE-OWNED (PreferredName/FormerName say "change it on My
        // presence") — our planned value cannot apply, and a mismatch
        // there parked a form whose fillable fields all verified. Accept
        // in place with a warning; the submit completeness scan still
        // guards required emptiness on its own read.
        const lockLoc = locatorForField(
          page,
          {
            field_id: entry.field_id,
            label: entry.label,
            ...(meta?.name ? { name: meta.name } : {}),
            ...(meta?.inputId ? { inputId: meta.inputId } : {}),
          },
          entry.type,
        );
        const locked = await lockLoc
          .evaluate(
            (el: {
              readOnly?: boolean;
              disabled?: boolean;
              getAttribute: (n: string) => string | null;
            }) =>
              el.readOnly === true ||
              el.disabled === true ||
              el.getAttribute("aria-readonly") === "true",
          )
          .catch(() => false);
        if (locked) {
          match = true;
          warnings.push(
            `verify ${canonical}: control is readonly/disabled — page-owned value accepted in place`,
          );
        }
      }
      fields.push({
        canonical_field: canonical,
        expected,
        observed,
        match,
      });
    } catch (err) {
      // #78 verify fallback: option-typed questions that are really an
      // Ashby-style radio FIELDSET (no locatable control by label) —
      // read the checked member's own label.
      if (String(entry.type) === "select") {
        const fieldset = page
          .locator("fieldset")
          .filter({ hasText: entry.label.slice(0, 60) })
          .first();
        const checked = fieldset.locator("input[type='radio']:checked").first();
        if ((await checked.count().catch(() => 0)) > 0) {
          const checkedLabel = await checked
            .evaluate(
              (el: {
                getAttribute: (n: string) => string | null;
                parentElement?: { textContent?: string | null } | null;
              }) => {
                const id = el.getAttribute("id");
                const doc = (
                  globalThis as unknown as {
                    document?: { querySelector: (s: string) => { textContent?: string | null } | null };
                  }
                ).document;
                if (id) {
                  const lab = doc?.querySelector(`label[for="${id}"]`);
                  if (lab?.textContent) return lab.textContent.trim();
                }
                return el.parentElement?.textContent?.trim() ?? "";
              },
            )
            .catch(() => "");
          const ok =
            checkedLabel.length > 0 && valuesMatch(entry.value, checkedLabel, canonical);
          fields.push({
            canonical_field: canonical,
            expected: entry.value,
            observed: checkedLabel || null,
            match: ok,
          });
          continue;
        }
      }
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  return {
    passed:
      fields.length > 0 && fields.every((f) => f.match) && warnings.length === 0,
    fields,
    uploads: [],
    warnings,
  };
}

/**
 * Resolve the file input on job-boards / classic Greenhouse forms.
 * Prefer id-based inputs (job-boards has no name=). Search all frames.
 * Hidden / visually-hidden is OK — setInputFiles only needs attached.
 */
export async function resolveGreenhouseFileInput(
  page: Page,
  kind: "resume" | "cover_letter",
): Promise<Locator> {
  const preferId = kind === "resume" ? "resume" : "cover_letter";
  const keywords =
    kind === "resume" ? (["resume", "cv"] as const) : (["cover"] as const);

  // Prefer main frame + id (job-boards: #resume / #cover_letter, no name=).
  // Use short-lived waits; callers re-resolve immediately before mutate.
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];

  for (const frame of frames) {
    const byId = frame.locator(`input[type="file"]#${preferId}`);
    if ((await byId.count().catch(() => 0)) > 0) {
      await byId.first().waitFor({ state: "attached", timeout: 5_000 });
      return byId.first();
    }

    for (const kw of keywords) {
      const byAttr = frame.locator(
        `input[type="file"][name*="${kw}" i], input[type="file"][id*="${kw}" i]`,
      );
      if ((await byAttr.count().catch(() => 0)) > 0) {
        await byAttr.first().waitFor({ state: "attached", timeout: 5_000 });
        return byAttr.first();
      }
    }
  }

  // Fall back: index among form file inputs (job-boards: resume then cover).
  for (const frame of frames) {
    const files = frame.locator("input[type='file']");
    const n = await files.count().catch(() => 0);
    if (n === 0) continue;
    for (let i = 0; i < n; i++) {
      const loc = files.nth(i);
      const id = ((await loc.getAttribute("id")) ?? "").toLowerCase();
      const name = ((await loc.getAttribute("name")) ?? "").toLowerCase();
      const looksCover = /cover/.test(id) || /cover/.test(name);
      const looksResume =
        /resume|cv/.test(id) || /resume|cv/.test(name) || (!looksCover && i === 0);
      if (kind === "resume" && looksResume && !looksCover) {
        await loc.waitFor({ state: "attached", timeout: 5_000 });
        return loc;
      }
      if (kind === "cover_letter" && (looksCover || i === 1)) {
        await loc.waitFor({ state: "attached", timeout: 5_000 });
        return loc;
      }
    }
  }

  const inventory = await inventoryFileInputs(page);
  throw new Error(
    `Greenhouse ${kind} file input not found (waited for attached). ` +
      `Saw ${inventory.length} input[type=file]: ${JSON.stringify(inventory)}`,
  );
}

async function inventoryFileInputs(
  page: Page,
): Promise<Array<{ frame: string; id: string | null; name: string | null }>> {
  const out: Array<{ frame: string; id: string | null; name: string | null }> =
    [];
  for (const frame of page.frames()) {
    const handles = frame.locator("input[type='file']");
    const n = await handles.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const h = handles.nth(i);
      out.push({
        frame: frame.url(),
        id: await h.getAttribute("id"),
        name: await h.getAttribute("name"),
      });
    }
  }
  return out;
}

export async function greenhouseUploadFile(
  page: Page,
  kind: "resume" | "cover_letter",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`greenhouse.upload.${kind}`);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: 0,
      verified: false,
      evidence: "file missing",
    };
  }
  const stat = fs.statSync(abs);
  logger.info(`greenhouse upload: resolving ${kind} input`, {
    service: "greenhouse",
    action: "upload",
    metadata: { kind, size_bytes: stat.size },
  });

  // Escape open menus before upload. Job-boards unmounts #resume after a
  // successful setInputFiles and shows a filename chip — verify must treat
  // that pattern as success, not re-resolve fail.
  const filename = path.basename(abs);
  const preferId = kind === "resume" ? "resume" : "cover_letter";
  try {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);

    // Already attached on a reused page (live DV Trading 2026-08-30): the
    // pipeline fill uploaded the resume and verified 22 fields; the submit
    // path then uploaded AGAIN on the same held page, job-boards re-parsed
    // the resume and re-rendered, and three verified comboboxes read
    // "(empty)" — a re-fill cannot restore react-selects. When the chip
    // for this exact file is on the page and the input is unmounted, the
    // upload already happened: report it verified and touch nothing.
    {
      const bodyNow = await page.locator("body").innerText().catch(() => "");
      const inputMounted =
        (await page.locator(`input[type="file"]#${preferId}`).count().catch(() => 0)) > 0;
      const stemNow = filename.replace(/\.[^.]+$/, "");
      // Same read-back the post-upload verification trusts: the exact
      // filename, or a long stem prefix (job-boards truncates chips).
      // DV Trading #9b: the input stayed mounted next to the chip, so a
      // mount check alone let the destructive second upload through.
      const chipNow =
        bodyNow.includes(filename) ||
        (stemNow.length >= 12 && bodyNow.includes(stemNow.slice(0, 24)));
      if (chipNow) {
        logger.info(`greenhouse upload: ${kind} already attached — skipping re-upload`, {
          service: "greenhouse",
          action: "upload",
          metadata: { kind, verified: true, already_attached: true, input_mounted: inputMounted },
        });
        return {
          field: kind,
          path: abs,
          filename,
          size_bytes: stat.size,
          verified: true,
          evidence: `already attached: chip for ${filename} visible${inputMounted ? " (input still mounted)" : " (input unmounted)"} — re-upload skipped`,
        };
      }
      logger.info(`greenhouse upload: ${kind} not yet attached — uploading`, {
        service: "greenhouse",
        action: "upload",
        metadata: { kind, input_mounted: inputMounted, chip_visible: false },
      });
    }

    let input: Locator;
    try {
      input = await resolveGreenhouseFileInput(page, kind);
    } catch (resolveErr) {
      // First-party embeds (live 2026-08-29: samsara.com ?gh_jid= page)
      // render a dropzone with NO input[type=file] anywhere — the input is
      // created on click. Playwright's filechooser event intercepts that
      // click without any OS dialog; the chip read-back below still decides
      // verified, so a miss stays fail-closed.
      const viaChooser = await uploadViaFileChooser(page, kind, abs);
      if (viaChooser) return viaChooser;
      throw resolveErr;
    }
    // Hidden / visually-hidden is intentional — do not click "Attach" (OS dialog).
    await input.setInputFiles(abs, { timeout: 15_000 });

    // Same locator, immediately — element may already be mid-unmount.
    // locator.evaluate(fn, ARG, OPTIONS): the timeout is the THIRD
    // argument. Passed as the second it became the callback's arg and a
    // detached input (job-boards unmounts on change — the success case)
    // blocked for the default 30 s (#183 fixture exposed it).
    let files: Array<{ name: string; size: number }> = [];
    try {
      files = await input.evaluate(
        (el: { files?: ArrayLike<{ name: string; size: number }> | null }) => {
          const list = el.files ? Array.from(el.files) : [];
          return list.map((f) => ({ name: f.name, size: f.size }));
        },
        undefined,
        { timeout: 2_000 },
      );
    } catch {
      files = [];
    }

    const inputFilesMatch =
      files.some((f) => f.name === filename) ||
      files.some((f) => f.size === stat.size);

    // #183 (live Stripe Toronto 2026-09-07): job-boards unmounts #resume
    // the moment a file lands and renders the filename chip only after its
    // upload/parse request completes. A single 350 ms wait saw chip=false
    // there (Dublin, same widget, was simply faster), and the old rule
    // "input gone + no files ⇒ verified" reported a phantom success that
    // the submit pass then contradicted (no input, no chip → refused).
    // Poll for the chip instead; an unmounted input with no chip is NOT
    // verified, and gets one filechooser (Attach) retry below.
    const chipDeadline = Date.now() + CHIP_POLL_MS;
    let stillAttached = true;
    let chipVisible = false;
    do {
      await page.waitForTimeout(350);
      stillAttached =
        (await page
          .locator(`input[type="file"]#${preferId}`)
          .count()
          .catch(() => 0)) > 0;
      chipVisible = await chipForFileVisible(page, filename);
      if (chipVisible || inputFilesMatch) break;
    } while (Date.now() < chipDeadline);

    let ok = inputFilesMatch || chipVisible;
    let evidence = `input files: ${JSON.stringify(files)}; stillAttached=${stillAttached}; chip=${chipVisible}`;

    if (!ok && !stillAttached) {
      // The widget swallowed the input without acknowledging the file.
      // One bounded retry through the page's own Attach trigger; the
      // chip read-back decides, and its evidence names the widget text.
      const retry = await uploadViaFileChooser(page, kind, abs);
      const widgetText = await uploadWidgetText(page, kind);
      if (retry?.verified) {
        ok = true;
        evidence = `${evidence}; filechooser retry: ${retry.evidence}`;
      } else {
        evidence =
          `${evidence}; input unmounted with no filename acknowledgment` +
          ` (filechooser retry: ${retry ? retry.evidence : "no trigger"});` +
          ` widget text: ${JSON.stringify(widgetText)}`;
      }
    }

    logger.info(`greenhouse upload: ${kind} complete`, {
      service: "greenhouse",
      action: "upload",
      metadata: {
        verified: ok,
        file_count: files.length,
        still_attached: stillAttached,
        chip_visible: chipVisible,
      },
    });
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: ok,
      evidence,
    };
  } catch (err) {
    const inventory = await inventoryFileInputs(page).catch(() => []);
    logger.info(`greenhouse upload: ${kind} failed`, {
      service: "greenhouse",
      action: "upload",
      metadata: {
        error: err instanceof Error ? err.message : String(err),
        inventory,
      },
    });
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

/** How long the upload read-back waits for the filename chip (#183). */
const CHIP_POLL_MS = 8_000;

/** The exact filename, or a long stem prefix (job-boards truncates chips). */
async function chipForFileVisible(page: Page, filename: string): Promise<boolean> {
  const stem = filename.replace(/\.[^.]+$/, "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return (
    bodyText.includes(filename) ||
    (stem.length >= 12 && bodyText.includes(stem.slice(0, 24)))
  );
}

/**
 * Visible text of the upload widget for `kind` (its label's enclosing
 * section), for the evidence string of a failed read-back. Read-only.
 */
async function uploadWidgetText(
  page: Page,
  kind: "resume" | "cover_letter",
): Promise<string> {
  const re = kind === "resume" ? "resume|\\bcv\\b|curriculum" : "cover\\s*letter";
  return page
    .evaluate((pattern: string) => {
      type Node = { textContent: string | null; closest(sel: string): Node | null };
      const doc = (globalThis as unknown as { document: { querySelectorAll(sel: string): ArrayLike<Node> } }).document;
      const rx = new RegExp(pattern, "i");
      const label = Array.from(doc.querySelectorAll("label, legend, h2, h3, h4"))
        .find((el) => rx.test((el.textContent ?? "").slice(0, 60)));
      const scope = label?.closest("section, fieldset, [class]") ?? label;
      return (scope?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    }, re)
    .catch(() => "");
}

/**
 * Dropzone fallback: click an upload trigger while intercepting the
 * filechooser event (no OS dialog under Playwright). Trigger choice is
 * evidence-based: its own text must look like an upload control AND its
 * text/section must name this kind — except a page with exactly one
 * trigger and kind=resume, the single-upload form shape. Returns null
 * when no defensible trigger exists (caller rethrows the resolve error).
 */
async function uploadViaFileChooser(
  page: Page,
  kind: "resume" | "cover_letter",
  absPath: string,
): Promise<UploadVerification | null> {
  const filename = path.basename(absPath);
  const sizeBytes = fs.statSync(absPath).size;
  const kindRe =
    kind === "resume" ? /resume|\bcv\b|curriculum/i : /cover\s*letter|cover/i;
  const triggerRe =
    /attach|upload|browse|(select|choose|add)\s+(a\s+)?file|drop\s+(your\s+)?(file|resume|cv)/i;

  const candidates = page.locator('button, [role="button"], label, a');
  const total = Math.min(await candidates.count().catch(() => 0), 60);
  const matches: Array<{ loc: Locator; kindMatch: boolean }> = [];
  for (let i = 0; i < total; i++) {
    const c = candidates.nth(i);
    const text = ((await c.innerText().catch(() => "")) ?? "").trim();
    if (!text || text.length > 80) continue;
    if (!triggerRe.test(text) && !kindRe.test(text)) continue;
    if (!(await c.isVisible().catch(() => false))) continue;
    const sectionText = await c
      .evaluate(
        (el: {
          closest(sel: string): { textContent: string | null } | null;
        }) =>
          el.closest("section, fieldset, [class]")?.textContent?.slice(0, 300) ??
          "",
      )
      .catch(() => "");
    matches.push({ loc: c, kindMatch: kindRe.test(`${text} ${sectionText}`) });
  }
  const kindMatched = matches.filter((m) => m.kindMatch);
  let trigger: Locator | null = null;
  if (kindMatched.length > 0) trigger = kindMatched[0]!.loc;
  else if (matches.length === 1 && kind === "resume") trigger = matches[0]!.loc;
  if (!trigger) return null;

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5_000 }),
      trigger.click({ timeout: 5_000 }),
    ]);
    await chooser.setFiles(absPath);
  } catch {
    return null;
  }

  // Deterministic read-back: the page must acknowledge the file (chip /
  // filename text). No acknowledgment ⇒ verified=false, submit refuses.
  // #183: poll — the chip lands when the upload request completes.
  const chipDeadline = Date.now() + CHIP_POLL_MS;
  let chipVisible = false;
  do {
    await page.waitForTimeout(350);
    chipVisible = await chipForFileVisible(page, filename);
    if (chipVisible) break;
  } while (Date.now() < chipDeadline);
  logger.info(`greenhouse upload: ${kind} via filechooser fallback`, {
    service: "greenhouse",
    action: "upload",
    metadata: { verified: chipVisible, chip_visible: chipVisible },
  });
  return {
    field: kind,
    path: absPath,
    filename,
    size_bytes: sizeBytes,
    verified: chipVisible,
    evidence: `filechooser fallback (no input[type=file] on page); chip=${chipVisible}`,
  };
}

export async function greenhouseResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("greenhouse.resetForm");
  const form = page.locator(greenhouseSelectorsV1.form).first();
  if ((await form.count()) === 0) {
    return { reset: false, notes: ["application form not found"] };
  }
  await form.evaluate((el: { reset: () => void }) => {
    el.reset();
  });
  return { reset: true, notes: ["HTMLFormElement.reset() invoked"] };
}

/**
 * #66b (live tiaa #22n/#22o): a text value can sit in the DOM through the
 * fill-time read-backs (including post-blur) and STILL never reach React
 * state — a later re-render (hydration, a sibling committing) wipes it
 * and verify reads "(empty)". Verify failure is the one moment we KNOW
 * state didn't take, so retype exactly the empty-observed text misses at
 * keystroke level (real key events reach handlers fill() can miss), once,
 * then the caller re-verifies. Bounded: only match=false + empty observed
 * + non-empty expected + text-class entries; everything else untouched.
 */
export async function retypeEmptyVerifyMisses(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
  verify: FormVerificationResult,
): Promise<{ retyped: string[]; notes: string[] }> {
  const retyped: string[] = [];
  const notes: string[] = [];
  const TEXT_TYPES = new Set(["text", "email", "tel", "phone", "url", "number", "textarea"]);
  const observedEmpty = (o: unknown): boolean => {
    if (o === null || o === undefined) return true;
    if (typeof o === "string") return o.trim() === "";
    if (typeof o === "object" && "value" in o && "label" in o) {
      const v = o as { value: unknown; label: unknown };
      return (
        String(v.value ?? "").trim() === "" && String(v.label ?? "").trim() === ""
      );
    }
    return false;
  };
  const cleanEntries = dedupeAnchorlessCanonicalTwins(entries, fieldMeta).entries;
  for (const f of verify.fields) {
    if (f.match || !observedEmpty(f.observed)) continue;
    const expected = typeof f.expected === "string" ? f.expected : "";
    if (expected.trim() === "") continue;
    // #69: prefer the ANCHORED entry for a canonical — the ghost twin's
    // bare label ("Phone") can never resolve among four Phone-ish labels.
    const entry = cleanEntries.find(
      (e) =>
        (e.canonical_field ?? e.field_id) === f.canonical_field &&
        (fieldMeta.get(e.field_id)?.inputId || fieldMeta.get(e.field_id)?.name),
    ) ??
      cleanEntries.find(
        (e) => (e.canonical_field ?? e.field_id) === f.canonical_field,
      );
    if (!entry) continue;
    // #90 (live crowe/stryker submit legs): an on-page SELECT that
    // verified at fill time can read empty at submit time (late pick
    // loss). Re-pick it through the combobox machinery — bounded, same
    // option-verified refusals.
    if (
      String(entry.type).toLowerCase() === "select" &&
      typeof entry.value === "string"
    ) {
      const meta = fieldMeta.get(entry.field_id);
      try {
        const loc = locatorForField(
          page,
          {
            field_id: entry.field_id,
            label: entry.label,
            ...(meta?.name ? { name: meta.name } : {}),
            ...(meta?.inputId ? { inputId: meta.inputId } : {}),
          },
          entry.type,
          { visibleOnly: true },
        );
        const r = await fillComboboxControl(
          page,
          loc,
          comboboxExpected(entry.canonical_field, entry.value),
          { alternates: comboboxAlternates(entry.canonical_field, entry.value) },
        );
        if (r.committed) {
          retyped.push(f.canonical_field);
          notes.push(`retype: ${f.canonical_field} re-picked after empty verify read`);
        } else {
          notes.push(
            `retype: ${f.canonical_field} re-pick not committed — ${r.notes.slice(-1).join("")}`.slice(0, 200),
          );
        }
      } catch (err) {
        notes.push(
          `retype: ${f.canonical_field} re-pick failed — ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
        );
      }
      continue;
    }
    if (!TEXT_TYPES.has(String(entry.type).toLowerCase())) continue;
    const meta = fieldMeta.get(entry.field_id);
    try {
      const loc = locatorForField(
        page,
        {
          field_id: entry.field_id,
          label: entry.label,
          ...(meta?.name ? { name: meta.name } : {}),
          ...(meta?.inputId ? { inputId: meta.inputId } : {}),
        },
        entry.type,
        { visibleOnly: true },
      );
      await loc.click({ timeout: 5_000 });
      await loc.fill("");
      await loc.pressSequentially(expected, { delay: 30 });
      await loc.blur().catch(() => undefined);
      await page.waitForTimeout(300);
      retyped.push(f.canonical_field);
      notes.push(`retype: ${f.canonical_field} keystroke-retyped after empty verify read`);
    } catch (err) {
      notes.push(
        `retype: ${f.canonical_field} failed — ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }
  return { retyped, notes };
}

export async function greenhouseVerifyAnswers(
  page: Page,
  expected: ResolvedApplicationAnswers,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const filtered = entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true) &&
      e.canonical_field &&
      expected[e.canonical_field] !== undefined,
  );
  return greenhouseVerifyFromPlan(page, filtered, fieldMeta);
}
