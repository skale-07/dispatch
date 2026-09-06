import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Offline HTML field discovery — no browser required.
 * Uses regex + lightweight heuristics suitable for fixture tests and Phase 4 dry-run.
 * Prefer label[for], aria-label, placeholder, name — not brittle class chains alone.
 */
/**
 * Does this "label" actually name a question? A bracketed machine path, a
 * bare uuid, a `field_12` fallback, or generic placeholder prose all mean
 * the real question lives elsewhere in the DOM.
 */
export function isUninformativeLabel(label: string): boolean {
  const t = label.trim();
  if (t.length === 0) return true;
  if (/^field_\d+$/.test(t)) return true;
  // Machine names only: the WHOLE label is token[key][key…] (cards[uuid]
  // [field0], urls[Other]). A bracketed abbreviation inside a real
  // question ("…Employee Relations [ER] review…") is informative — the
  // substring test threw away the one tiaa questionnaire legend that
  // contained brackets and the field was never discovered (#98).
  if (/^[\w.-]*(\[[^\]]*\])+$/.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return true;
  }
  if (/^(type your (response|answer)|your (answer|response)|answer|response|select(\.\.\.| an option)?|choose(\.\.\.| one)?|please select)$/i.test(t)) {
    return true;
  }
  // #157 (live rivian icims 2026-09-03): an UNTRANSLATED i18n key is not a
  // question — the page shipped `JOBS.KEYWORD_SEARCH_PLACEHOLDER` as the
  // literal placeholder. Whole-label, SCREAMING_CASE, at least one dot, no
  // spaces: a real question has spaces long before it has that shape.
  if (/^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)+$/.test(t)) return true;
  return false;
}

/**
 * #157 / #162: a LISTING page's own widgets are not application fields.
 *
 * #157, live rivian.icims.com 2026-09-03: the posting page carried
 * `keyword-search` and `location-search`, the only two inputs on it. They
 * were discovered, the page therefore classified as a `form`, the screener
 * bank answered one and an LLM call INVENTED "United States" for the
 * other, both read back empty and the app stopped AMBIGUOUS_FIELD — with
 * the real application never opened. `pageClassify` already refuses this
 * shape, but only when it also finds an Apply CTA; dropping the chrome at
 * discovery makes the page fieldless and the Apply path runs regardless.
 *
 * #162, live careers.philips.com 2026-09-03: the same doctrine, worse
 * consequence. That posting's widgets are "Save <job> to job cart",
 * "Share job link" and `notifiedEmail` / "Enter Email address (Required)"
 * — a JOB-ALERT signup. `notifiedEmail` is `type=email`, so
 * `hasApplicationIdentityFields` read it as the applicant's own email,
 * the page classified `form`, and the run TYPED THE OPERATOR'S REAL EMAIL
 * INTO A MARKETING SIGNUP on a page where it had not applied to anything.
 * Posting furniture must never be filled, and an alert box must never be
 * mistaken for applicant identity.
 *
 * Deliberately narrow, and the narrowness is tested. `search` alone is NOT
 * enough: Workday's option pickers are `<input placeholder="Search">`
 * inside real applications (#67) and must keep flowing. "Email" alone is
 * not enough either — every real application asks for one.
 */
