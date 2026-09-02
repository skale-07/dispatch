import type { Page } from "playwright";

/**
 * #150 (live UKG run 17): `page.content()` serializes ATTRIBUTES, and a
 * script-bound form (Knockout `value:` bindings, React controlled inputs)
 * holds its values in PROPERTIES — the resume-parsed "Software Engineer,
 * Product Development Team" in NewWorkExperience_JobTitle0 is invisible
 * to the plan, so the plan cannot know the row is already answered.
 *
 * Serialize the page with live control state written into the standard
 * attributes discovery already reads: `value` on text-like inputs, the
 * `selected` attribute on the chosen <option>, `checked` on radios and
 * checkboxes. The live DOM is NOT touched — the attributes go onto a
 * detached clone, and the clone's outerHTML is returned. Falls back to
 * `page.content()` when the page cannot evaluate (navigating, detached).
 *
 * Browser-side function is a string expression (this build has no DOM
 * lib; see recorder/pageExtract.ts for the convention).
 */
const SERIALIZE_FN = `(() => {
  const root = document.documentElement;
  if (!root) return "";
  const clone = root.cloneNode(true);
  const liveControls = Array.from(root.querySelectorAll("input, select, textarea"));
  const cloneControls = Array.from(clone.querySelectorAll("input, select, textarea"));
  if (liveControls.length !== cloneControls.length) return root.outerHTML;
  for (let i = 0; i < liveControls.length; i++) {
    const live = liveControls[i];
    const copy = cloneControls[i];
    const tag = live.tagName.toLowerCase();
    if (tag === "select") {
      const liveOptions = Array.from(live.options || []);
      const copyOptions = Array.from(copy.querySelectorAll("option"));
      if (liveOptions.length !== copyOptions.length) continue;
      for (let j = 0; j < liveOptions.length; j++) {
        if (liveOptions[j].selected) copyOptions[j].setAttribute("selected", "selected");
        else copyOptions[j].removeAttribute("selected");
      }
      continue;
    }
    const type = (live.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (live.checked) copy.setAttribute("checked", "checked");
      else copy.removeAttribute("checked");
      continue;
    }
    if (type === "file" || type === "hidden" || type === "password") continue;
    const value = live.value;
    if (tag === "textarea") {
      copy.textContent = value || "";
    } else if (value) {
      copy.setAttribute("value", value);
    } else {
      copy.removeAttribute("value");
    }
  }
  const doctype = document.doctype ? "<!DOCTYPE " + document.doctype.name + ">" : "";
  return doctype + clone.outerHTML;
})()`;

export async function readLiveHtml(page: Page): Promise<string> {
  try {
    const html = await page.evaluate(SERIALIZE_FN);
    if (typeof html === "string" && html.length > 0) return html;
  } catch {
    // fall through to the attribute-only serialization
  }
  return page.content();
}
