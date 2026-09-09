import type { Locator, Page } from "playwright";

/**
 * Structured, human-readable diagnosis of an employer login wall
 * (operator request 2026-08-12: "add more detailed logging/detection so
 * you and I can break down what's really happening when it hits a login
 * wall"). Zero mutation — this only reads the page.
 *
 * The value is the SHAPE: which inputs exist, which submit control, what
 * federated buttons are offered, whether a create-account route is
 * present, and whether the page is reporting an error. Every live wall we
 * park on writes one of these into the nav report, so the next fix is
 * driven by the actual DOM instead of a guess.
 *
 * Selectors here are intentionally generic (type/name/autocomplete +
 * accessible names), because this runs on ANY employer portal — Amazon,
 * ByteDance, Workday tenants — not one known vendor.
 */

export type LoginWallDiagnosis = {
  url: string;
  host: string;
  /** Inputs the page exposes, by role. */
  fields: {
    email: boolean;
    password: boolean;
    confirmPassword: boolean;
    otherVisibleInputs: number;
  };
  /** Accessible names of the submit-ish controls, in DOM order (capped). */
  submitControls: string[];
  /** "Login with Google/Apple/LinkedIn/Amazon" style buttons. */
  federatedProviders: string[];
  /** A visible route to account creation ("Create an Amazon.jobs account"). */
  createAccountRoute: string | null;
  /** Page text that reads like a rejected credential / needs-verification. */
  errorText: string | null;
  /** What the flow should do next, derived from the above. */
  classification:
    | "sign_in_form"
    | "create_account_form"
    | "federated_only"
    | "credentials_rejected"
    /**
     * The portal says the account is locked / too many attempts. Not a
     * wrong password (escalating to create-account would fail "already
     * exists") and not retryable inside a run — park with this named.
     * Live 2026-08-30 huntington.wd12 after repeated sign-in attempts.
     */
    | "account_locked"
    | "no_form_found";
};

const LOCK_RE =
  /account (?:is|has been) (?:temporarily )?locked|locked out|too many (?:failed |unsuccessful )?(?:sign[- ]?in |login |log in )?attempts|temporarily (?:blocked|disabled|suspended)|try again (?:in|after) \d+ (?:minutes?|hours?)/i;

const FEDERATED_RE =
  /(sign|log)\s?in with|continue with|login with|use your .{0,40}account/i;
const CREATE_ROUTE_RE =
  /create an? .{0,40}account|create account|sign up|new to /i;
// Live huntington.wd12 (2026-08-30): Workday's rejection reads "You may
// have entered the wrong email address or password or your account might
// be locked." — "wrong password" never matched it, the wall "remained" and
// the documented create-account escalation never ran.
// #163 (live alcon.wd5 2026-09-03): the sign-in answer "Verify your account
// before you sign in or request a verification email." sat in Workday's own
// errorMessage container and was NOT an error to this regex — the poll ran
// to its deadline, the run called the sign-in "silent" and took the Create
// Account route instead of the mailbox.
const ERROR_RE =
  /incorrect|invalid|doesn'?t match|does not match|no account|can'?t find|couldn'?t find|not recognized|try again|must be verified|verify your (?:email|account)|request a verification email|account (?:is )?not (?:yet )?verified|wrong (?:email(?: address)?(?: or)?\s*)?password|wrong email|might be locked|unable to sign in|sign[- ]in failed|already (?:exists|in use|registered|taken)/i;
/** Vendor error containers read before the body text (Workday's errorMessage). */
const ERROR_CONTAINER_SELECTOR =
  "[data-automation-id='errorMessage'], [data-automation-id='alertMessage'], [role='alert']";

/**
 * Which of the portal's stated password rules the candidate password does
 * NOT satisfy. Live huntington.wd12 (2026-08-30): the Create Account page
 * lists "A numeric character / A minimum of 8 characters / A special
 * character / A lowercase character / An uppercase character"; the
 * standing PORTAL_LOGIN_PASSWORD had no digit and no lowercase letter, and
 * Workday's Create Account click silently did nothing — no error text,
 * form unchanged — for three runs. Read the rules, check before clicking,
 * and park with the exact gap instead of "wall remains". Pure; a page that
 * states no rules yields no gaps.
 */
