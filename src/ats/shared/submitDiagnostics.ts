import type { Page } from "playwright";

/**
 * Pre-click diagnostics for a disabled submit control. The old behavior —
 * refusing with only "submit control disabled" — was correct but opaque:
 * an in-form email-verification step (Greenhouse "enter the code we
 * emailed you") passes the login-wall gate, passes plan verification
 * (the code input is not in the approved plan), and surfaces only as a
 * greyed-out button. This module names the cause: verification-code
 * inputs, required-but-invalid fields, and visible validation errors.
 * Read-only — it never types or clicks.
 */

export type DisabledSubmitDiagnosis = {
  verification: {
    detected: boolean;
    /** Selector that resolves the code input for the recovery layer. */
    input_selector: string | null;
    prompt_excerpt: string | null;
    /** Mailbox the page claims it mailed, when stated. */
    email_hint: string | null;
  };
  required_invalid: Array<{ label: string; name: string; type: string }>;
  visible_errors: string[];
  summary: string;
};

/**
 * Strong signals first — these name a one-time code unambiguously. The
 * weak tier (anything merely containing "code") is searched only when no
 * strong match exists, and is filtered against fields that legitimately
 * say "code" without being one: zip/postal/area/country/referral/promo.
 */
const STRONG_CODE_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="security_code" i]',
  'input[id*="security_code" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="one_time" i]',
  'input[name*="onetime" i]',
].join(", ");

const WEAK_CODE_SELECTOR = [
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
  'input[aria-label*="code" i]',
].join(", ");

/** "code" fields that are never a one-time code. */
const NOT_A_CODE = /zip|postal|post ?code|area ?code|country|dial|currency|promo|coupon|discount|referral|employee|req(uisition)?|job ?code/i;

const VERIFICATION_TEXT =
  /(verification code|enter (?:the|your) code|sent (?:a|the|you a) (?:verification )?code|code (?:was |has been )?sent|security code|one[- ]time (?:code|passcode)|check your (?:email|inbox) for)/i;

const EMAIL_HINT =
  /(?:sent|emailed|mailed)[^.\n]{0,60}?to\s+([\w.+-]+@[\w-]+\.[\w.-]+)|([\w.+-]+@[\w-]+\.[\w.-]+)[^.\n]{0,40}?(?:for (?:a|the) (?:verification )?code)/i;

export async function diagnoseDisabledSubmit(
  page: Page,
): Promise<DisabledSubmitDiagnosis> {
  // Scan the main frame first, then child frames (first-party embeds keep
  // the form in an iframe), merging results. Live 2026-08-30 TransMarket:
  // the wall was visible in the receipt but the main-frame scan saw
  // nothing — long posting text also pushed the wall sentence past the
  // old 20k innerText cap, so the text window now centers on the wall.
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  let merged: Awaited<ReturnType<typeof scanFrame>> | null = null;
  for (const frame of frames) {
    const s = await scanFrame(frame);
    if (!merged) {
      merged = s;
    } else {
      merged = {
        codeInputs: [...merged.codeInputs, ...s.codeInputs],
        splitBox: merged.splitBox ?? s.splitBox,
        requiredInvalid: [...merged.requiredInvalid, ...s.requiredInvalid],
        errorNodes: [...merged.errorNodes, ...s.errorNodes],
        bodyText: `${merged.bodyText}\n${s.bodyText}`.slice(0, 120_000),
      };
    }
  }
  merged = merged ?? {
    codeInputs: [],
    splitBox: null,
    requiredInvalid: [],
    errorNodes: [],
    bodyText: "",
  };

  // Shadow-DOM fallback (live 2026-08-30 TransMarket: the wall renders in
  // a shadow root — the screenshot shows it, raw querySelector/innerText
  // see NOTHING). Playwright locators pierce shadow roots; when the raw
  // scan came up empty, probe with locators per frame.
  if (!merged.splitBox && merged.codeInputs.length === 0) {
    for (const frame of frames) {
      try {
        const cells = frame.locator('input[maxlength="1"]');
        const n = await cells.count();
        if (n >= 6 && n <= 12) {
          const firstCell = cells.first();
          merged.splitBox = {
            id: (await firstCell.getAttribute("id")) || null,
            name: (await firstCell.getAttribute("name")) || null,
            count: n,
          };
        }
        if (!VERIFICATION_TEXT.test(merged.bodyText)) {
          const wallEl = frame.getByText(VERIFICATION_TEXT).first();
          if ((await wallEl.count()) > 0) {
            const text = ((await wallEl.textContent()) ?? "").slice(0, 2_000);
            merged.bodyText = `${merged.bodyText}\n${text}`.slice(0, 120_000);
          }
        }
        if (merged.splitBox && VERIFICATION_TEXT.test(merged.bodyText)) break;
      } catch {
        // frame detached mid-probe — keep whatever we have
      }
    }
  }

  return buildDiagnosis(merged);
}

