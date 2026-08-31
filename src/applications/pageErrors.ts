import type { Page } from "playwright";

/**
 * #66a (operator directive 2026-08-31): every application platform paints
 * its OWN validation errors — a banner, inline per-field messages, an
 * "N errors found" summary — and the fill layer must read them wherever
 * it runs, not per-vendor. This collector is platform-neutral:
 *
 *   - [role='alert'] / [aria-live='assertive'] visible text
 *   - fields marked [aria-invalid='true'], named by their nearest label,
 *     with their aria-describedby message when one exists
 *   - visible nodes whose id/class says "error"/"invalid" (bounded and
 *     length-filtered so page chrome cannot flood the notes)
 *
 * Vendor-SPECIFIC hooks (Workday data-automation-id containers, etc.)
 * come in via `extraSelectors`, sourced from that ATS's selector
 * registry — the registry rule keeps them out of flow code and out of
 * this module. Read-only; failures never throw.
 *
 * The page-side code ships as a string expression: src/ compiles without
 * DOM libs, and Playwright evaluates the string in the browser context
 * (same pattern as requiredCompleteness.ts).
 */
export async function readPageValidationErrors(
  page: Page,
  opts: { extraSelectors?: string[] } = {},
): Promise<string[]> {
  const extra = (opts.extraSelectors ?? []).join(", ");
  const script = `((extraSel) => {
    const seen = new Set();
    const errors = [];
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const push = (prefix, text) => {
      const t = String(text ?? "").replace(/\\s+/g, " ").trim().slice(0, 200);
      if (!t || t.length < 3) return;
      const key = prefix + "|" + t;
      if (seen.has(key)) return;
      seen.add(key);
      errors.push(prefix ? prefix + ": " + t : t);
    };

    const alertSel = "[role='alert'], [aria-live='assertive']" + (extraSel ? ", " + extraSel : "");
    for (const el of Array.from(document.querySelectorAll(alertSel))) {
      if (!visible(el)) continue;
      push("", el.innerText);
    }

    for (const el of Array.from(document.querySelectorAll("[aria-invalid='true']"))) {
      if (!visible(el)) continue;
      const forLabel = el.id ? document.querySelector("label[for=\\"" + CSS.escape(el.id) + "\\"]") : null;
      const labelled = forLabel
        ?? el.closest("label")
        ?? (el.closest("fieldset") ? el.closest("fieldset").querySelector("legend, label") : null);
      const name = String(
        (labelled && labelled.textContent)
          ?? el.getAttribute("aria-label")
          ?? el.getAttribute("name")
          ?? el.id
          ?? "(unlabeled)",
      ).replace(/\\s+/g, " ").trim().slice(0, 60);
      const describedBy = String(el.getAttribute("aria-describedby") ?? "")
        .split(/\\s+/)
        .map((id) => {
          const d = id ? document.getElementById(id) : null;
          return d ? d.innerText : "";
        })
        .join(" ")
        .trim();
      push("field \\"" + name + "\\"", describedBy || "invalid (aria-invalid)");
    }

    // Generic error-classed nodes: short visible texts only — a page that
    // styles a whole section "error" must not flood the notes.
    const classed = Array.from(document.querySelectorAll(
      "[class*='error' i]:not([class*='error-boundary' i]), [id*='error' i], [class*='invalid' i]",
    )).slice(0, 60);
    for (const el of classed) {
      if (!visible(el)) continue;
      const t = String(el.innerText ?? "").trim();
      if (t.length === 0 || t.length > 200) continue;
      push("", t);
    }

    return errors.slice(0, 12);
  })(${JSON.stringify(extra)})`;
  return page
    .evaluate(script)
    .then((v) => (Array.isArray(v) ? (v as string[]) : []))
    .catch(() => [] as string[]);
}
