/**
 * Required-completeness scan — the pre-click gate the run data demanded.
 * The real Cohere attempt clicked Submit with every required "Additional
 * Question" untouched: the click bounced off client-side validation, the
 * form stayed up, and the run ended UNCERTAIN(still_on_form) — review
 * noise instead of a precise answer. This scan reads the live page for
 * required-but-unanswered controls immediately before the click; any hit
 * refuses the submit BEFORE the click (no budget spent, thanks to the
 * click-commit gate) and names each unanswered question.
 *
 * Conservative in both directions:
 *   - native controls count only via [required]/[aria-required];
 *   - ARIA widget groups (role=radiogroup/combobox) additionally count
 *     when their visible label ends in the universal required marker
 *     ("*" / "✱") — the live Cohere form marks required radio groups ONLY
 *     that way, and the first scan sailed past them. The failure mode of
 *     this heuristic is a visible refusal + review item, never a wrong
 *     submit, so the asymmetry favors including it;
 *   - Greenhouse React-select comboboxes keep the filter <input> empty
 *     after a pick; the committed answer is `.select__single-value`. Those
 *     inputs are not unanswered text fields (Jump Trading 2026-08-17:
 *     18 filled, verify passed, then 14 false "unanswered" as text+combobox);
 *   - fail-open on scan errors — a broken scan must not strand a
 *     completed form (post-click verification still guards the outcome).
 *
 * The page-side code ships as a string expression: src/ compiles without
 * DOM libs, and Playwright evaluates the string in the browser context.
 */
import type { Page } from "playwright";

export type UnansweredRequired = {
  label: string;
  control:
    | "text"
    | "textarea"
    | "select"
    | "radio_group"
    | "checkbox"
    /** A named checkbox group (question_N[] in a fieldset) — one question, answered by any member. */
    | "checkbox_group"
    | "combobox"
    | "file";
  /** What marked it required: the DOM's own attributes/asterisk, or the ATS's published schema. */
  source?: "dom" | "board_api";
};

export type CompletenessScanOptions = {
  /**
   * Question labels the ATS's own schema (G2: the Greenhouse job-board
   * API's `required: true`) declares required. A visible unanswered
   * control whose label matches one of these counts as required even when
   * the DOM carries no required marker — the schema is authoritative for
   * its own board. Matching mirrors applyLabelOptions: exact normalized
   * label, plus unique-prefix for labels ≥20 chars (boards truncate).
   * Omitted or empty ⇒ DOM heuristics alone, exactly as before.
   */
  declaredRequired?: string[];
};

export type CompletenessScan = {
  scanned: boolean;
  unanswered: UnansweredRequired[];
  notes: string[];
};