/**
 * #245b: this scan runs as a STRING expression, not a compiled callback.
 *
 * The live pipeline runs under tsx, whose esbuild keeps function names by
 * wrapping every named function in a `__name(...)` helper that exists in
 * the Node module and NOT in the page. This body needs helpers
 * (`labelFor` is used from two places, `describe` from two more), so as a
 * compiled callback every call threw `ReferenceError: __name is not
 * defined` — and because the caller `.catch(...)`es into an empty
 * diagnosis, it failed SILENTLY: `diagnoseDisabledSubmit` has been
 * reporting "no code input, no invalid fields, no errors" for every
 * disabled submit, which is exactly the signal the emailed-verification-
 * code recovery depends on. A string is never compiled, so it cannot be
 * rewritten — the same reason requiredCompleteness's scan is a string.
 *
 * The two selectors are interpolated as JSON literals, so the expression
 * takes no arguments.
 */
const DIAGNOSTIC_SCAN_EXPRESSION = `(() => {
  const doc = globalThis.document;
  const all = (s) => Array.from(doc.querySelectorAll(s));
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelFor = (el) => {
    if (el.id) {
      const label = doc.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
      if (label && label.textContent) return label.textContent.trim().slice(0, 120);
    }
    return (
      el.getAttribute("aria-label") ??
      el.getAttribute("placeholder") ??
      el.name ??
      el.id ??
      "?"
    ).slice(0, 120);
  };
  const describe = (el) => ({
    id: el.id || null,
    name: el.name || null,
    autocomplete: el.getAttribute("autocomplete"),
    strong: false,
    // Everything a "is this really an OTP field" filter needs.
    context: [
      labelFor(el),
      el.name ?? "",
      el.id ?? "",
      el.getAttribute("placeholder") ?? "",
      el.getAttribute("aria-label") ?? "",
    ].join(" "),
  });

  const strong = all(${JSON.stringify(STRONG_CODE_SELECTOR)}).filter(visible).map(describe);
  for (const s of strong) s.strong = true;
  const weak = all(${JSON.stringify(WEAK_CODE_SELECTOR)})
    .filter(visible)
    .map(describe)
    .filter((w) => !strong.some((s) => s.id === w.id && s.name === w.name));
  const codeInputs = [...strong, ...weak];

  // Split-box widget: 6-12 visible single-char inputs (live 2026-08-30,
  // TransMarket/job-boards "Security code": 8 bare <input maxlength="1">
  // cells with no code-ish attributes at all - invisible to both selector
  // tiers above; 5 clicks parked UNCERTAIN with the code in the mailbox).
  const singles = all('input[maxlength="1"]').filter(visible);
  const splitBox =
    singles.length >= 6 && singles.length <= 12
      ? { id: singles[0].id || null, name: singles[0].name || null, count: singles.length }
      : null;

  const requiredInvalid = all("input[required], select[required], textarea[required]")
    .filter(visible)
    .filter((el) => {
      if (el.getAttribute("aria-invalid") === "true") return true;
      try {
        return el.checkValidity ? !el.checkValidity() : false;
      } catch (e) {
        return false;
      }
    })
    .slice(0, 15)
    .map((el) => ({
      label: labelFor(el),
      name: el.name || el.id || "?",
      type: el.type || el.tagName.toLowerCase(),
    }));

  const errorNodes = all(
    '[role="alert"], .error, .field-error, .validation-error, [class*="error-message" i]',
  )
    .filter(visible)
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t.length > 0 && t.length < 300)
    .slice(0, 10);

  // Center the text window on the wall wording when it sits deep in a long
  // posting page (the old flat 20k cap cut it off).
  const full = (doc.body && doc.body.innerText) || "";
  const wallIdx = full.search(/verification code|security code|one[- ]time code/i);
  const bodyText =
    wallIdx >= 0
      ? full.slice(Math.max(0, wallIdx - 2000), wallIdx + 4000)
      : full.slice(0, 20000);
  return { codeInputs, splitBox, requiredInvalid, errorNodes, bodyText };
})()`;