export function isListingPageChrome(field: {
  label: string;
  name?: string | undefined;
  inputId?: string | undefined;
  attrs?: string | undefined;
}): boolean {
  // A Workday selectinput is an option picker inside an application form.
  if (/data-uxi-widget-type\s*=\s*["']selectinput["']/i.test(field.attrs ?? "")) {
    return false;
  }
  const machine = `${field.name ?? ""} ${field.inputId ?? ""}`.toLowerCase();
  if (
    /(^|[\s_-])(keyword|location|title|job)[\s_-]?search([\s_-]|$)/.test(machine) ||
    /(^|[\s_-])search[\s_-]?(keyword|location|job|title)s?([\s_-]|$)/.test(machine)
  ) {
    return true;
  }
  // #162 posting furniture, by machine name: the alert-signup email
  // (`notifiedEmail`, `jobAlertEmail`) and the save-to-cart checkbox
  // (`save-<REQ-ID>`). "email" on its own is never enough.
  if (
    /(^|[\s_-])(notified|notify|alert|jobalert|subscribe)[\s_-]?e?mail([\s_-]|$)/.test(
      machine,
    ) ||
    /(^|[\s_-])e?mail[\s_-]?(alert|friend|job)s?([\s_-]|$)/.test(machine) ||
    /^save[-_][a-z0-9]{6,}$/.test(machine.trim())
  ) {
    return true;
  }
  const label = field.label.toLowerCase();
  return (
    /search by job title|job title, id|city, state, or country/.test(label) ||
    /\b(keyword|location)_search_placeholder\b/.test(label) ||
    // #162 posting furniture, by label.
    /\bshare (this )?job\b|\bshare job link\b|\bjob cart\b|\bsave (this )?job\b/.test(
      label,
    ) ||
    /\bemail (this )?job\b|\bsend (this )?job to\b|\bjob alert/.test(label)
  );
}

// Legends and headings only. A preceding <label> belongs to a DIFFERENT
// control — this field's own label was already resolved via labelMap — so
// including it made a radio option ("Yes") look like a section heading.
const HEADING_RE =
  /<(legend|h1|h2|h3|h4|h5|h6)\b[^>]*>([\s\S]{1,300}?)<\/\1>/gi;

/**
 * Gem-style caption recovery (#112, live nuvo jobs.gem.com 2026-08-31):
 * the form renders captions as bare `<span class="bodyImportant">First
 * name<span> *</span></span>` — no <label>, no heading, and the inputs
 * carry no name/id/placeholder/aria, so every field discovered as
 * `field_N` and the classifier read the page as furniture. Fallback when
 * no legend/heading resolves: the nearest short text run BEFORE the
 * control, scoped to AFTER the previous form control so another field's
 * caption (or a radio option) can never be stolen.
 */
export function nearestPrecedingCaption(
  html: string,
  position: number,
): { text: string; distance: number } | null {
  const window = html.slice(Math.max(0, position - 1_500), position);
  const lastControl = Math.max(
    window.lastIndexOf("<input"),
    window.lastIndexOf("<select"),
    window.lastIndexOf("<textarea"),
    window.lastIndexOf("<button"),
  );
  const scopeStart = lastControl >= 0 ? lastControl : 0;
  const scope = window.slice(scopeStart);
  const re = /<(span|div|p|b|strong)\b[^>]*>([\s\S]{1,200}?)<\/\1>/gi;
  let best: { text: string; distance: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const text = cleanLabel(decodeEntities(stripTags(m[2] ?? "")));
    if (text.length < 3 || text.length > 80) continue;
    if (isUninformativeLabel(text)) continue;
    // last (nearest) informative run wins
    best = { text, distance: window.length - (scopeStart + m.index) };
  }
  return best;
}

/**
 * Text of the nearest legend/heading/label BEFORE this position — the
 * question a machine-named control sits under. Bounded scan; returns null
 * rather than guessing when nothing informative precedes the field.
 */
export function nearestSectionHeading(
  html: string,
  position: number,
): string | null {
  return nearestSectionHeadingWithDistance(html, position)?.text ?? null;
}

function nearestSectionHeadingWithDistance(
  html: string,
  position: number,
): { text: string; distance: number } | null {
  const window = html.slice(Math.max(0, position - 4_000), position);
  HEADING_RE.lastIndex = 0;
  let best: { text: string; distance: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(window)) !== null) {
    const text = cleanLabel(decodeEntities(stripTags(m[2] ?? "")));
    if (text.length < 3 || text.length > 200) continue;
    if (isUninformativeLabel(text)) continue;
    best = { text, distance: window.length - m.index }; // nearest wins
  }
  return best;
}