// Two buckets: \`sure\` is required-per-DOM unanswered (the pre-G2 output,
// byte-for-byte), \`maybe\` is unanswered controls the DOM saw as OPTIONAL.
// The Node side promotes a \`maybe\` entry only when the board's own schema
// declares that question required — the browser never decides that.
const SCAN_EXPRESSION = `(() => {
  const out = [];
  const maybe = [];
  const push = (req, entry) => {
    if (req) {
      if (out.length < 20) out.push(entry);
    } else if (maybe.length < 40) {
      maybe.push(entry);
    }
  };
  const seenGroups = new Set();

  const visible = (el) => {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const clean = (t) => (t || "").replace(/\\s+/g, " ").trim().slice(0, 120);

  // #234: words that belong to an upload WIDGET, never to the question it
  // is attached to. Anchored whole-string so a real question that merely
  // mentions attaching ("…please attach it here or provide a link") is
  // untouched.
  const uploadChrome = (t) =>
    /^(attach|attach file|attach a file|upload|upload file|choose file|choose a file|browse|browse files|select file|dropbox|google drive|drop files here|drag and drop|or|add file)$/i.test(
      (t || "").trim(),
    );

  const labelFor = (el) => {
    let byId = null;
    if (el.id) {
      byId = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    }
    const ariaIds = el.getAttribute("aria-labelledby");
    const ariaEl = ariaIds ? document.getElementById(ariaIds.split(/\\s+/)[0] || "") : null;
    const wrapped = el.closest("label");
    const fieldset = el.closest("fieldset");
    const legend = fieldset ? fieldset.querySelector("legend") : null;
    const text =
      (byId && byId.textContent) ||
      (ariaEl && ariaEl.textContent) ||
      el.getAttribute("aria-label") ||
      (wrapped && wrapped.textContent) ||
      (legend && legend.textContent) ||
      "";
    const direct = clean(text);
    // #234 (live Lexington Medical greenhouse 2026-09-10): a Greenhouse
    // file question renders as "Attach / Dropbox / Google Drive" buttons
    // around a hidden input, so the label lookup returned the BUTTON's
    // word. The board's own schema declared that question required
    // ("Do you have a portfolio of your engineering work…"), but a
    // declared-required label can only be promoted when the DOM label
    // matches it — "Attach" never did. The click went through, the page's
    // own validation bounced it, and a real submit was spent on an
    // UNCERTAIN outcome. Upload chrome is never a question: keep climbing.
    if (direct && !uploadChrome(direct)) return direct;
    // #232 (live CIM Group lever 2026-09-10): Lever's custom "card"
    // questions put the question text in a SIBLING
    // <div class="application-label"><div class="text">…</div></div> and
    // wrap nothing, so every one of them scanned as "(unlabeled)". The
    // submit was then withheld on "1 required question(s) unanswered —
    // (unlabeled)", which names nothing the operator or a requeue can act
    // on, and label-keyed dedupe collapses every such control into one.
    //
    // Climb the field's own container looking for a labelling element.
    // Same unambiguity guard the widget path already uses: exactly one
    // candidate means it belongs to this field; two or more means we have
    // climbed out of the container, so stop rather than borrow a
    // neighbour's question (and its required asterisk).
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      const labs = node.querySelectorAll(
        'label, legend, [class*="label" i], [data-qa*="label" i]',
      );
      const texts = [];
      for (const lab of Array.from(labs)) {
        // Skip a wrapper whose text is just a nested candidate's text.
        if (lab.querySelector('label, legend, [class*="label" i]')) continue;
        const t = clean(lab.textContent);
        // #234: the sibling "Dropbox" / "Google Drive" buttons are chrome,
        // not competing questions — they must not make the container look
        // ambiguous, or the real question is never reached.
        if (t && !uploadChrome(t)) texts.push(t);
      }
      if (texts.length === 1) return texts[0];
      if (texts.length > 1) break;
    }
    return direct || "(unlabeled)";
  };

  const isRequired = (el) =>
    el.required === true || el.getAttribute("aria-required") === "true";

  const isComboboxControl = (el) => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    const ac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
    if (
      role === "combobox" ||
      haspopup === "listbox" ||
      haspopup === "true" ||
      ac === "list" ||
      ac === "both"
    ) {
      return true;
    }
    return Boolean(
      el.closest('[class*="select__control"], [class*="select-shell"], [class*="select2"], [role="combobox"]'),
    );
  };

  const placeholderish = (t) => /^(start typing|select|choose)/i.test(t || "");

  const committedComboboxValue = (el) => {
    const shell =
      el.closest('[class*="select-shell"]') ||
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select_"]');
    if (shell) {
      const single = shell.querySelector('[class*="single-value"], [class*="singleValue"]');
      if (single) {
        const t = clean(single.textContent);
        if (t && !placeholderish(t)) return t;
        const title = clean(single.getAttribute("title"));
        if (title && !placeholderish(title)) return title;
      }
      const multi = shell.querySelectorAll('[class*="multi-value__label"], [class*="multiValue__label"]');
      const chips = [];
      for (let i = 0; i < multi.length; i++) {
        const t = clean(multi[i].textContent);
        if (t && t !== "×" && t !== "x" && t.length > 1) chips.push(t);
      }
      if (chips.length > 0) return chips.join(", ");
      return "";
    }
    const value = ((el.value || "") + "").trim();
    if (value && !placeholderish(value)) return value;
    const aria = clean(el.getAttribute("aria-valuetext"));
    if (aria && !placeholderish(aria)) return aria;
    return "";
  };

  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    const type = (el.type || "").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button") continue;
    if (type === "file") {
      // Required uploads (cover letter, transcript) burned 2 of the first
      // 3 clicks on 2026-08-29 — the click bounced off a visible "is
      // required" error the scan never saw. Resume/CV inputs stay excluded:
      // the dedicated upload guard owns them, and boards clear input.files
      // after a successful chip-style upload (a false "unanswered" here
      // would refuse verified submits). File inputs skip the visibility
      // check — upload widgets hide them by design.
      const idname = ((el.id || "") + " " + (el.name || "")).toLowerCase();
      if (/resume|\\bcv\\b/.test(idname)) continue;
      if ((el.files ? el.files.length : 0) === 0) {
        push(isRequired(el), { label: labelFor(el), control: "file" });
      }
      continue;
    }
    if (isComboboxControl(el)) continue;

    if (type === "radio") {
      const name = el.name || "";
      const key = name || labelFor(el);
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const group = name
        ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]'))
        : [el];
      const groupRequired = group.some((r) => isRequired(r));
      const anyChecked = group.some((r) => r.checked);
      // Custom-styled radios (live Ashby/Exa 2026-08-30) hide the native
      // input behind a painted circle — the GROUP is on-screen when any
      // member's own <label for> is visible even if every input is not.
      const memberLabelVisible = (r) => {
        if (!r.id) return false;
        const lab = document.querySelector('label[for="' + CSS.escape(r.id) + '"]');
        return lab ? visible(lab) : false;
      };
      const anyVisible = group.some((r) => visible(r) || memberLabelVisible(r));
      if (!anyChecked && anyVisible) {
        const fs = el.closest("fieldset");
        const legend = fs ? fs.querySelector("legend") : null;
        // Legendless fieldset (Ashby): the QUESTION label is the fieldset
        // <label> that does not target a member radio; per-option labels
        // point at member ids. Without this the group reports an option
        // text ("San Francisco based") and the requiredness marker —
        // which lives on the question label — is never seen.
        let qLabel = null;
        if (!legend && fs) {
          const memberIds = new Set(group.map((r) => r.id).filter(Boolean));
          const labs = Array.from(fs.querySelectorAll("label"));
          qLabel = labs.find((l) => {
            const f = l.getAttribute("for");
            return f ? !memberIds.has(f) : !l.querySelector("input");
          }) || null;
        }
        // Ashby marks requiredness ONLY via a class token on the question
        // label ("_required_…") — no [required], no aria-required, no
        // asterisk. A wrong hit here refuses into a review item, never a
        // wrong submit, so the class marker and trailing asterisk count.
        const markerEl = legend || qLabel;
        const markerRequired = markerEl
          ? /(^|[_\\s-])required([_\\s-]|$)/i.test(markerEl.className || "") ||
            /[*\\u2731]\\s*$/.test(clean(markerEl.textContent))
          : false;
        push(groupRequired || markerRequired, {
          label:
            clean(legend ? legend.textContent : qLabel ? qLabel.textContent : labelFor(el)) ||
            "(radio group)",
          control: "radio_group",
        });
      }
      continue;
    }
    const required = isRequired(el);
    if (!visible(el)) continue;
    if (type === "checkbox") {
      // Checkbox GROUP (Greenhouse job-boards, live neuralink 2026-08-30):
      // members share a name (question_N[]) inside a <fieldset><legend>.
      // Each member carries the required attribute, so per-box reading listed all 13
      // unchecked members of two ANSWERED groups as unanswered questions.
      // One question per group: unanswered only when no member is checked.
      const cname = el.name || "";
      const fs = el.closest("fieldset");
      let siblings = cname
        ? Array.from(document.querySelectorAll('input[type="checkbox"][name="' + CSS.escape(cname) + '"]'))
        : [];
      // #114 (live mastercard 2026-08-31): Workday demographic groups
      // carry NO name — members share an id SUFFIX token
      // ("<hex>-ethnicityMulti", the #105 shape). One member was checked
      // and Workday itself was satisfied, yet per-box reading named all
      // remaining aria-required members as unanswered questions.
      const sfx = (el.id || "").match(/-([A-Za-z][A-Za-z0-9_]{2,})$/);
      if (siblings.length <= 1 && sfx) {
        const same = Array.from(
          document.querySelectorAll('input[type="checkbox"]'),
        ).filter((c) => (c.id || "").endsWith("-" + sfx[1]));
        if (same.length > 1) siblings = same;
      }
      const isGroup = siblings.length > 1 || (cname !== "" && fs !== null && fs.querySelector("legend") !== null);
      if (isGroup) {
        const key = "checkbox:" + (cname || (sfx ? "sfx:" + sfx[1] : labelFor(el)));
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const members = siblings.length > 0 ? siblings : [el];
        const groupRequired = members.some((c) => isRequired(c));
        const anyChecked = members.some(
          (c) => c.checked || c.getAttribute("aria-checked") === "true",
        );
        if (!anyChecked) {
          const legend = fs ? fs.querySelector("legend") : null;
          push(groupRequired, {
            label: clean(legend ? legend.textContent : labelFor(el)) || "(checkbox group)",
            control: "checkbox_group",
          });
        }
        continue;
      }
      if (!el.checked) push(required, { label: labelFor(el), control: "checkbox" });
      continue;
    }
    if (el.tagName === "SELECT") {
      const placeholderish = el.selectedIndex <= 0 && (!el.value || el.value === "");
      if (placeholderish) push(required, { label: labelFor(el), control: "select" });
      continue;
    }
    if (((el.value || "") + "").trim() === "") {
      // #124 (live finastra 2026-09-01): a Workday multiselect's SEARCH
      // input is empty by design once a chip is committed — the answer
      // lives in selectedItemList / "N item(s) selected". Two live
      // false refusals ("How Did You Hear About Us?", "Country Phone
      // Code") both carried "1 item selected, …" in the container.
      const msc = el.closest('[data-automation-id="multiSelectContainer"]');
      if (msc) {
        const chips = msc.querySelectorAll(
          '[data-automation-id="selectedItemList"] li, [data-automation-id="selectedItem"]',
        );
        const aria = msc.querySelector('[data-automation-id="promptAriaInstruction"]');
        const ariaText = aria ? aria.textContent || "" : "";
        if (chips.length > 0 || /\\d+\\s+items?\\s+selected/i.test(ariaText)) continue;
      }
      push(required, {
        label: labelFor(el),
        control: el.tagName === "TEXTAREA" ? "textarea" : "text",
      });
    }
  }

  // #124b: Workday LISTBOX BUTTONS (<button aria-haspopup="listbox">) are
  // neither inputs nor role=combobox widgets — the live finastra
  // returning-candidate question sat unanswered (Workday's own "must have
  // a value" hint in the DOM) while the scan flagged two answered
  // multiselects instead. Unanswered = placeholder-ish own text.
  for (const el of Array.from(
    document.querySelectorAll('button[aria-haspopup="listbox"]'),
  )) {
    if (!visible(el)) continue;
    const label = labelFor(el);
    if (label === "(unlabeled)") continue;
    // Workday renders its own inline error next to an unanswered
    // required prompt — the strongest unanswered signal we have. An
    // empty/placeholder button (or one whose text is just the label
    // repeated) is the weaker fallback.
    const hintUnanswered = /is required and must have a value/i.test(
      (el.parentElement && el.parentElement.textContent) || "",
    );
    const own = clean(el.textContent);
    const unanswered =
      hintUnanswered ||
      !own ||
      /^(select one|select|choose one|choose)$/i.test(own) ||
      own === label.replace(/[*\\u2731]\\s*$/, "").trim();
    if (!unanswered) continue;
    const required =
      hintUnanswered ||
      el.getAttribute("aria-required") === "true" ||
      /[*\\u2731]\\s*$/.test(label);
    if (seenGroups.has(label)) continue;
    seenGroups.add(label);
    push(required, { label: label, control: "combobox" });
  }

  // Widget labels often live on a sibling <label> inside the field
  // container rather than on the widget itself (Ashby's live shape).
  const widgetLabel = (el) => {
    const direct = labelFor(el);
    if (direct !== "(unlabeled)") return direct;
    let node = el;
    for (let i = 0; i < 3 && node.parentElement; i++) {
      node = node.parentElement;
      const labs = node.querySelectorAll("label");
      // Exactly one label in the ancestor = unambiguous; more than one
      // means we've climbed out of this field's container — stop rather
      // than borrow a neighboring question's label (and its asterisk).
      if (labs.length === 1 && clean(labs[0].textContent)) {
        return clean(labs[0].textContent);
      }
      if (labs.length > 1) break;
    }
    return "(unlabeled)";
  };
  // aria-required is authoritative; a trailing asterisk on the label is
  // the fallback marker (the live Cohere required groups carry ONLY it).
  const widgetRequired = (el, label) =>
    el.getAttribute("aria-required") === "true" || /[*\\u2731]\\s*$/.test(label);

  const widgets = document.querySelectorAll('[role="radiogroup"], [role="combobox"]');
  for (const el of Array.from(widgets)) {
    if (!visible(el)) continue;
    const label = widgetLabel(el);
    const required = widgetRequired(el, label);
    if (el.getAttribute("role") === "radiogroup") {
      const checked = el.querySelector('[role="radio"][aria-checked="true"]');
      const nativeChecked = el.querySelector("input:checked");
      const pressed = el.querySelector('button[aria-pressed="true"]');
      if (!checked && !nativeChecked && !pressed) {
        if (!seenGroups.has(label)) {
          seenGroups.add(label);
          push(required, { label: label, control: "radio_group" });
        }
      }
    } else {
      const trimmed = committedComboboxValue(el);
      if (trimmed === "" || placeholderish(trimmed)) {
        push(required, { label: label, control: "combobox" });
      }
    }
  }
  return { sure: out, maybe: maybe };
})()`;