export function passwordPolicyGaps(pageText: string, password: string): string[] {
  const t = pageText.replace(/\s+/g, " ");
  const gaps: string[] = [];
  const rule = (re: RegExp) => re.test(t);
  if (rule(/\b(?:a )?(?:numeric|number|digit)s?\b/i) && !/\d/.test(password)) gaps.push("numeric character");
  if (rule(/\blower ?case\b/i) && !/[a-z]/.test(password)) gaps.push("lowercase character");
  if (rule(/\bupper ?case\b/i) && !/[A-Z]/.test(password)) gaps.push("uppercase character");
  if (rule(/\b(?:special character|symbol)s?\b/i) && !/[^A-Za-z0-9]/.test(password)) gaps.push("special character");
  const min = t.match(/(?:minimum of|at least|min(?:imum)?\.?)\s*(\d{1,2})\s*characters?/i);
  if (min && password.length < Number(min[1])) gaps.push(`minimum of ${min[1]} characters`);
  const max = t.match(/(?:maximum of|at most|no more than)\s*(\d{2,3})\s*characters?/i);
  if (max && password.length > Number(max[1])) gaps.push(`maximum of ${max[1]} characters`);
  return gaps;
}

/**
 * #217 (live redhat.wd5, day28): the standing password failed a tenant's
 * "minimum of 14 characters" rule and the row parked for the operator.
 * Every Workday tenant states its own policy, so a per-host password that
 * satisfies the STATED rules is derived from the standing one — same
 * secret the operator chose, extended deterministically (digit, cases,
 * symbol, then padding to the minimum) — and the caller stores it in the
 * per-host vault exactly as an operator `accounts:set` would. Returns null
 * when no derivation satisfies the page (e.g. a maximum shorter than the
 * standing password), so the caller still parks with the exact gap.
 */
export function deriveCompliantPassword(pageText: string, standing: string): string | null {
  let candidate = standing;
  const gaps = passwordPolicyGaps(pageText, candidate);
  if (gaps.length === 0) return candidate;
  if (gaps.some((g) => g.startsWith("numeric"))) candidate += "7";
  if (gaps.some((g) => g.startsWith("lowercase"))) candidate += "q";
  if (gaps.some((g) => g.startsWith("uppercase"))) candidate += "Q";
  if (gaps.some((g) => g.startsWith("special"))) candidate += "!";
  const min = gaps.find((g) => g.startsWith("minimum of"));
  if (min) {
    const n = Number(min.match(/\d+/)?.[0] ?? 0);
    const pad = "Zq7!";
    while (candidate.length < n) candidate += pad[candidate.length % pad.length];
  }
  return passwordPolicyGaps(pageText, candidate).length === 0 ? candidate : null;
}

/**
 * Every way a portal names its email/username input. Live Workday
 * (huntington.wd12, 2026-08-30): `<input type="text" autocomplete="email"
 * data-automation-id="email">` — no type=email, no name/id with "email" —
 * so the old list read `email=false` and the sign-in was never typed.
 */
export const EMAIL_INPUT_SELECTOR =
  "input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete='username'], input[autocomplete='email'], input[name*='user' i], input[data-automation-id='email'], input[data-automation-id='userName'], input[aria-label*='email' i], input[placeholder*='email' i]";

/** Honeypots a portal plants for robots; never read as a field, never filled. */
export const HONEYPOT_INPUT_SELECTOR =
  "input[data-automation-id='beecatcher'], input[name='website']";

/**
 * Where the auth form actually lives. Workday opens Sign In as a modal
 * `[role=dialog]` ON TOP of the Create Account form (both stay in the
 * DOM): page-wide counting saw three password inputs and kept classifying
 * the wall as create_account_form after the flip, and the first visible
 * submit belonged to the form BEHIND the modal. When a visible dialog
 * holds a password input, that dialog is the scope; otherwise the page.
 */
export async function authScope(page: Page): Promise<Page | Locator> {
  const dialogs = page.locator("[role='dialog'], dialog");
  const n = await dialogs.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible().catch(() => false))) continue;
    if ((await d.locator("input[type='password']").count().catch(() => 0)) > 0) return d;
  }
  return page;
}

