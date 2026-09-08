import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";

/**
 * Vendor-blind page classification — the answer to "where did that click
 * actually land?". The building blocks (login-wall detection, CAPTCHA
 * detection, field counting, confirmation markers) all existed separately;
 * every transition used to discover a wrong landing indirectly, far from
 * the click that caused it (gate refusal, empty plan, verify miss). One
 * classifier, asserted right at the transition, names the landing
 * immediately.
 *
 * Order matters: captcha and auth walls dominate (a login page can carry
 * stray inputs — a password field is auth, even if an email box is also
 * present), confirmation beats form (thank-you pages keep search boxes),
 * and Apply without applicant identity is a posting.
 *
 * Form identity is disjunctive, not "first + last + resume". Wizard step 1
 * is often name+email with the resume on step 2; Lever uses one Full Name
 * field. Requiring the full contact block classifies real forms as unknown.
 * The listing-page discriminator is the one Eightfold taught: Apply CTA
 * plus none of the inputs asking who you are.
 */
export type PageClass =
  | "captcha"
  | "auth"
  | "confirmation"
  | "form"
  | "posting"
  | "unknown";

export type PageClassification = {
  page_class: PageClass;
  field_count: number;
  evidence: string;
};

// "application for <role> has been received" — Gem's receipt card (live
// nuvo 2026-08-31) names the role between the words; a bounded gap plus
// optional "has been" covers that class without loosening the anchor words.
const GENERIC_CONFIRMATION_RE =
  /thank you for (applying|your application)|application (for .{1,80}? )?(has been |was )?(submitted|received|complete)|you(?:'ve| have) successfully (applied|submitted)/i;

/**
 * #182 (live Stripe 2026-09-07): Greenhouse's job-boards embed ships the
 * posting's post-submit `confirmation_message` ("Thank you for applying.")
 * inside its Remix bootstrap `<script>` on the UNSUBMITTED form. Any
 * confirmation marker tested against raw HTML therefore fires on a blank
 * application form — the supervisor stopped on "page is confirmation" and
 * the fill parked FORM_NOT_FOUND. Markers must only ever see markup that
 * can render: strip script / style / noscript / template bodies first.
 * Shared by the classifier and every ATS submit verifier.
 */
export function renderedMarkup(html: string): string {
  return html.replace(
    /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
}

const APPLY_CTA_RE =
  /\bapply(?:\s+now)?\b[^<]{0,40}<|data-automation-id=["']adventureButton["']|>\s*apply\s*</i;

/**
 * Does this field set belong to something asking for an APPLICANT? Name,
 * email, phone or a resume upload — the questions every application form
 * asks and no listing page's search chrome ever does.
 *
 * Deliberately checks the label AND the machine name: a listing page's
 * "City, state, or country/region" search box maps to an address alias but
 * is not identity, so location is not on this list.
 */
export function hasApplicationIdentityFields(
  fields: Array<{ label: string; name?: string | undefined; type: string }>,
): boolean {
  return fields.some((f) => {
    const blob = `${f.label} ${f.name ?? ""}`.toLowerCase();
    if (/\b(search|keyword|job title, id)\b/.test(blob)) return false;
    // type=email is identity even when the label is an ASP.NET machine
    // name (`ctl00$txtContact`). `\be-?mail\b` misses those concatenations.
    if (f.type === "email") return true;
    return (
      /\be-?mail\b/.test(blob) ||
      /\bfirst[\s_-]*name\b|\blast[\s_-]*name\b|\bfull[\s_-]*name\b|\byour name\b/.test(
        blob,
      ) ||
      /\bphone\b|\bmobile number\b/.test(blob) ||
      (f.type === "file" && /resume|cv|cover[\s_-]*letter/.test(blob))
    );
  });
}

/**
 * The URL is already the application, not the job listing. Paylocity
 * (live 2026-08-19): `/Recruiting/Jobs/Details/4429441` → click Apply →
 * `/Recruiting/Jobs/Apply/4429441`. The apply wizard keeps an "Apply"
 * header link and uses opaque field names, so the listing discriminator
 * (Apply CTA + no identity label) would keep calling it a posting and
 * park FORM_NOT_REACHED on the real form.
 *
 * Segment-bounded: `/apply-filters` and `/easy-apply-tips` do not match.
 */
export function isApplicationFormPath(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /\/(jobs\/)?apply(\/|$)/.test(path) || /\/application(\/|$)/.test(path);
}

/**
 * #166 (live Rivian iCIMS 2026-09-04): the top document is an empty shell
 * and the real page lives in a SAME-ORIGIN child frame. Apply landed on
 * `…/software-engineering-intern…/login`, title "Login" — an iCIMS sign-in
 * wall — but the login form is inside `icims_content_iframe`, so the outer
 * HTML had no password input, no heading and no fields.
 * detectLoginWall scored 3 (final_url_auth_path alone; the >=5 HIGH bar
 * needs a second signal), classifyPage returned `unknown`, and the gate
 * parked UNKNOWN_LANDING — which also meant `tryPortalAuth` never fired,
 * because that is keyed on page_class === "auth". #159 already taught
 * advancePastPosting to look one frame down for an Apply control; the
 * classifier never learned the same lesson.
 *
 * Only ever promotes an `unknown` with NO fields of its own, and only to
 * the classes that end in a refusal or the auth path — never to `form` or
 * `posting`, because the fill and the Apply walk act on the TOP document
 * and would then be typing into the wrong one. A frame-served form is
 * reported in the evidence so the artifact names it, and nothing else
 * changes.
 *
 * Same-origin only: a cross-origin chat widget or ad iframe is page
 * furniture, not the landing.
 */
export function classifyWithFrameFallback(
  outer: PageClassification,
  frames: Array<{ url: string; html: string }>,
): PageClassification {
  if (outer.page_class !== "unknown" || outer.field_count > 0) return outer;
  for (const frame of frames) {
    const inner = classifyPage({ html: frame.html, url: frame.url });
    if (
      inner.page_class === "auth" ||
      inner.page_class === "captcha" ||
      inner.page_class === "confirmation"
    ) {
      return {
        page_class: inner.page_class,
        field_count: inner.field_count,
        evidence: `${inner.evidence} (in same-origin child frame ${frame.url.slice(0, 120)})`,
      };
    }
    if (inner.page_class === "form" || inner.page_class === "posting") {
      // Named, not adopted — see above.
      return {
        ...outer,
        evidence: `${outer.evidence}; a same-origin child frame looks like a ${inner.page_class} (${inner.field_count} field(s)): ${frame.url.slice(0, 120)}`,
      };
    }
  }
  return outer;
}

/** Same-origin child frames of `pageUrl`, newest read first. */
export function sameOriginFrames(
  pageUrl: string,
  frames: Array<{ url: string; html: string }>,
): Array<{ url: string; html: string }> {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  return frames.filter((f) => {
    if (!f.url || f.url === "about:blank" || f.url === pageUrl) return false;
    try {
      return new URL(f.url).origin === origin;
    } catch {
      return false;
    }
  });
}

export function classifyPage(input: {
  html: string;
  url: string;
  title?: string;
  /** Per-ATS confirmation markers (selector registries) widen the generic set. */
  confirmationMarkers?: RegExp;
}): PageClassification {
  const { html, url } = input;
  const title = input.title ?? "";
  const fields = discoverFieldsFromHtml(html);
  const fieldCount = fields.length;

  const captcha = detectBlockingCaptcha({
    finalUrl: url,
    html,
    title,
    formDetected: fieldCount > 0,
    fieldCount,
  });
  if (captcha.detected) {
    return {
      page_class: "captcha",
      field_count: fieldCount,
      evidence: `captcha: ${captcha.signals.join(",")}`,
    };
  }

  const wall = detectLoginWall({ finalUrl: url, html, title });
  if (wall.detected) {
    return {
      page_class: "auth",
      field_count: fieldCount,
      evidence: `login wall: ${wall.signals.join(",")}`,
    };
  }

  const markup = renderedMarkup(html);
  const confirmed =
    (input.confirmationMarkers?.test(markup) ?? false) ||
    GENERIC_CONFIRMATION_RE.test(markup);
  if (confirmed) {
    return {
      page_class: "confirmation",
      field_count: fieldCount,
      evidence: "confirmation markers matched",
    };
  }

  // "Has inputs" is NOT "is an application form". Live 2026-08-14
  // (microsoft.eightfold.ai): the JOB LISTING page carried the site's own
  // search widgets — "Search by job title, ID, or keyword" and "City,
  // state, or country/region" — so fieldCount was 5, the page classified
  // as a form, and the run typed "United States" into a job-search box
  // while a plain "Apply now" button sat unclicked. A human saw it
  // instantly: wrong page, click Apply first.
  //
  // The discriminator is what the fields ARE. Every real application form
  // asks who you are; a listing page's search chrome never does. So an
  // Apply CTA plus no identity field means posting, however many inputs
  // the page's furniture contributes — unless the URL path is already
  // /apply. Leftover Apply chrome on that path is the wizard header, not
  // a listing still waiting to be clicked.
  // Script/JSON blobs contain "apply" constantly (`{"apply":true}`). That
  // is not an Apply button. Jump Trading 2026-08-17: regex said posting,
  // findApplyControl found nothing, fill refused in 4s.
  const visibleHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const hasCta = APPLY_CTA_RE.test(visibleHtml);
  const onApplyPath = isApplicationFormPath(url);
  if (fieldCount > 0) {
    if (
      hasCta &&
      !hasApplicationIdentityFields(fields) &&
      !onApplyPath
    ) {
      return {
        page_class: "posting",
        field_count: fieldCount,
        evidence: `Apply CTA present and none of the ${fieldCount} field(s) ask who you are — page furniture, not an application`,
      };
    }
    return {
      page_class: "form",
      field_count: fieldCount,
      evidence: `${fieldCount} fillable field(s)`,
    };
  }

  if (hasCta) {
    return {
      page_class: "posting",
      field_count: 0,
      evidence: "no fields, Apply CTA present",
    };
  }

  return { page_class: "unknown", field_count: 0, evidence: "no signals matched" };
}
