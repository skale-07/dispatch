import type { DiscoveredField } from "../adapter.js";
import {
  decodeEntities,
  discoverFieldsFromHtml,
} from "../../applications/fieldDiscovery.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby discovery = the generic input/textarea/select pass PLUS a
 * button-group pass: Ashby renders Yes/No questions as role="radiogroup"
 * containers holding <button> children, which the generic regex discovery
 * cannot see. Emitted as type "radio" so they flow through the existing
 * plan/approval policy (demographics and essays still route away).
 */

/**
 * True when the HTML looks like Ashby's unrendered SPA shell — a root div
 * plus scripts, no form controls. Static fetches of jobs.ashbyhq.com pages
 * look like this; discovery needs a rendered DOM snapshot instead.
 */
export function looksLikeUnrenderedShell(html: string): boolean {
  const hasControls = /<(input|select|textarea|form)\b/i.test(html);
  if (hasControls) return false;
  return ashbySelectorsV1.shellMarkers.test(html);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = attrs.match(re);
  return m?.[1] ?? null;
}

function resolveLabelledBy(html: string, id: string): string | null {
  const re = new RegExp(
    `<[^>]*\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<`,
    "i",
  );
  const m = html.match(re);
  const text = m?.[1] !== undefined ? stripTags(m[1]) : "";
  return text || null;
}

/**
 * Regex pass over role="radiogroup" blocks. The original version assumed
 * button-only innards and truncated at the first nested </div> — the live
 * Cohere run proved both wrong: its Additional Questions radiogroups nest
 * divs and render options as role="radio" elements, so the groups were
 * dropped from discovery entirely and the screener bank never saw them.
 * The window now extends to the next radiogroup (or a bounded cap), and
 * options come from <button>s, [role="radio"] elements, or radio-input
 * labels — whichever the DOM actually uses.
 */
const GROUP_WINDOW_CAP = 4_000;

/**
 * True innards of the element opened at `start`: walk open/close tags of
 * the same name, balancing depth. Falls back to the cap on malformed HTML
 * — a too-wide window only risks extra option candidates, never a miss.
 */
function balancedInner(html: string, tag: string, start: number, cap = GROUP_WINDOW_CAP): string {
  const tokenRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tokenRe.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(html)) !== null) {
    depth += t[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
    if (t.index - start > cap) break;
  }
  return html.slice(start, Math.min(html.length, start + cap));
}