/** What DIAGNOSTIC_SCAN_EXPRESSION returns (a string expression carries no types). */
type DiagnosticScan = {
  codeInputs: Array<{
    id: string | null;
    name: string | null;
    autocomplete: string | null;
    strong: boolean;
    context: string;
  }>;
  splitBox: { id: string | null; name: string | null; count: number } | null;
  requiredInvalid: Array<{ label: string; name: string; type: string }>;
  errorNodes: string[];
  bodyText: string;
};

async function scanFrame(page: Pick<Page, "evaluate">): Promise<DiagnosticScan> {
  const scan = await (page.evaluate(DIAGNOSTIC_SCAN_EXPRESSION) as Promise<DiagnosticScan>)
    .catch(() => ({
      codeInputs: [] as Array<{
        id: string | null;
        name: string | null;
        autocomplete: string | null;
        strong: boolean;
        context: string;
      }>,
      splitBox: null as { id: string | null; name: string | null; count: number } | null,
      requiredInvalid: [] as Array<{ label: string; name: string; type: string }>,
      errorNodes: [] as string[],
      bodyText: "",
    }));
  return scan;
}

function buildDiagnosis(
  scan: Awaited<ReturnType<typeof scanFrame>>,
): DisabledSubmitDiagnosis {
  const textMatch = scan.bodyText.match(VERIFICATION_TEXT);
  // Strong matches win; weak ones ("…code…" anywhere) are accepted only
  // after discarding fields that say "code" for other reasons, so a
  // "Zip code" input can never become the target we type a mailbox code
  // into.
  const first =
    scan.codeInputs.find((c) => c.strong) ??
    scan.codeInputs.find((c) => !NOT_A_CODE.test(c.context));
  // A code input plus verification wording is high confidence; wording
  // alone (input not yet matched) still gets named in the summary. A
  // split-box group (bare maxlength=1 cells) counts as the input when the
  // wording is present — the recovery layer already types across boxes.
  const splitBoxHit = !first && scan.splitBox && Boolean(textMatch);
  const detected = (Boolean(first) || Boolean(splitBoxHit)) && Boolean(textMatch);
  let inputSelector: string | null = null;
  if (first) {
    if (first.id) inputSelector = `#${first.id.replace(/([^\w-])/g, "\\$1")}`;
    else if (first.name) inputSelector = `input[name="${first.name}"]`;
    else if (first.autocomplete === "one-time-code") {
      inputSelector = 'input[autocomplete="one-time-code"]';
    }
  } else if (splitBoxHit && scan.splitBox) {
    inputSelector = scan.splitBox.id
      ? `#${scan.splitBox.id.replace(/([^\w-])/g, "\\$1")}`
      : scan.splitBox.name
        ? `input[name="${scan.splitBox.name}"]`
        : 'input[maxlength="1"]';
  }
  const emailMatch = scan.bodyText.match(EMAIL_HINT);
  // Sentence-final addresses come back with the period attached.
  const emailHint =
    (emailMatch?.[1] ?? emailMatch?.[2])?.replace(/[.,;:]+$/, "") ?? null;

  const parts: string[] = [];
  if (detected) {
    parts.push(
      `email verification code required${emailHint ? ` (sent to ${emailHint})` : ""}${
        splitBoxHit && scan.splitBox
          ? ` — split-box widget (${scan.splitBox.count} cells)`
          : ""
      }`,
    );
  } else if (textMatch) {
    parts.push(`verification wording present ("${textMatch[0]}") but no code input matched`);
  }
  if (scan.requiredInvalid.length > 0) {
    parts.push(
      `${scan.requiredInvalid.length} required field(s) invalid: ${scan.requiredInvalid
        .map((f) => f.label)
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  if (scan.errorNodes.length > 0) {
    parts.push(`visible errors: ${scan.errorNodes.slice(0, 3).join(" | ")}`);
  }
  if (parts.length === 0) {
    parts.push("no verification prompt, invalid required fields, or visible errors found");
  }

  return {
    verification: {
      detected,
      input_selector: detected ? inputSelector : null,
      prompt_excerpt: textMatch?.[0] ?? null,
      email_hint: emailHint,
    },
    required_invalid: scan.requiredInvalid,
    visible_errors: scan.errorNodes,
    summary: parts.join("; "),
  };
}
