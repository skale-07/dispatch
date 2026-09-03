import type { Frame, Locator, Page } from "playwright";
import { performTransition } from "../../browser/transition.js";
import { classifyPage } from "./pageClassify.js";

/**
 * "on the microsoft page it should have easily been able to see, oh im not
 *  on the application page and since i can see clearly theres an apply
 *  button let me click that first" — operator, 2026-08-14.
 *
 * Landing on a posting instead of a form is normal: an Apply click can
 * resolve to the listing page, a deep link can drop on the description, a
 * board can bounce a stale apply URL back to the posting. What was NOT
 * normal is what happened next — the run planned that page as if it were
 * the application, mapped the site's own job-search box to address.country,
 * and spent 100 seconds timing out on it (live: microsoft.eightfold.ai,
 * run aef17b3e).
 *
 * Workday already had this recovery, wired to its own vendor page-kind.
 * Nothing about it is vendor-specific: classify the landing, and if it is
 * a posting, click the Apply control and look again. This is that recovery
 * for every ATS, built on the shared transition primitive so the click gets
 * change-detection, an obstruction-sweep retry, and popup adoption for free.
 *
 * Bounded and honest: at most ADVANCE_CAP hops (a posting that leads to
 * another posting leads nowhere), and if the page is still not a form the
 * caller refuses with the reason named rather than filling the wrong page.
 */

const ADVANCE_CAP = 2;

/**
 * Apply controls in evidence order: explicit apply automation ids first,
 * then accessible-name matches, then a bare link whose text is Apply.
 * Deliberately excludes "Apply filters" / "Apply search" — a listing page's
 * facet controls say Apply too, and clicking one reloads the same listing.
 */
const APPLY_SELECTORS = [
  '[data-automation-id="adventureButton"]',
  '[data-automation-id="applyManually"]',
  'a[href*="apply" i]:not([href*="filter" i])',
  'button[id*="apply" i]',
  '[class*="apply-button" i]',
] as const;

// "without saving" — Gem postings (live nuvo 2026-08-31) offer
// "Apply and save" / "Apply without saving"; only the latter is accepted
// on purpose: same form, no third-party account or data retention.
// "online" (#159, live iCIMS 2026-09-03): the link reads "Apply for this
// job online", which the anchored regex rejected for the trailing word —
// so even once the frame was reachable the control was refused. Scoped to
// the "for this job/role/position" arm; "Apply filters" et al still fail.
const APPLY_TEXT_RE =
  /^\s*apply(\s+now|\s+here|\s+for this (job|role|position)(\s+online)?|\s+without saving|\s+to .{1,32})?\s*$/i;

export type PostingAdvanceResult = {
  /** The page the flow should continue on (a popup, if the click opened one). */
  page: Page;
  /** True when the landing is now something other than a posting. */
  advanced: boolean;
  html: string;
  url: string;
  page_class: string;
  hops: number;
  notes: string[];
};

/**
 * `<a href="…"><button>Apply</button></a>` is invalid HTML employers still
 * ship. Clicking the button (type=button) does not follow the href; click
 * the wrapping link instead.
 */
async function preferHrefAncestor(loc: Locator): Promise<Locator> {
  const alreadyLink = await loc
    .evaluate((el: { tagName: string }) => el.tagName === "A")
    .catch(() => false);
  if (alreadyLink) return loc;
  const wrapped = loc.locator("xpath=./ancestor::a[@href][1]");
  if ((await wrapped.count().catch(() => 0)) > 0) return wrapped.first();
  return loc;
}

function isApplyCtaLabel(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length > 48) return false;
  if (/\b(filter|search|alert|cookie|privacy)\b/i.test(t)) return false;
  return APPLY_TEXT_RE.test(t);
}

/** Visible Apply control a human would click. Exported so fill can wait on it. */
/**
 * #159: iCIMS serves the posting — and its "Apply for this job online"
 * link — from a SAME-ORIGIN child frame, leaving the top document with no
 * fields and no Apply CTA. `page.getByRole` does not descend into frames,
 * so three Rivian apps parked UNKNOWN_LANDING with the application never
 * opened.
 *
 * Hopping by navigation does NOT work here (tried first, live 2026-09-03):
 * the frame URL is the shell's own path plus `?in_iframe=1`, and loading
 * it top-level just re-renders the 276KB shell. Clicking the link INSIDE
 * the frame does work — it navigates the TOP-LEVEL page to the posting's
 * /login application entry, verified live.
 *
 * Same-origin only: a cross-origin ad/tracker frame (doubleclick, live
 * philips) must never be clicked into.
 */
export async function findApplyControlAnyFrame(page: Page) {
  const direct = await findApplyControl(page).catch(() => null);
  if (direct) return direct;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(frame.url()).origin === new URL(page.url()).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) continue;
    const hit = await findApplyControl(frame).catch(() => null);
    if (hit) return { loc: hit.loc, how: `${hit.how} (same-origin iframe)` };
  }
  return null;
}