export function discoverAshbyButtonGroups(html: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  const openRe = /<(div|fieldset)\b([^>]*\brole=["']radiogroup["'][^>]*)>/gi;
  const opens: Array<{ tag: string; attrs: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    opens.push({
      tag: m[1] ?? "div",
      attrs: m[2] ?? "",
      start: m.index + m[0].length,
    });
  }
  let idx = 0;
  for (const open of opens) {
    const attrs = open.attrs;
    const inner = balancedInner(html, open.tag, open.start);

    const options: string[] = [];
    const push = (t: string): void => {
      const clean = stripTags(t).replace(/\s+/g, " ").trim();
      if (clean && !options.includes(clean) && options.length < 12) {
        options.push(clean);
      }
    };
    // Tier 1: segmented-control buttons (the original Ashby shape).
    const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
    let b: RegExpExecArray | null;
    while ((b = btnRe.exec(inner)) !== null) push(b[1] ?? "");
    // Tier 2: ARIA radios (the live Cohere shape).
    if (options.length === 0) {
      const radioRe =
        /<[a-z]+\b[^>]*\brole=["']radio["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
      let r: RegExpExecArray | null;
      while ((r = radioRe.exec(inner)) !== null) push(r[1] ?? "");
    }
    // Tier 3: native radio inputs — option text from the wrapping label.
    if (options.length === 0) {
      const labelRe = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
      let l: RegExpExecArray | null;
      while ((l = labelRe.exec(inner)) !== null) {
        if (/<input\b[^>]*type=["']radio["']/i.test(l[1] ?? "")) push(l[1] ?? "");
      }
    }
    if (options.length === 0) continue;

    const fieldId = getAttr(attrs, "data-field-id") ?? undefined;
    const ariaLabel = getAttr(attrs, "aria-label") ?? undefined;
    const labelledBy = getAttr(attrs, "aria-labelledby");
    const rawLabel =
      ariaLabel ??
      (labelledBy ? (resolveLabelledBy(html, labelledBy) ?? undefined) : undefined) ??
      fieldId ??
      `button_group_${idx}`;
    // Same required-asterisk cleanup as the generic discovery's cleanLabel.
    const label = rawLabel.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
    const required = /aria-required=["']true["']/i.test(attrs);

    const field: DiscoveredField = {
      id: fieldId ?? `button_group_${idx}`,
      label,
      type: "radio",
      required,
      options,
    };
    if (fieldId) field.name = fieldId;
    out.push(field);
    idx++;
  }
  return out;
}

/**
 * Fieldset question groups — the live 2026-08-15 Ashby shape that the
 * radiogroup pass above cannot see.
 *
 * Run 2a9f9930 (Abridge 40 skips, Notion 38 skips): Ashby renders a choice
 * question as a plain <fieldset> whose first label carries the class
 * `ashby-application-form-question-title` ("What pronouns do you use?"),
 * followed by one checkbox/radio PER OPTION whose `name` attribute is the
 * option text itself (name="She/her", name="Glassdoor", name="Man"). The
 * generic discovery therefore surfaced every OPTION as its own field —
 * "Man | No answer-alias mapping" ×38 — and the question text reached
 * nothing: the screener bank had no label to match, the predict tier had
 * zero askable questions, and the option harvest found zero select-likes.
 * The entire intelligence stack was starved at discovery.
 *
 * This pass rebuilds the truth: one field per fieldset, labeled by the
 * question title, with options[] = the option texts — exactly the shape
 * every downstream tier (bank matcher → LLM option-select → LLM predict →
 * Other fallback) is built to consume. The per-option inputs inside
 * grouped fieldsets are suppressed from the generic scan so the plan sees
 * each question once.
 */
const QUESTION_TITLE_RE =
  /<label\b[^>]*class=["'][^"']*question-title[^"']*["'][^>]*>([\s\S]*?)<\/label>/i;

/** The one wrapper path the education rebuild owns. */
const EDUCATION_PATH_RE = /_systemfield_education_history$/;

export function discoverAshbyFieldsetGroups(html: string): {
  fields: DiscoveredField[];
  /** Option input names consumed by a group — exclude from the generic pass. */
  consumedNames: Set<string>;
} {
  const fields: DiscoveredField[] = [];
  const consumedNames = new Set<string>();
  const openRe = /<fieldset\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = openRe.exec(html)) !== null) {
    const inner = balancedInner(html, "fieldset", m.index + m[0].length, 16_000);

    const titleMatch = inner.match(QUESTION_TITLE_RE);
    if (!titleMatch) continue;
    const label = stripTags(titleMatch[1] ?? "")
      .replace(/\s*\*\s*$/, "")
      .trim();
    if (!label) continue;
    const forId = getAttr(titleMatch[0] ?? "", "for");

    // Option TEXT comes from the per-option labels (for="…-labeled-radio-N"
    // / "…-labeled-checkbox-N") — Ashby has two shapes and only the labels
    // are reliable in both. Checkbox questions put the option text in
    // name= too, but radio questions name every input with the SAME entry
    // uuid (that is what makes them a group), so name is useless there —
    // and it is exactly why the generic radio collapse emitted these
    // questions labeled by their first option ("Under 30", "Man"…).
    const options: string[] = [];
    const optLabelRe =
      /<label\b[^>]*for=["'][^"']*-labeled-(?:checkbox|radio)-\d+["'][^>]*>([\s\S]*?)<\/label>/gi;
    let o: RegExpExecArray | null;
    while ((o = optLabelRe.exec(inner)) !== null) {
      const clean = stripTags(o[1] ?? "").replace(/\s+/g, " ").trim();
      if (clean && !options.includes(clean) && options.length < 30) {
        options.push(clean);
      }
    }
    if (options.length < 2) continue; // one checkbox is consent, not a choice

    // Names of the inputs this group consumed — both shapes — so the
    // generic pass's per-option fields (checkbox shape) and its collapsed
    // radio group (radio shape, first-option label) can be suppressed.
    const consumedHere: string[] = [];
    const inputRe = /<input\b([^>]*type=["'](?:checkbox|radio)["'][^>]*)>/gi;
    let inp: RegExpExecArray | null;
    while ((inp = inputRe.exec(inner)) !== null) {
      const name = getAttr(inp[1] ?? "", "name");
      if (name) consumedHere.push(name);
    }

    // Required from the title label's class (`_required_`) or an
    // aria-required anywhere in the group.
    const required =
      /_required_/.test(titleMatch[0] ?? "") ||
      /aria-required=["']true["']/i.test(inner);

    const field: DiscoveredField = {
      id: forId ?? `fieldset_group_${idx}`,
      label,
      type: "select",
      required,
      options,
    };
    if (forId) field.name = forId;
    fields.push(field);
    for (const n of consumedHere) consumedNames.add(n);
    for (const opt of options) consumedNames.add(opt);
    idx++;
  }
  return { fields, consumedNames };
}

/**
 * Ashby's built-in education block (#272, live Commure 2026-09-12 app
 * 80e6a0fc and #271's sibling app 04394211). The block is ONE
 * `data-field-path="_systemfield_education_history"` wrapper whose sub-
 * controls are addressed by their inner labels' `for` ids — but only
 * Degree and Field of Study actually CARRY those ids. School is an id-less
 * autocomplete, and Start/End Date are each a PAIR of id-less month+year
 * `<select>`s inside a plain `<div id="…-startDate">`.
 *
 * So the generic pass saw four unnamed selects, fell back to the wrapper
 * path (`…education_history#17` … `#20`), labelled them all with the GROUP
 * label "Education History", and the plan sent them to the screener bank /
 * LLM predict — which answered "May" / "2025" into controls the fill could
 * not even locate ("control not found on the page"), while the wrapper's
 * own path id landed a stray "2025" in the SCHOOL combobox. Two live apps
 * parked on it in one evening.
 *
 * This pass rebuilds the four date controls as what they are: one field per
 * `<select>`, id `<for-id>-month` / `<for-id>-year` (mapped by that
 * structural suffix in fieldNormalization, never by the group label), with
 * the page's real option list attached so a year the form does not offer is
 * skipped rather than traded for a nearby one (#273).
 */
export function discoverAshbyEducationDates(html: string): {
  fields: DiscoveredField[];
  /** Wrapper paths the rebuild owns — drop their generic twins. */
  claimedPaths: Set<string>;
} {
  const fields: DiscoveredField[] = [];
  const claimedPaths = new Set<string>();
  const labelRe =
    /<label\b([^>]*\bfor=["']([^"']*-(?:startDate|endDate))["'][^>]*)>([\s\S]*?)<\/label>/gi;
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const forId = m[2] ?? "";
    const base = forId.replace(/-(?:startDate|endDate)$/, "");
    if (!EDUCATION_PATH_RE.test(base)) continue;
    const labelText =
      stripTags(m[3] ?? "")
        .replace(/\s*\*\s*$/, "")
        .trim() || forId;
    // The container div carrying the label's `for` id holds the two selects.
    const openRe = new RegExp(
      `<div\\b[^>]*\\bid=["']${forId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    );
    const open = openRe.exec(html);
    if (!open) continue;
    const inner = balancedInner(html, "div", open.index + open[0].length, 40_000);
    const selects = inner.match(/<select\b[\s\S]*?<\/select>/gi) ?? [];
    if (selects.length < 2) continue;
    claimedPaths.add(base);
    const required = /_required_/.test(attrs);
    for (const [i, unit] of (["month", "year"] as const).entries()) {
      const block = selects[i] ?? "";
      const options = [...block.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
        .filter((o) => !/\bhidden\b|\bdisabled\b/i.test(o[1] ?? ""))
        .map((o) => stripTags(o[2] ?? ""))
        .filter((t) => t.length > 0);
      if (options.length === 0) continue;
      const field: DiscoveredField = {
        id: `${forId}-${unit}`,
        label: `${labelText} ${unit === "month" ? "Month" : "Year"}`,
        type: "select",
        required,
        options,
      };
      fields.push(field);
    }
  }
  return { fields, claimedPaths };
}

/**
 * Autocomplete questions (live sierra 2026-09-01, #117): Ashby's
 * `ashby-application-form-input-autocomplete` input has NO id, name, or
 * label[for] — the question-title label's `for` points at the field's
 * uuid, which exists only as the wrapper's data-field-path. The generic
 * pass therefore surfaced the input labeled by its PLACEHOLDER ("Start
 * typing...", synthetic id f_N), which the bank then mis-mapped (the
 * Sierra "What University do you currently attend?" question planned a
 * city). One field per autocomplete: id = the title's `for` uuid (the
 * data-field-path locator tier resolves it), label = the question text.
 * Options stay unknown at plan time — the list is fetched as you type.
 */
export function discoverAshbyAutocompletes(html: string): {
  fields: DiscoveredField[];
  /** Placeholder texts consumed — suppress their generic twins. */
  placeholders: Set<string>;
} {
  const fields: DiscoveredField[] = [];
  const placeholders = new Set<string>();

  // Question-title label positions, in document order.
  const titleRe = new RegExp(QUESTION_TITLE_RE.source, "gi");
  const titles: { index: number; tag: string; text: string }[] = [];
  let t: RegExpExecArray | null;
  while ((t = titleRe.exec(html)) !== null) {
    titles.push({
      index: t.index,
      tag: t[0] ?? "",
      text: stripTags(t[1] ?? "")
        .replace(/\s*\*\s*$/, "")
        .trim(),
    });
  }

  const inputRe =
    /<input\b([^>]*class=["'][^"']*input-autocomplete[^"']*["'][^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    // Closest preceding question title within the same field block.
    let title: { index: number; tag: string; text: string } | null = null;
    for (const cand of titles) {
      if (cand.index < m.index) title = cand;
      else break;
    }
    if (!title || !title.text || m.index - title.index > 4_000) continue;
    const forId = getAttr(title.tag, "for");
    if (!forId) continue;
    const placeholder = getAttr(m[1] ?? "", "placeholder");
    if (placeholder) placeholders.add(placeholder.trim());
    // No name/inputId on purpose: the input carries neither, and setting
    // one would send locatorForField down an exact-attribute tier that
    // matches nothing. The bare uuid id resolves via the
    // data-field-path wrapper tier.
    fields.push({
      id: forId,
      label: title.text,
      type: "text",
      required: /_required_/.test(title.tag),
    });
  }
  return { fields, placeholders };
}

/**
 * Yes/No button pairs (#132, live valon 2026-09-01): a
 * `ashby-application-form-input-yesno` container holds two aria-pressed
 * buttons and ONE HIDDEN CHECKBOX named by the field uuid — the generic
 * pass surfaced that checkbox labeled by its own uuid ("ea7319ab-…"),
 * unmappable by any tier, and the required work-authorization question
 * bounced the submit click. One field per pair: label from the
 * question-title label[for=uuid], options Yes/No.
 */
export function discoverAshbyYesNo(html: string): {
  fields: DiscoveredField[];
  consumedNames: Set<string>;
} {
  const fields: DiscoveredField[] = [];
  const consumedNames = new Set<string>();
  const titleRe = new RegExp(QUESTION_TITLE_RE.source, "gi");
  const titles: { index: number; tag: string; text: string }[] = [];
  let t: RegExpExecArray | null;
  while ((t = titleRe.exec(html)) !== null) {
    titles.push({
      index: t.index,
      tag: t[0] ?? "",
      text: stripTags(t[1] ?? "")
        .replace(/\s*\*\s*$/, "")
        .trim(),
    });
  }
  const boxRe = /<div\b[^>]*class=["'][^"']*input-yesno[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = boxRe.exec(html)) !== null) {
    let title: { index: number; tag: string; text: string } | null = null;
    for (const cand of titles) {
      if (cand.index < m.index) title = cand;
      else break;
    }
    if (!title || !title.text || m.index - title.index > 2_000) continue;
    const forId = getAttr(title.tag, "for");
    if (!forId) continue;
    fields.push({
      id: forId,
      label: title.text,
      type: "select",
      required: /_required_/.test(title.tag),
      options: ["Yes", "No"],
    });
    consumedNames.add(forId);
  }
  return { fields, consumedNames };
}

export function ashbyDiscoverFields(html: string): DiscoveredField[] {
  const groups = discoverAshbyFieldsetGroups(html);
  const autos = discoverAshbyAutocompletes(html);
  const yesno = discoverAshbyYesNo(html);
  const education = discoverAshbyEducationDates(html);
  const autoIds = new Set(autos.fields.map((f) => f.id));
  /**
   * #271/#272: wrapper paths whose sub-controls a rebuild already owns. The
   * generic pass addresses id-less inputs inside such a wrapper by the path
   * itself (first one) and `path#N` (the rest) — ids that name the GROUP,
   * carry the group's label, and resolve to the wrong control or to nothing.
   * A path is claimed when the education rebuild took it, or when a rebuilt
   * autocomplete field is scoped under it (`<path>-school`).
   */
  const claimedPaths = new Set<string>(education.claimedPaths);
  for (const f of autos.fields) {
    // Only a NAMED system-field path may be claimed this way. A rebuilt
    // autocomplete's id is usually a bare uuid (Sierra #117) and chopping
    // its last dash segment would invent a path that means nothing.
    const m = /^(_systemfield_[a-z_]+)-[A-Za-z]+$/.exec(f.id);
    if (m?.[1]) claimedPaths.add(m[1]);
  }
  const generic = discoverFieldsFromHtml(html).filter((f) => {
    // A claimed wrapper path, bare or index-suffixed, is never a question.
    const path = f.id.replace(/#\d+$/, "");
    if (claimedPaths.has(path) && !autoIds.has(f.id)) return false;
    // Drop the per-option inputs a fieldset group already represents —
    // they are answers, not questions, and 38 of them drowned the plan.
    if (f.name && groups.consumedNames.has(f.name)) return false;
    // #132: the yes/no pair's hidden plumbing checkbox (name = field uuid).
    if (f.name && yesno.consumedNames.has(f.name)) return false;
    // Label collision is only evidence for OPTION-SHAPED fields
    // (checkbox/radio members, member ids, synthetic ids). Live sierra
    // 2026-09-01 (#119): the real "LinkedIn" URL field was swallowed here
    // because "LinkedIn" is also an option of "How did you hear…" — a
    // text control with its own uuid id is a question, not an option.
    if (
      groups.consumedNames.has(f.label) &&
      (f.type === "checkbox" ||
        f.type === "radio" ||
        /^f_\d+$/.test(f.id) ||
        /-labeled-(?:checkbox|radio)-\d+$/.test(f.id))
    ) {
      return false;
    }
    // Drop the generic twin of an autocomplete question. Two shapes:
    // (a) the wrapper data-field-path fallback now gives the id-less
    //     input the SAME uuid the rebuild claims — the rebuild's
    //     caption-derived field (with required) is authoritative;
    // (b) the older placeholder-labeled twin with a synthetic f_N id.
    if (autoIds.has(f.id)) return false;
    if (/^f_\d+$/.test(f.id) && autos.placeholders.has(f.label.trim())) {
      return false;
    }
    return true;
  });
  return [
    ...generic,
    ...groups.fields,
    ...autos.fields,
    ...yesno.fields,
    ...education.fields,
    ...discoverAshbyButtonGroups(html),
  ];
}