export async function diagnoseLoginWall(page: Page): Promise<LoginWallDiagnosis> {
  const url = page.url();
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const root = await authScope(page);

  const visible = async (selector: string): Promise<boolean> => {
    const loc = root.locator(selector).first();
    return (
      (await loc.count().catch(() => 0)) > 0 &&
      (await loc.isVisible().catch(() => false))
    );
  };

  const email = await visible(EMAIL_INPUT_SELECTOR);
  const passwordLocs = root.locator("input[type='password']");
  const passwordCount = await passwordLocs.count().catch(() => 0);
  const confirmPassword = passwordCount > 1;

  const otherVisibleInputs = await root
    .locator(`input:not([type='hidden']):not(${HONEYPOT_INPUT_SELECTOR.replace(/, /g, "):not(")})`)
    .count()
    .catch(() => 0);

  const names = async (role: "button" | "link"): Promise<string[]> => {
    const out: string[] = [];
    const all = await root.getByRole(role).all().catch(() => []);
    for (const el of all.slice(0, 40)) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => null)) ?? "").trim();
      const aria = ((await el.getAttribute("aria-label").catch(() => null)) ?? "").trim();
      const name = (text || aria).replace(/\s+/g, " ").slice(0, 60);
      if (name) out.push(name);
    }
    return out;
  };
  const buttonNames = await names("button");
  const linkNames = await names("link");
  const allNames = [...buttonNames, ...linkNames];

  const submitControls = buttonNames
    .filter((n) => /sign in|log ?in|continue|submit|next|create account/i.test(n))
    .slice(0, 6);
  const federatedProviders = allNames
    .filter((n) => FEDERATED_RE.test(n))
    .slice(0, 6);
  const createAccountRoute =
    allNames.find((n) => CREATE_ROUTE_RE.test(n) && !FEDERATED_RE.test(n)) ?? null;

  const bodyText = await (root === page
    ? page.innerText("body", { timeout: 3_000 })
    : (root as Locator).innerText({ timeout: 3_000 })
  )
    .then((t) => t.slice(0, 3_000))
    .catch(() => "");
  const containerText = (
    await root
      .locator(ERROR_CONTAINER_SELECTOR)
      .allInnerTexts()
      .catch(() => [] as string[])
  )
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0 && ERROR_RE.test(t))
    .join(" | ")
    .slice(0, 240);
  const errorMatch = bodyText.match(ERROR_RE);
  const errorText = containerText
    ? containerText
    : errorMatch
      ? bodyText
          .slice(Math.max(0, (errorMatch.index ?? 0) - 60), (errorMatch.index ?? 0) + 120)
          .replace(/\s+/g, " ")
          .trim()
      : null;

  const hasPassword = passwordCount > 0;
  const lockMatch = bodyText.match(LOCK_RE);
  const lockedText = lockMatch
    ? bodyText
        .slice(Math.max(0, (lockMatch.index ?? 0) - 60), (lockMatch.index ?? 0) + 140)
        .replace(/\s+/g, " ")
        .trim()
    : null;
  const classification: LoginWallDiagnosis["classification"] = lockedText
    ? "account_locked"
    : errorText
    ? "credentials_rejected"
    : confirmPassword
      ? "create_account_form"
      : email && hasPassword
        ? "sign_in_form"
        : federatedProviders.length > 0
          ? "federated_only"
          : "no_form_found";

  return {
    url,
    host,
    fields: { email, password: hasPassword, confirmPassword, otherVisibleInputs },
    submitControls,
    federatedProviders,
    createAccountRoute,
    errorText: lockedText ?? errorText,
    classification,
  };
}

/** One-line human summary for logs and nav-report notes. */
export function summarizeLoginWall(d: LoginWallDiagnosis): string {
  const bits = [
    `login wall on ${d.host}: ${d.classification}`,
    `fields[email=${d.fields.email} password=${d.fields.password} confirm=${d.fields.confirmPassword}]`,
  ];
  if (d.submitControls.length > 0) {
    bits.push(`submit=[${d.submitControls.join(" | ")}]`);
  }
  if (d.federatedProviders.length > 0) {
    bits.push(`federated=[${d.federatedProviders.join(" | ")}]`);
  }
  if (d.createAccountRoute) bits.push(`create-route="${d.createAccountRoute}"`);
  if (d.errorText) bits.push(`error="${d.errorText.slice(0, 120)}"`);
  return bits.join("; ");
}