export async function findApplyControl(page: Page | Frame) {
  // Strict accessible-name tier first. Web-component buttons (UKG's
  // <ukg-button>, live Bennett Thrasher 2026-09-01) render the real
  // <button> in a shadow root and slot the label in from the host: the
  // role engine computes the name "Apply now" from the flattened tree,
  // but the matched node's own innerText/textContent/aria-label are all
  // EMPTY, so the loose tier's self-text re-check can only reject it.
  // When the WHOLE accessible name matches the anchored Apply regex, the
  // role match is the evidence — "Apply filters"/"Apply and save"/"Apply
  // with Indeed" all fail the anchor and never reach here.
  for (const role of ["button", "link"] as const) {
    const strict = page.getByRole(role, { name: APPLY_TEXT_RE });
    const n = Math.min(await strict.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const candidate = strict.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      return {
        loc: await preferHrefAncestor(candidate),
        how: `role=${role} accessible name is Apply`,
      };
    }
  }
  for (const role of ["button", "link"] as const) {
    const named = page.getByRole(role, { name: /^apply\b/i });
    const n = Math.min(await named.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const candidate = named.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label =
        ((await candidate.innerText().catch(() => "")) ?? "") ||
        ((await candidate.getAttribute("aria-label").catch(() => "")) ?? "");
      if (!isApplyCtaLabel(label) && !isApplyCtaLabel(label.split("\n")[0] ?? "")) {
        continue;
      }
      return {
        loc: await preferHrefAncestor(candidate),
        how: `role=${role} "${label.replace(/\s+/g, " ").trim().slice(0, 24)}"`,
      };
    }
  }
  for (const selector of APPLY_SELECTORS) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      return { loc: await preferHrefAncestor(loc), how: selector };
    }
  }
  // Text-based last: scan candidates and require the WHOLE label to be
  // Apply-ish, so "Apply filters" and "How to apply" never match.
  const clickables = page
    .locator("a, button, [role=button]")
    .filter({ visible: true });
  const total = Math.min(await clickables.count().catch(() => 0), 60);
  for (let i = 0; i < total; i++) {
    const candidate = clickables.nth(i);
    const text = (await candidate.textContent().catch(() => "")) ?? "";
    if (isApplyCtaLabel(text)) {
      return {
        loc: await preferHrefAncestor(candidate),
        how: `text "${text.replace(/\s+/g, " ").trim().slice(0, 24)}"`,
      };
    }
  }
  return null;
}

async function inventoryApplyish(page: Page): Promise<string[]> {
  const clickables = page
    .locator("a, button, [role=button], [class*='apply' i]")
    .filter({ visible: true });
  const n = Math.min(await clickables.count().catch(() => 0), 20);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const el = clickables.nth(i);
    const text = ((await el.innerText().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    const cls = (await el.getAttribute("class").catch(() => "")) ?? "";
    if (!/apply/i.test(`${text} ${cls}`)) continue;
    const tag = await el
      .evaluate((node: { tagName: string }) => node.tagName.toLowerCase())
      .catch(() => "?");
    out.push(`${tag} "${text}"`);
  }
  return out;
}

/**
 * If the current page is a posting, click Apply until it is not (or the cap
 * is hit). Fail-open: any error leaves the page exactly where it was and
 * the caller's existing gate decides what to do.
 */
export async function advancePastPosting(input: {
  page: Page;
  html: string;
  url: string;
  settleTimeoutMs?: number;
}): Promise<PostingAdvanceResult> {
  let page = input.page;
  let html = input.html;
  let url = input.url;
  const notes: string[] = [];
  let hops = 0;

  let classification = classifyPage({ html, url });
  if (classification.page_class !== "posting") {
    const applyAnyway =
      classification.page_class === "unknown"
        ? await findApplyControlAnyFrame(page).catch(() => null)
        : null;
    if (!applyAnyway) {
      return {
        page,
        advanced: false,
        html,
        url,
        page_class: classification.page_class,
        hops: 0,
        notes,
      };
    }
    notes.push(
      `unknown landing with a visible Apply control (${applyAnyway.how}) — treating as a posting`,
    );
    classification = {
      page_class: "posting",
      field_count: classification.field_count,
      evidence: `Apply via ${applyAnyway.how} on unknown landing`,
    };
  }

  while (classification.page_class === "posting" && hops < ADVANCE_CAP) {
    const control = await findApplyControlAnyFrame(page).catch(() => null);
    if (!control) {
      const seen = await inventoryApplyish(page).catch(() => []);
      notes.push(
        `posting page (${classification.evidence}) but no Apply control found — not filling the posting` +
          (seen.length > 0
            ? `; visible apply-ish: ${seen.join("; ")}`
            : "; no visible apply-ish controls"),
      );
      break;
    }
    hops += 1;
    notes.push(
      `landed on a posting (${classification.evidence}); clicking Apply via ${control.how}`,
    );
    const transition = await performTransition(page, control.loc, {
      settleTimeoutMs: input.settleTimeoutMs ?? 12_000,
      adoptPopups: true,
      sweepObstructions: true,
    }).catch(() => null);
    if (!transition || !transition.landed) {
      notes.push(
        `Apply click did not change the page${transition ? `: ${transition.notes.join("; ")}` : ""}`,
      );
      break;
    }
    page = transition.page;
    url = transition.url;
    html = transition.html;
    classification = transition.classification;
    notes.push(`Apply landed on: ${classification.page_class} (${classification.evidence})`);
    if (transition.adopted_popup) {
      notes.push("Apply opened a new tab — the flow continues there");
    }
  }

  if (classification.page_class === "posting" && hops >= ADVANCE_CAP) {
    notes.push(
      `still on a posting after ${hops} Apply click(s) — giving up rather than filling the listing page`,
    );
  }

  return {
    page,
    advanced: classification.page_class !== "posting",
    html,
    url,
    page_class: classification.page_class,
    hops,
    notes,
  };
}