export function discoverFieldsFromHtml(
  rawHtml: string,
  opts?: { preferGreenhouse?: boolean },
): DiscoveredField[] {
  // Regex discovery reads RAW text, so an <input …> inside a <script>
  // string literal (SPA templates, JSON payloads) counted as a real field
  // — the Workday wizard walk handed a review page to the filler because
  // the page's own script mentioned form markup. DOM-invisible blocks go
  // first.
  const html = stripHiddenSubtrees(
    rawHtml
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<template\b[\s\S]*?<\/template>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, ""),
  );
  const fields: DiscoveredField[] = [];
  const labelMap = buildLabelMap(html);
  const seenDateWrappers = new Set<string>();

  const inputRe =
    /<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = (m[1] ?? "input").toLowerCase();
    const attrs = m[2] ?? "";
    const inner = m[3] ?? "";

    // #101 (live tiaa page 7): Workday date widgets are a dateInputWrapper
    // holding Month/Day/Year spinbutton fragments whose aria-labels
    // ("Month") mapped to the wrong canonicals and whose per-section fills
    // typed prose into spinbuttons. Collapse the trio into ONE field named
    // by the enclosing fieldset legend; the fill routes it to the
    // section-wise date writer.
    const dateSection = attrs.match(
      /data-automation-id=["']dateSection(?:Month|Day|Year)-input["']/i,
    );
    if (dateSection) {
      const secId = getAttr(attrs, "id") ?? "";
      const wrapperId = secId.replace(/-dateSection(?:Month|Day|Year)-input$/i, "");
      if (wrapperId && wrapperId !== secId && !seenDateWrappers.has(wrapperId)) {
        seenDateWrappers.add(wrapperId);
        const legend = enclosingFieldsetLegend(html, m.index);
        const wLabel =
          (legend && !isUninformativeLabel(legend) ? legend : undefined) ??
          labelMap.get(wrapperId) ??
          nearestSectionHeading(html, m.index) ??
          `field_${idx}`;
        const fsOpen = html.slice(Math.max(0, m.index - 4_000), m.index);
        const fsWin = fsOpen.slice(Math.max(0, fsOpen.lastIndexOf("<fieldset")));
        fields.push({
          id: wrapperId,
          label: cleanLabel(wLabel),
          type: "text",
          required:
            /requiredAsterisk/i.test(fsWin) ||
            /aria-required=["']true["']/i.test(attrs),
          inputId: wrapperId,
        });
        idx++;
      }
      continue;
    }

    const typeAttr = getAttr(attrs, "type")?.toLowerCase() ?? (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text");
    if (typeAttr === "hidden" || typeAttr === "submit" || typeAttr === "button" || typeAttr === "image") {
      continue;
    }
    // The control's OWN attributes say it is not visible: Greenhouse
    // job-boards ships `<input required tabindex="-1" aria-hidden="true"
    // class="…requiredInput">` after every combobox / checkbox group (live
    // neuralink 2026-08-30). Read as text fields they were labeled by the
    // nearest legend ("I understand … on-site" → f_24, plus f_12/f_14/f_21/
    // f_26 "field_N"), planned, failed "control not found", and the healer
    // then re-pointed one at an unrelated combobox at score 0.45.
    if (isHiddenAttrs(attrs)) {
      continue;
    }

    const name = getAttr(attrs, "name") ?? undefined;
    const inputId = getAttr(attrs, "id") ?? undefined;
    const ariaLabel = getAttr(attrs, "aria-label") ?? undefined;
    const labelledbyIds = getAttr(attrs, "aria-labelledby") ?? undefined;
    const labelledby = labelledbyIds
      ? ariaLabelledbyText(html, labelledbyIds)
      : undefined;
    const placeholder = getAttr(attrs, "placeholder") ?? undefined;
    const fieldPath = enclosingFieldPath(html, m.index);
    const dataFor = getAttr(attrs, "data-for") ?? undefined;
    const required =
      /\brequired\b/i.test(attrs) ||
      /aria-required=["']true["']/i.test(attrs);

    let label =
      (inputId ? labelMap.get(inputId) : undefined) ??
      labelledby ??
      ariaLabel ??
      (fieldPath ? labelMap.get(fieldPath) : undefined) ??
      placeholder ??
      dataFor ??
      name ??
      `field_${idx}`;

    // #157: drop the listing page's own job-search box before it can be
    // planned, mapped to a screener answer or sent to the LLM predictor.
    if (isListingPageChrome({ label, name, inputId, attrs })) {
      continue;
    }

    let fieldType = mapType(tag, typeAttr);
    // #67 (live tiaa 2026-08-31): Workday multiselect search inputs
    // (data-uxi-widget-type=selectinput, placeholder "Search") are option
    // PICKERS whose options render on open — never free text. Typed as
    // select so the fill takes the pick path, not fill().
    if (/data-uxi-widget-type\s*=\s*["']selectinput["']/i.test(attrs)) {
      fieldType = "select";
    }
    const wrap = wrappingLabelTexts(html, m.index, m.index + m[0].length);
    // Spec-standard wrapping <label> with no `for`. For checkboxes/text
    // this IS the question. For radios it is usually the option ("Yes").
    if (
      fieldType !== "radio" &&
      wrap?.full &&
      (isUninformativeLabel(label) || (name !== undefined && label === name))
    ) {
      label = wrap.full;
    }

    // A machine name or a placeholder is not a question. Live corpus:
    // "cards[631785a2-…][field0]" ×13 (Lever's education/experience cards —
    // school, degree, dates: data the profile HOLDS), "Type your response"
    // ×10, "field_33". Those 72 fields were skipped as unmapped, and the
    // prediction tier rejected them as "unusable label". Look upward for
    // the nearest legend/heading instead of giving up.
    if (isUninformativeLabel(label)) {
      // #112: the NEARER of section heading vs bare-span caption wins —
      // on Gem the description's "About the Role" h2 sits 4k chars back
      // while the field's own caption span is right above it. Caption
      // recovery is for plain inputs only: a radio/checkbox member's
      // nearest text run is its OPTION, handled below.
      const heading = nearestSectionHeadingWithDistance(html, m.index);
      const caption =
        fieldType !== "radio" && fieldType !== "checkbox"
          ? nearestPrecedingCaption(html, m.index)
          : null;
      const nearby =
        caption && (!heading || caption.distance < heading.distance)
          ? caption.text
          : (heading?.text ?? null);
      if (nearby) label = nearby;
    }

    if (opts?.preferGreenhouse && name) {
      const greenhouseLabel = inferGreenhouseLabel(name, label);
      if (greenhouseLabel) label = greenhouseLabel;
    }

    const valueAttr = getAttr(attrs, "value");
    let options =
      tag === "select" ? parseSelectOptions(inner) : undefined;
    if (fieldType === "checkbox") {
      // Greenhouse checkbox GROUPS (live neuralink 2026-08-30): every member
      // is `<input type=checkbox name="question_N[]" description="<question>">`
      // + `<label for>`option`</label>` inside a <fieldset> whose <legend> is
      // the question. Read per member, the option label became the FIELD
      // label — "LinkedIn" (an option of "How did you hear about us?") was
      // claimed as linkedin_url, and "I understand … on-site" (a one-member
      // group whose only option is "Yes") had no control the legend text
      // could find. The question is the field; the member label is an option.
      const question =
        cleanLabel(decodeEntities(getAttr(attrs, "description") ?? "")) ||
        enclosingFieldsetLegend(html, m.index);
      if (question) {
        const optionLabel = cleanLabel(decodeEntities(label));
        label = question;
        options = [optionLabel && optionLabel !== name ? optionLabel : (valueAttr ?? "").trim() || `option_${idx}`];
      }
    }
    if (fieldType === "radio") {
      const optionText = radioOptionText({
        wrap,
        value: valueAttr,
        label,
        name,
      });
      const question =
        nearestBareQuestionLabel(html, m.index) ??
        (radioNeedsQuestionLabel(label, name)
          ? nearestSectionHeading(html, m.index)
          : null);
      if (question) label = question;
      // #125b (live finastra 2026-09-01): Workday's STOCK returning-
      // candidate radio (name=candidateIsPreviousWorker) renders its
      // question as an unanchored paragraph — the heading fallback
      // labeled it "My Information" and no bank tier could ever match.
      // The id is a Workday-wide constant; the semantic label beats a
      // section heading.
      if (name === "candidateIsPreviousWorker") {
        label = "Are you a former employee or returning applicant?";
      }
      // #130 (live gem 2026-09-01): the EEO radios put the question in a
      // bare <h3> the label ladders miss, so the GROUP got labeled by its
      // first OPTION — "White (not Hispanic or Latino)" masqueraded as
      // the question, mis-mapped to hispanic_latino, and a demographic
      // group took a wrong-question answer (caught by the submit gate,
      // never submitted). When the resolved label IS one of the group's
      // option texts and the shared name is a semantic word
      // (gender, race_ethnicity — not a hex/uuid), the humanized name is
      // the honest question label.
      if (
        name &&
        /^[a-z][a-z0-9_]{2,30}$/.test(name) &&
        !/^[0-9a-f]{8,}$/.test(name) &&
        (label === optionText || label.trim() === "" )
      ) {
        const humanized = name.replace(/_+/g, " ").trim();
        if (humanized.length >= 3) label = humanized;
      }
      options = [optionText];
    }

    const maxLengthRaw = getAttr(attrs, "maxlength");
    const minLengthRaw = getAttr(attrs, "minlength");

    // A wrapper data-field-path can enclose MORE than one id-less input
    // (nothing in the DOM enforces 1:1); a duplicate id would make two
    // fields indistinguishable to the plan. Suffix with the input index
    // on collision so each stays addressable.
    const pathId =
      fieldPath !== undefined && fields.some((f) => f.id === fieldPath)
        ? `${fieldPath}#${idx}`
        : fieldPath;
    const field: DiscoveredField = {
      id: inputId ?? name ?? pathId ?? `f_${idx}`,
      label: cleanLabel(label),
      type: fieldType,
      required,
    };
    if (options) field.options = options;
    if (name) field.name = name;
    if (inputId) field.inputId = inputId;
    if (maxLengthRaw) field.maxLength = Number(maxLengthRaw);
    if (minLengthRaw) field.minLength = Number(minLengthRaw);
    // #150: what the control already holds, when the HTML says so — a
    // text box's value attribute, a select's <option selected> text
    // (readLiveHtml serializes live state into exactly these attributes).
    // Radios/checkboxes carry option values, not answers; left alone.
    if (tag === "select") {
      const selected = parseSelectedOption(inner);
      if (selected) field.currentValue = selected;
    } else if (
      fieldType !== "radio" &&
      fieldType !== "checkbox" &&
      fieldType !== "file" &&
      valueAttr != null &&
      valueAttr.trim() !== ""
    ) {
      field.currentValue = decodeEntities(valueAttr).trim();
    }

    fields.push(field);
    idx++;
  }

  // #67 (live tiaa 2026-08-31): Workday listbox dropdowns are BUTTONs
  // (`<button aria-haspopup="listbox" id=…>Current</button>`) with a
  // label[for] pointing at the button — invisible to the input scan, so
  // State / Phone Device Type / Country were never planned and the page
  // errored "The field State is required". Page-chrome listbox buttons
  // (settings gear, locale menu) have no label[for]; requiring a labelMap
  // hit filters them out.
  const buttonRe =
    /<button\b([^>]*aria-haspopup\s*=\s*["']listbox["'][^>]*)>([\s\S]*?)<\/button>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = buttonRe.exec(html)) !== null) {
    const battrs = bm[1] ?? "";
    if (isHiddenAttrs(battrs)) continue;
    const btnId = getAttr(battrs, "id") ?? undefined;
    // #85 (live stryker questionnaire): Workday's compliance questions are
    // listbox buttons labeled only by the enclosing FIELDSET LEGEND
    // (richText — no label[for] anywhere), so the labelMap misses and
    // the questions pages filled 0/N across every tenant. Page-chrome
    // listbox buttons sit outside fieldsets and stay invisible.
    const resolved =
      (btnId ? labelMap.get(btnId) : undefined) ??
      enclosingFieldsetLegend(html, bm.index) ??
      undefined;
    const ownText = cleanLabel(decodeEntities(stripTags(bm[2] ?? "")));
    // #125 (live finastra 2026-09-01): the returning-candidate prompt is
    // a listbox button whose label resolves to the SECTION legend ("My
    // Information") while the QUESTION is the button's own placeholder
    // text (a full paragraph ending "…providing more information:").
    // "No answer-alias mapping" ⇒ skipped ⇒ eight Next clicks bounced
    // off Workday's own required error. A question-shaped own text
    // (long, or ending ?/:) outranks a missing/short section label; a
    // short own text ("Current", an option value) never does — that is
    // the TIAA shape #67 was built on.
    const questionish = ownText.length >= 40 || /[?:]$/.test(ownText);
    const useOwnText =
      questionish &&
      (!resolved ||
        isUninformativeLabel(resolved) ||
        ownText.length > resolved.length * 2);
    const btnLabel = useOwnText ? ownText : resolved;
    if (!btnId || !btnLabel || isUninformativeLabel(btnLabel)) continue;
    const btnName = getAttr(battrs, "name") ?? undefined;
    const current = useOwnText ? "" : ownText;
    const field: DiscoveredField = {
      id: btnId,
      label: cleanLabel(btnLabel),
      type: "select",
      required:
        /required/i.test(getAttr(battrs, "aria-label") ?? "") ||
        /aria-required=["']true["']/i.test(battrs),
      inputId: btnId,
    };
    if (btnName) field.name = btnName;
    if (current) field.currentValue = current;
    fields.push(field);
    idx++;
  }

  // Radio groups: collapse by name; checkbox groups likewise (see the
  // checkbox branch above — only members that resolved a group question).
  return collapseCheckboxGroups(collapseRadioGroups(fields));
}

/** A wrapper's label and stable field path belong to its unlabelled child control. */
function enclosingFieldPath(html: string, index: number): string | undefined {
  const stack: Array<string | undefined> = [];
  const tags = /<\/?div\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) && match.index < index) {
    if (/^<\//.test(match[0])) stack.pop();
    else stack.push(getAttr(match[0], "data-field-path") ?? undefined);
  }
  return stack.reverse().find(value => value !== undefined);
}

/**
 * Legend of the <fieldset> that encloses `index`, or null when the input is
 * not inside one (or the fieldset has no legend). Regex-scoped: the last
 * `<fieldset` before the index that has no matching `</fieldset>` before it.
 */
function enclosingFieldsetLegend(html: string, index: number): string | null {
  // #105 (live tiaa race group): Workday NESTS a legendless inner
  // fieldset (ethnicityMulti-CheckboxGroup) inside the legend-bearing
  // one — walk outward up to 3 levels until a legend appears.
  let cursor = index;
  for (let depth = 0; depth < 3; depth++) {
    const before = html.slice(0, cursor);
    const open = before.lastIndexOf("<fieldset");
    if (open < 0) return null;
    const close = before.lastIndexOf("</fieldset");
    if (close > open) return null;
    const legend = before.slice(open).match(/<legend\b[^>]*>([\s\S]*?)<\/legend>/i);
    if (legend?.[1]) {
      const text = cleanLabel(decodeEntities(stripTags(legend[1])));
      return text || null;
    }
    cursor = open;
  }
  return null;
}

/**
 * One field per checkbox group: the question as label, the member labels as
 * options, the FIRST member's id as the locator anchor (the fill's option
 * path walks the enclosing fieldset from any member). Members are grouped
 * by `name`; a lone checkbox that resolved a legend keeps a one-option
 * group so "I understand … on-site" → "Yes" checks its only box.
 */
function collapseCheckboxGroups(fields: DiscoveredField[]): DiscoveredField[] {
  const groups = new Map<string, DiscoveredField>();
  const out: DiscoveredField[] = [];
  for (const f of fields) {
    // #105: Workday group members carry NO name — their ids share a
    // suffix token after a long generated prefix ("<hex>-ethnicityMulti").
    // That token is the group key; short/plain ids never group this way.
    const idSuffix =
      f.name === undefined &&
      f.inputId !== undefined &&
      /^[0-9a-f]{12,}-(\w{3,})$/i.exec(f.inputId)?.[1];
    const grouped =
      f.type === "checkbox" &&
      (f.name !== undefined || Boolean(idSuffix)) &&
      f.options !== undefined &&
      f.options.length > 0;
    if (!grouped) {
      out.push(f);
      continue;
    }
    const key = f.name ?? `idsuffix:${idSuffix as string}`;
    const existing = groups.get(key);
    if (existing) {
      existing.options = [...(existing.options ?? []), ...(f.options ?? [])];
      existing.required = existing.required || f.required;
    } else {
      const group: DiscoveredField = { ...f, id: key, options: [...(f.options ?? [])] };
      groups.set(key, group);
      out.push(group);
    }
  }
  return out;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isHiddenAttrs(attrs: string): boolean {
  if (/aria-hidden\s*=\s*["']true["']/i.test(attrs)) return true;
  if (/display\s*:\s*none/i.test(attrs)) return true;
  const withoutAria = attrs.replace(/aria-hidden\s*=\s*["'][^"']*["']/gi, "");
  return /(?:^|\s)hidden(?:\s|=|\/|$)/i.test(withoutAria);
}

function matchingCloseIndex(html: string, tag: string, from: number): number {
  const token = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  token.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    if (m[0].startsWith("</")) depth -= 1;
    else if (!/\/\s*>$/.test(m[0])) depth += 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * Wizard steps and Other-specify wraps ship in the same document with
 * `display:none`. Regex discovery otherwise plans those controls, fill
 * waits 2s for visibility, errors, and the Next walker never starts
 * (/fillhard page 2).
 */
/**
 * Consent-manager (OneTrust/Optanon) DOM is page furniture, not the
 * application. Live Paylocity 2026-08-19: 6 cookie toggles were planned as
 * application fields — including OneTrust's own hidden template
 * placeholders ("checkbox label", "Switch Label") — inflating the field
 * count that decides posting-vs-form and polluting the operator brief.
 * The whole banner subtree is dropped before discovery.
 */
function isConsentManagerAttrs(attrs: string): boolean {
  const id = getAttr(attrs, "id") ?? "";
  if (/^(onetrust|ot-sdk|optanon)/i.test(id)) return true;
  const cls = getAttr(attrs, "class") ?? "";
  if (/(^|\s)(onetrust|ot-sdk|optanon)/i.test(cls)) return true;
  return /\bdata-optanongroupid\s*=/i.test(attrs);
}

function stripHiddenSubtrees(html: string): string {
  const openRe = /<([a-z][a-z0-9]*)\b([^>]*?)>/gi;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const tag = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";
    if (VOID_TAGS.has(tag)) continue;
    if (!isHiddenAttrs(attrs) && !isConsentManagerAttrs(attrs)) continue;
    if (/\/\s*$/.test(attrs)) continue;
    const end = matchingCloseIndex(html, tag, m.index + m[0].length);
    if (end < 0) continue;
    out += html.slice(last, m.index);
    last = end;
    openRe.lastIndex = end;
  }
  return out + html.slice(last);
}

function buildLabelMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const body = stripTags(m[2] ?? "").trim();
    const forId = getAttr(attrs, "for");
    if (forId && body) map.set(forId, body);
  }
  return map;
}

/**
 * aria-labelledby resolution — the ARIA-standard third leg the ladder was
 * missing. UKG Pro's registration page (live Bennett Thrasher 2026-09-01)
 * labels its inputs with `<ukg-label id="ukg-label-id-…">First name</ukg-label>`
 * + `aria-labelledby` on the input: no <label> element, no aria-label, an
 * EMPTY placeholder — so firstName/lastName discovered with label "" and
 * planned as SKIP "No answer-alias mapping". The referenced element can be
 * ANY tag (ukg-label, span, div); take its immediate text.
 */
function ariaLabelledbyText(html: string, idList: string): string | undefined {
  const parts: string[] = [];
  for (const id of idList.trim().split(/\s+/).slice(0, 4)) {
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<[a-z][a-z0-9-]*\\b[^>]*(?:^|\\s)id\\s*=\\s*["']${escaped}["'][^>]*>([^<]{0,200})`,
      "i",
    );
    const text = re.exec(html)?.[1]?.trim();
    if (text) parts.push(text);
  }
  const joined = cleanLabel(parts.join(" "));
  return joined.length > 0 ? joined : undefined;
}

function getAttr(attrs: string, name: string): string | null {
  // #67a (live tiaa 2026-08-31): without a left boundary, getAttr("id")
  // matched INSIDE `aria-invalid="false"` — every Workday multiselect got
  // id "false", missed its label[for], and fell back to its placeholder
  // ("Search"), which the page-widget fence then skipped. The attr name
  // must start at the beginning or after whitespace.
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = attrs.match(re);
  return m?.[1] ?? null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanLabel(s: string): string {
  // Entities first: the wrapper data-field-path label rung feeds raw
  // <label> text through here (Ashby titles carry &nbsp;), and decoding
  // already-clean text is a no-op. ✱ is Lever's required glyph (U+2731),
  // same role as the trailing *.
  return decodeEntities(s).replace(/\s*[*✱]\s*$/, "").replace(/\s+/g, " ").trim();
}

/** Headings carry entities that a question text must not; decode the common ones. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function mapType(
  tag: string,
  typeAttr: string,
): DiscoveredField["type"] {
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (typeAttr === "file") return "file";
  if (typeAttr === "checkbox") return "checkbox";
  if (typeAttr === "radio") return "radio";
  if (typeAttr === "date" || typeAttr === "datetime-local") return "date";
  if (typeAttr === "email" || typeAttr === "tel" || typeAttr === "text" || typeAttr === "url" || typeAttr === "number") {
    return "text";
  }
  return "unknown";
}

function parseSelectOptions(inner: string): string[] {
  const opts: string[] = [];
  const re = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const t = stripTags(m[1] ?? "").trim();
    if (t) opts.push(t);
  }
  return opts;
}

/** Text of the <option selected> (#150) — empty when none or a placeholder. */
function parseSelectedOption(inner: string): string {
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (!/\bselected\b/i.test(m[1] ?? "")) continue;
    const t = stripTags(m[2] ?? "").trim();
    if (!t || /^(select|choose|please (select|choose)|-{2,}|—|none$)/i.test(t)) {
      return "";
    }
    return decodeEntities(t);
  }
  return "";
}

function inferGreenhouseLabel(name: string, fallback: string): string | null {
  const map: Record<string, string> = {
    "job_application[first_name]": "First name",
    "job_application[last_name]": "Last name",
    "job_application[email]": "Email",
    "job_application[phone]": "Phone",
    "job_application[resume]": "Resume",
    "job_application[cover_letter]": "Cover letter",
  };
  return map[name] ?? (fallback.includes("[") ? null : fallback);
}

function looksLikeOptionOnlyLabel(text: string): boolean {
  return /^(yes|no|true|false|y|n|n\/a|none)$/i.test(text.trim());
}

function radioNeedsQuestionLabel(label: string, name: string | undefined): boolean {
  if (looksLikeOptionOnlyLabel(label)) return true;
  if (isUninformativeLabel(label)) return true;
  return name !== undefined && label === name;
}

/**
 * A question-only <label> with no `for` and no nested input — Paycom-class
 * lead-capture radios sit under `<label>Do you consent…?</label>` then
 * wrapping option labels. Preceding option-wrapping labels are skipped so
 * "Yes" is not stolen as the group question (see nearestSectionHeading).
 */
function nearestBareQuestionLabel(html: string, position: number): string | null {
  const window = html.slice(Math.max(0, position - 2_000), position);
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    const attrs = m[1] ?? "";
    if (getAttr(attrs, "for")) continue;
    const body = m[2] ?? "";
    if (/<input\b/i.test(body)) continue;
    const text = cleanLabel(decodeEntities(stripTags(body)));
    if (text.length < 8 || text.length > 300) continue;
    if (looksLikeOptionOnlyLabel(text) || isUninformativeLabel(text)) continue;
    best = text;
  }
  return best;
}

function wrappingLabelTexts(
  html: string,
  inputStart: number,
  inputEnd: number,
): { full: string; after: string } | null {
  const before = html.slice(Math.max(0, inputStart - 800), inputStart);
  const lower = before.toLowerCase();
  const openIdx = lower.lastIndexOf("<label");
  const closeIdx = lower.lastIndexOf("</label");
  if (openIdx < 0 || openIdx < closeIdx) return null;
  const tagEnd = before.indexOf(">", openIdx);
  if (tagEnd < 0) return null;
  if (getAttr(before.slice(openIdx, tagEnd), "for")) return null;
  const afterChunk = html.slice(inputEnd, inputEnd + 500);
  const closeRel = afterChunk.search(/<\/label>/i);
  if (closeRel < 0) return null;
  const after = cleanLabel(decodeEntities(stripTags(afterChunk.slice(0, closeRel))));
  const innerStart = inputStart - before.length + tagEnd + 1;
  const full = cleanLabel(
    decodeEntities(stripTags(html.slice(innerStart, inputEnd + closeRel))),
  );
  if (!full && !after) return null;
  return { full, after };
}

function radioOptionText(input: {
  wrap: { full: string; after: string } | null;
  value: string | null;
  label: string;
  name: string | undefined;
}): string {
  const fromWrap = input.wrap?.after || input.wrap?.full || "";
  if (fromWrap && fromWrap !== input.name) return fromWrap;
  const value = input.value?.trim() ?? "";
  // Lever cards use value="0"/"1" with the visible answer in the wrapping
  // label. A bare integer is not an option the filler can click by label.
  if (value && !/^\d+$/.test(value)) return value;
  if (looksLikeOptionOnlyLabel(input.label)) return input.label;
  if (value) return value;
  return input.label;
}

function collapseRadioGroups(fields: DiscoveredField[]): DiscoveredField[] {
  const radios = new Map<string, DiscoveredField>();
  const memberLabels = new Map<string, string[]>();
  const out: DiscoveredField[] = [];
  for (const f of fields) {
    if (f.type === "radio" && f.name) {
      const optionSlice =
        f.options && f.options.length > 0 ? f.options : [f.label];
      if (f.label) {
        memberLabels.set(f.name, [...(memberLabels.get(f.name) ?? []), f.label]);
      }
      const existing = radios.get(f.name);
      if (existing) {
        existing.options = [...(existing.options ?? []), ...optionSlice];
      } else {
        const group: DiscoveredField = {
          ...f,
          id: f.name,
          label: f.label,
          options: [...optionSlice],
        };
        radios.set(f.name, group);
        out.push(group);
      }
    } else {
      out.push(f);
    }
  }
  // #130 (live gem 2026-09-01): a multi-member group whose label is one
  // of its OWN member labels was never a question — "Male" masqueraded
  // as the gender question and "White (not Hispanic or Latino)" as race,
  // mis-mapping a DEMOGRAPHIC group onto the wrong canonical
  // (hispanic_latino clicked an option on the race group; the submit
  // gate caught it, nothing submitted). A semantic shared name (gender,
  // race_ethnicity — not a hex/uuid or numbered placeholder) is the
  // honest label then.
  const normed = (s: string | undefined | null): string =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [name, group] of radios) {
    const members = memberLabels.get(name) ?? [];
    if (members.length < 2) continue;
    // Wrapping radios share ONE label across members — that shared text
    // IS the question ("…text communications…"); only DISTINCT member
    // labels ("Male"/"Female") are options masquerading as the question.
    const distinct = new Set(members.map(normed));
    if (distinct.size < 2) continue;
    if (!members.some((m) => normed(m) === normed(group.label))) continue;
    if (!/^[a-z][a-z0-9_]{2,30}$/.test(name)) continue;
    if (/^[0-9a-f]{8,}$/.test(name)) continue;
    if (/^(q|question|field|input|option|answer)?_?\d*$/.test(name)) continue;
    group.label = name.replace(/_+/g, " ").trim();
    delete group.inputId;
  }
  return out;
}