/** Same normalization applyLabelOptions uses, so schema labels line up. */
const normalizeForMatch = (s: string): string =>
  s
    .replace(/[*✱]\s*$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function buildDeclaredMatcher(
  declaredRequired: string[],
): (label: string) => boolean {
  const keys = declaredRequired.map(normalizeForMatch).filter((k) => k.length > 0);
  const exact = new Set(keys);
  return (label: string): boolean => {
    const key = normalizeForMatch(label);
    if (key.length === 0) return false;
    if (exact.has(key)) return true;
    // Boards truncate long labels in the DOM; a long key that is the
    // unambiguous prefix (either direction) of exactly one declared label
    // matches. An ambiguous prefix refuses — same rule as applyLabelOptions.
    if (key.length >= 20) {
      const hits = keys.filter((k) => k.startsWith(key) || key.startsWith(k));
      if (hits.length === 1) return true;
    }
    return false;
  };
}

export async function scanRequiredCompleteness(
  page: Page,
  opts?: CompletenessScanOptions,
): Promise<CompletenessScan> {
  try {
    const raw = (await page.evaluate(SCAN_EXPRESSION)) as {
      sure: Array<{ label: string; control: UnansweredRequired["control"] }>;
      maybe: Array<{ label: string; control: UnansweredRequired["control"] }>;
    };
    const matchesDeclared = buildDeclaredMatcher(opts?.declaredRequired ?? []);
    // DOM-required first so on a label collision the DOM verdict wins.
    const merged: UnansweredRequired[] = [
      ...raw.sure.map((u) => ({ ...u, source: "dom" as const })),
      ...raw.maybe
        .filter((u) => matchesDeclared(u.label))
        .map((u) => ({ ...u, source: "board_api" as const })),
    ];
    const seen = new Set<string>();
    const deduped = merged
      .filter((u) => {
        const k = u.label
          .replace(/[*✱]\s*$/u, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 20);
    return { scanned: true, unanswered: deduped, notes: [] };
  } catch (err) {
    return {
      scanned: false,
      unanswered: [],
      notes: [
        `required-completeness scan failed (fail-open): ${
          err instanceof Error ? err.message.slice(0, 150) : String(err)
        }`,
      ],
    };
  }
}
