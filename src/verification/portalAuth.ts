import type { Locator, Page } from "playwright";
import { assertNavigationAllowed } from "../navigation/navigationGuards.js";
import { isTrustedWorkdayHost } from "../ats/workday/urlValidation.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { prepareCredentialsForHost } from "./accountCredentials.js";
import { getAccount, setAccount } from "../accounts/vault.js";
import {
  authBudgetExhausted,
  clearAuthFailures,
  recordAuthFailure,
} from "./authAttemptBudget.js";
import { dismissPageObstructions } from "../browser/obstructions.js";
import { getConfig } from "../config/index.js";
import {
  EMAIL_INPUT_SELECTOR,
  authScope,
  diagnoseLoginWall,
  passwordPolicyGaps,
  summarizeLoginWall,
  type LoginWallDiagnosis,
} from "./loginWallDiagnosis.js";
import {
  resolveNavVerificationWaiter,
  type NavVerificationWaiter,
} from "./emailVerification.js";
import { verificationEvidencePresent } from "../navigation/runNavigation.js";
import { performTransition } from "../browser/transition.js";
import { recordTransitionOutcome } from "../storage/transitionOutcomes.js";

/**
 * Deterministic ATS portal auth (operator directive 2026-08-11): when a
 * recognized ATS host shows a sign-in / create-account wall, ALWAYS
 * authenticate with the standing candidate email (the same mailbox the
 * verification scanner reads) and PORTAL_LOGIN_PASSWORD —
 * sign in when an account already exists, create it otherwise,
 * and complete emailed verification ONLY when the page asks for it.
 *
 * Workday posting pages (Crowe live 2026-08-14, operator screenshots):
 *   Apply → "Start Your Application" modal → Apply Manually →
 *   Create Account form with "Already have an account? Sign In".
 * Portal auth must click that sequence BEFORE it looks for inputs.
 * Autofill-with-resume is never the unattended path.
 *
 * Hard rails:
 *   - Host gate: standing credentials (PORTAL_LOGIN_*) authorize any
 *     https employer host the apply flow reaches. Without them, only
 *     recognized ATS families and vault-seeded hosts qualify. jobright is
 *     never credentialed, and a form must actually be present.
 *   - Passwords/codes ride memory only — never notes.
 *   - Bounded: Apply + Apply Manually + one Sign In flip + one
 *     create/sign-in attempt + one mailbox poll cycle.
 *   - Guarded by NAVIGATION_ENABLED.
 */

export type PortalAuthOutcome = {
  status:
    | "signed_in"
    | "account_created"
    | "wall_remains"
    | "not_an_auth_wall"
    | "refused";
  verification_used: boolean;
  /** Whether an account was created after the sign-in was rejected. */
  escalated_to_create: boolean;
  /** Zero-mutation read of the wall's shape (logged + artifacted). */
  diagnosis: LoginWallDiagnosis | null;
  notes: string[];
  /** Secrets touched during the flow — callers scrub artifacts with these. */
  secrets: string[];
};

export type PortalAuthSeams = {
  waiter?: NavVerificationWaiter | null;
  emailOverride?: string;
  /** Settle wait between actions (tests pass 0). */
  settleMs?: number;
};

/**
 * Where portal auth may type credentials. Two ways in, both explicit:
 *   1. a recognized ATS host family (Workday tenants today), or
 *   2. a host the OPERATOR seeded in the vault themselves
 *      (`accounts:set --host ...`) — storing a login for a host IS the
 *      authorization to use it there, and reuse-only means nothing is
 *      ever minted for an unrecognized host.
 * Everything else is refused: "a page said Sign In" is never enough.
 */
export function isRecognizedAtsAuthHost(url: string): boolean {
  if (isTrustedWorkdayHost(url)) return true;
  let host: string;
  let parsed: URL;
  try {
    parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\.)jobright\.ai$/i.test(host)) return false;
  // Loopback = the operator's own sandbox (src/sandbox/server.ts): the
  // https transport requirement protects nothing on 127.0.0.1, and
  // recognizing it lets the operator rehearse the account-creation /
  // sign-in flow locally with the same PORTAL_LOGIN_* credentials the
  // live portals use.
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (
    getConfig().portalLoginPassword &&
    (parsed.protocol === "https:" || isLoopback)
  ) {
    return true;
  }
  return getAccount(host) !== null;
}

/** How long a portal may take to answer a sign-in / create click before we read the wall. */
const AUTH_RESPONSE_WAIT_MS = 8_000;

/**
 * The portal's explicit "this account exists" answer to a create attempt —
 * the only sanctioned reason to sign in on a host with no vault record
 * (#64, operator directive 2026-08-30). Static page text ("Already have
 * an account?") must NOT match; these are error phrasings only.
 */
const ACCOUNT_EXISTS_RE =
  /already (?:exists|in use|registered|taken)|account with this email/i;

async function firstVisible(page: Page | Locator, selector: string): Promise<Locator | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;
  if (!(await loc.isVisible().catch(() => false))) return null;
  return loc;
}

async function visibleNamed(
  page: Page | Locator,
  name: RegExp,
  roles: Array<"button" | "link"> = ["button", "link"],
): Promise<Locator | null> {
  for (const role of roles) {
    const c = page.getByRole(role, { name }).first();
    if (
      (await c.count().catch(() => 0)) > 0 &&
      (await c.isVisible().catch(() => false))
    ) {
      return c;
    }
  }
  return null;
}

/**
 * #163: the "Resend Account Verification" control on a link-only wall.
 *
 * Accessible NAME first, from the registry's anchored list — the raw
 * `[href*=resend]` selector is the fallback, because a verification wall
 * sits on a sign-in page and a loose match must never land on Sign In,
 * Create Account or Forgot your password. Returns null rather than
 * guessing; the caller then reports "no resend control" instead of
 * clicking something arbitrary.
 */
async function findResendVerificationControl(
  page: Page,
  sel: { resendVerification: string; resendVerificationNames: RegExp[] },
): Promise<Locator | null> {
  for (const name of sel.resendVerificationNames) {
    const named = await visibleNamed(page, name);
    if (named) return named;
  }
  return firstVisible(page, sel.resendVerification);
}

/**
 * A <button> inside a <form> with no type, or type=submit, submits that
 * form. Workday's "Already have an account? Sign In" is type=button (a
 * view switch). The sandbox puts Create Account and Sign In on ONE page;
 * clicking Sign In as a "flip" POSTs the empty sign-in form.
 */
async function isFormSubmitControl(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el: {
      tagName: string;
      getAttribute: (n: string) => string | null;
      closest: (s: string) => unknown;
    }) => {
      const tag = el.tagName;
      if (tag !== "BUTTON" && tag !== "INPUT") return false;
      const raw = el.getAttribute("type");
      const type = (raw ?? (tag === "BUTTON" ? "submit" : "")).toLowerCase();
      if (type !== "submit") return false;
      return el.closest("form") !== null;
    })
    .catch(() => false);
}

/** The wrapping <form> of a submit, or null when the ATS does not use one. */
async function formOf(loc: Locator): Promise<Locator | null> {
  const inside = await loc
    .evaluate((el: { closest: (s: string) => unknown }) =>
      Boolean(el.closest("form")),
    )
    .catch(() => false);
  if (!inside) return null;
  return loc.locator("xpath=./ancestor::form[1]");
}

/**
 * Paced credential typing shared by the sign-in/create attempt and the
 * username-first step. #102: fill()'s synthetic write passes read-back but
 * some tenants' anti-bot layers ignore it — click, clear, type keystrokes;
 * fill() only when the click is intercepted.
 */
async function typeCredential(f: Locator, text: string, settle: number): Promise<void> {
  const clicked = await f.click({ timeout: 3_000 }).then(() => true, () => false);
  if (!clicked) {
    await f.fill(text, { timeout: 5_000 }).catch(() => undefined);
    return;
  }
  await f.fill("").catch(() => undefined);
  await f.pressSequentially(text, { delay: settle === 0 ? 0 : 60 }).catch(() => undefined);
}

/** Hosts/paths that are a sign-in surface by name (login.ibm.com, /oidc, /sso …). */
const SIGN_IN_URL_RE =
  /(^|\/\/|\.)(login|signin|sign-in|auth|accounts?|idp?|sso|idaas)\.|\/(login|signin|sign-in|auth|oidc|sso|idaas)(\/|$|\?)/i;
const USERNAME_FIRST_SUBMIT_RE = /^(continue|next|sign in|log ?in|submit)$/i;

/**
 * #195 (live IBMid 2026-09-08, login.ibm.com; #192): a username-first wall
 * shows ONE identifier input and a Continue — the password field renders
 * only after the identifier is accepted. `locateAuthFields` read
 * email=true / password=false and the flow answered not_an_auth_wall,
 * while the navigation model had correctly called the page a sign-in
 * gate three times. Type the standing username, click the page's own
 * Continue, and wait (bounded) for a password input; the normal sign-in
 * path then runs on the completed form.
 *
 * Guarded to sign-in shapes only — a login-looking URL, federated buttons,
 * or a continue/next/sign-in submit — never a stray email input on a
 * job-alert or newsletter form. "wall" means the page IS a sign-in gate
 * but did not advance (identifier unknown to this portal, or a further
 * wall): the caller reports wall_remains so the pipeline parks for auth
 * instead of re-queuing into the same wall.
 */
async function advanceUsernameFirstWall(input: {
  page: Page;
  emailField: Locator;
  username: string;
  diagnosis: LoginWallDiagnosis;
  notes: string[];
  settle: number;
}): Promise<"advanced" | "wall" | "not_sign_in"> {
  const { page, emailField, username, diagnosis, notes, settle } = input;
  const looksLikeSignIn =
    SIGN_IN_URL_RE.test(page.url()) ||
    diagnosis.federatedProviders.length > 0 ||
    diagnosis.submitControls.some((n) => USERNAME_FIRST_SUBMIT_RE.test(n.trim()));
  if (!looksLikeSignIn) return "not_sign_in";
  const root = await authScope(page);
  const submit =
    (await visibleNamed(root, USERNAME_FIRST_SUBMIT_RE)) ??
    (await firstVisible(root, "button[type='submit'], input[type='submit']"));
  if (!submit) {
    notes.push("portal auth: username-first wall has no continue control (#195)");
    return "wall";
  }
  await typeCredential(emailField, username, settle);
  if ((await emailField.inputValue().catch(() => "")).trim() === "") {
    notes.push("portal auth: username-first identifier did not take — retyped once");
    await typeCredential(emailField, username, settle);
  }
  await submit.click({ timeout: 5_000 }).catch(() => undefined);
  const passwordRendered = await page
    .locator(`${workdaySelectorsV1.auth.passwordInput}, input[type='password']`)
    .first()
    .waitFor({ state: "visible", timeout: AUTH_RESPONSE_WAIT_MS })
    .then(() => true, () => false);
  await settlePage(page, settle, 500);
  if (passwordRendered) {
    notes.push("portal auth: username-first wall — identifier accepted, password step rendered (#195)");
    return "advanced";
  }
  const after = await diagnoseLoginWall(page);
  notes.push(
    `portal auth: username-first wall — no password step after Continue (${after.classification}${after.errorText ? ` — "${after.errorText.slice(0, 100)}"` : ""}); the identifier is likely unknown to this portal (#195)`,
  );
  return "wall";
}

async function locateAuthFields(page: Page): Promise<{
  email: Locator | null;
  password: Locator | null;
}> {
  const sel = workdaySelectorsV1.auth;
  const root = await authScope(page);
  const email =
    (await firstVisible(root, sel.emailInput)) ??
    (await firstVisible(root, EMAIL_INPUT_SELECTOR));
  const password =
    (await firstVisible(root, sel.passwordInput)) ??
    (await firstVisible(root, "input[type='password']"));
  return { email, password };
}

export async function authenticateAtsPortal(
  page: Page,
  seams: PortalAuthSeams = {},
): Promise<PortalAuthOutcome> {
  assertNavigationAllowed("authenticateAtsPortal");
  const notes: string[] = [];
  const secrets: string[] = [];
  const settle = seams.settleMs ?? 800;
  const sel = workdaySelectorsV1.auth;
  const url = page.url();
  const host = safeHost(url);

  if (!isRecognizedAtsAuthHost(url)) {
    notes.push(`portal auth refused: ${host} is not a recognized ATS auth host`);
    return {
      status: "refused",
      verification_used: false,
      escalated_to_create: false,
      diagnosis: null,
      notes,
      secrets,
    };
  }

  // #93 (operator directive): per-host auth budget, persistent across
  // runs — three failed/silent attempts in 6h and this host cools down
  // instead of being hammered into a bot flag (TIAA took ~35 attempts
  // across two nights before anyone noticed).
  const exhausted = authBudgetExhausted(host);
  if (exhausted) {
    notes.push(`portal auth refused: ${exhausted}`);
    return {
      status: "wall_remains",
      verification_used: false,
      escalated_to_create: false,
      diagnosis: null,
      notes,
      secrets,
    };
  }

  // #64 (live tiaa.wd1 2026-08-31): an undismissed cookie/legal banner
  // (data-automation-id=legalNotice) sat over the page across every auth
  // attempt of nights 20-21; swallowed click timeouts vanished into
  // catch(() => undefined). Sweep before diagnosing — the dismisser's
  // never-click pattern keeps real auth controls safe.
  const swept = await dismissPageObstructions(page, {
    settleMs: settle === 0 ? 0 : 400,
  });
  if (swept.dismissed.length > 0) {
    notes.push(
      `portal auth: dismissed page obstruction(s): ${swept.dismissed.join(", ")}`,
    );
  }

  const diagnosis = await diagnoseLoginWall(page);
  notes.push(summarizeLoginWall(diagnosis));

  let fields = await locateAuthFields(page);
  if (!fields.email || !fields.password) {
    await openWorkdayApplyChooser(page, notes, settle);
    fields = await locateAuthFields(page);
  }

  // Create-before-sign-in (operator directive 2026-08-30 night21): an
  // account is assumed NOT to exist unless the vault records one we
  // created/the operator set, or the portal itself answers "already
  // exists". Read BEFORE prepareCredentialsForHost, which may mint a
  // vault entry for the host as a side effect.
  const knownAccount = getAccount(host) !== null;

  const creds = prepareCredentialsForHost({
    host,
    runId: `portal-auth-${Date.now()}`,
    loginWallDetected: true,
    ...(seams.emailOverride ? { emailOverride: seams.emailOverride } : {}),
  });
  notes.push(...creds.notes);
  secrets.push(...creds.secrets);
  // #93: credentials-typed flag — only real attempts burn budget; early
  // refusals (no creds, no form, budget itself) never do.
  let credentialsTyped = false;
  const done = (
    status: PortalAuthOutcome["status"],
    extra: { verification?: boolean; escalated?: boolean; diag?: LoginWallDiagnosis } = {},
  ): PortalAuthOutcome => {
    if (status === "signed_in" || status === "account_created") {
      clearAuthFailures(host);
    } else if (status === "wall_remains" && credentialsTyped) {
      recordAuthFailure(host);
      notes.push(
        "portal auth: attempt recorded against the host's budget (3 failures in 6h ⇒ cool-down)",
      );
    }
    return {
      status,
      verification_used: extra.verification ?? false,
      escalated_to_create: extra.escalated ?? false,
      diagnosis: extra.diag ?? diagnosis,
      notes,
      secrets,
    };
  };

  const settleEmailedCodeWall = async (input: {
    username: string;
    escalated: boolean;
    /**
     * #163: a verification LINK usually lands on a page that says "verified —
     * sign in"; the caller supplies the one sign-in retry (it is defined
     * later in this function, so it is injected rather than referenced).
     */
    signInAfterLink?: () => Promise<{ diag: LoginWallDiagnosis; formGone: boolean }>;
  }): Promise<PortalAuthOutcome | null> => {
    const codeInput =
      (await firstVisible(page, sel.verificationCodeInput)) ??
      (await firstVisible(page, "input[autocomplete='one-time-code']"));
    const pageText = await page
      .innerText("body", { timeout: 3_000 })
      .then((t) => t.slice(0, 2_000))
      .catch(() => "");
    // #163: a wall can ask for verification with NO code input at all —
    // the page just refuses to sign you in until you click the link in the
    // email (live Alcon 2026-09-03: "Verify your account before you sign
    // in or request a verification email", plus a Resend link). Requiring
    // a code input meant that wall was never worked at all. The link path
    // below already existed; only this gate kept it unreachable.
    const linkOnlyWall =
      !codeInput && sel.accountVerificationMarkers.test(pageText);
    if (!verificationEvidencePresent(pageText) || (!codeInput && !linkOnlyWall)) {
      if (codeInput) {
        notes.push(
          "portal auth: code input present but page shows no verification prompt — mailbox not consulted",
        );
      }
      return null;
    }
    if (linkOnlyWall) {
      notes.push(
        "portal auth: account-verification wall with no code input — the email carries a link",
      );
    }
    const waiter =
      seams.waiter !== undefined ? seams.waiter : resolveNavVerificationWaiter();
    if (!waiter) {
      notes.push(
        "portal auth: verification requested but no mailbox provider is enabled",
      );
      return done("wall_remains", { escalated: input.escalated });
    }
    let wait = await waiter(
      { sent_to: input.username, requested_at: new Date().toISOString() },
      [host],
    );
    // #163: on a link-only wall the mailbox may hold nothing — the account
    // was created in an earlier run and its email has long since been read
    // or expired. The page offers its own "Resend Account Verification";
    // click it ONCE and poll again. Bounded to a single resend: this sends
    // real mail to the operator's own address, so it is a last resort, not
    // a retry loop, and it never runs when the mailbox already had a link.
    if (linkOnlyWall && wait.kind === "timeout") {
      const resend = await findResendVerificationControl(page, sel);
      if (resend) {
        notes.push(
          "portal auth: no verification email on file — clicking the page's own Resend once",
        );
        await resend.click({ timeout: 5_000 }).catch(() => undefined);
        await settlePage(page, settle, 1_000);
        wait = await waiter(
          { sent_to: input.username, requested_at: new Date().toISOString() },
          [host],
        );
      } else {
        notes.push(
          "portal auth: no verification email and no resend control on the page",
        );
      }
    }
    let verificationUsed = false;
    if (wait.kind === "code" && !codeInput) {
      // A code arrived but this wall has nowhere to type it (#163). Say so
      // rather than pretending the wall was cleared.
      notes.push(
        "portal auth: mailbox returned a CODE but this wall has no code input — needs the link",
      );
      return done("wall_remains", { escalated: input.escalated });
    }
    if (wait.kind === "code" && codeInput) {
      secrets.push(wait.code);
      await codeInput.fill(wait.code, { timeout: 5_000 }).catch(() => undefined);
      const verifySubmit = await firstVisible(page, sel.verificationSubmit);
      if (verifySubmit) {
        await verifySubmit.click({ timeout: 5_000 }).catch(() => undefined);
      }
      await settlePage(page, settle, 1_000);
      verificationUsed = true;
      notes.push("portal auth: emailed code entered");
    } else if (wait.kind === "link") {
      secrets.push(wait.url);
      await page
        .goto(wait.url, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => undefined);
      await settlePage(page, settle, 1_000);
      verificationUsed = true;
      notes.push("portal auth: emailed verification link opened");
    } else {
      notes.push(
        "portal auth: verification email not found within the poll budget",
      );
      return done("wall_remains", { escalated: input.escalated });
    }
    const textAfter = await page
      .innerText("body", { timeout: 3_000 })
      .then((t) => t.slice(0, 2_000))
      .catch(() => "");
    const stillCode =
      ((await firstVisible(page, sel.verificationCodeInput)) ??
        (await firstVisible(page, "input[autocomplete='one-time-code']"))) !==
        null && verificationEvidencePresent(textAfter);
    // #163: a link-only wall clears by the BANNER going away — there is no
    // code input whose absence could signal success, so the code check
    // above would call an unchanged page "signed in".
    const stillBanner =
      linkOnlyWall && sel.accountVerificationMarkers.test(textAfter);
    if (stillCode || stillBanner) {
      notes.push(
        stillBanner
          ? "portal auth: account-verification banner still shown after opening the link"
          : "portal auth: emailed-code wall remains",
      );
      return done("wall_remains", {
        verification: verificationUsed,
        escalated: input.escalated,
        diag: await diagnoseLoginWall(page),
      });
    }
    // #163: the link page itself is not the signed-in session — when it
    // still shows a sign-in form, sign in ONCE now (the account is verified)
    // and judge THAT answer; a page without a form is the caller's to read.
    const afterLink = await diagnoseLoginWall(page);
    if (
      wait.kind === "link" &&
      input.signInAfterLink &&
      afterLink.fields.email &&
      afterLink.fields.password &&
      afterLink.classification === "sign_in_form"
    ) {
      notes.push("portal auth: verification link opened onto a sign-in form — signing in once");
      const retry = await input.signInAfterLink();
      if (!retry.formGone) {
        notes.push(
          `portal auth: sign-in after verification did not clear (${retry.diag.classification}${retry.diag.errorText ? ` — "${retry.diag.errorText.slice(0, 100)}"` : ""})`,
        );
        return done("wall_remains", {
          verification: verificationUsed,
          escalated: input.escalated,
          diag: retry.diag,
        });
      }
      return done("signed_in", {
        verification: verificationUsed,
        escalated: input.escalated,
        diag: retry.diag,
      });
    }
    return done(input.escalated ? "account_created" : "signed_in", {
      verification: verificationUsed,
      escalated: input.escalated,
      diag: afterLink,
    });
  };

  if (!fields.email || !fields.password) {
    // Already on the emailed-code wall (create redirected here, or a retry
    // landed on /portal/verify). Scan the mailbox; do not plan this page
    // as an application form.
    if (!creds.credentials.available) {
      const codeInput =
        (await firstVisible(page, sel.verificationCodeInput)) ??
        (await firstVisible(page, "input[autocomplete='one-time-code']"));
      if (codeInput) {
        notes.push(
          "portal auth: emailed-code wall but no credentials (set PORTAL_LOGIN_EMAIL/PASSWORD)",
        );
        return done("wall_remains");
      }
      notes.push("portal auth: no sign-in form on this page");
      return {
        status: "not_an_auth_wall",
        verification_used: false,
        escalated_to_create: false,
        diagnosis: await diagnoseLoginWall(page),
        notes,
        secrets,
      };
    }
    const codeOnly = await settleEmailedCodeWall({
      username: creds.credentials.username,
      escalated: false,
    });
    if (codeOnly) return codeOnly;
    // #195: identifier-only sign-in step (IBMid, Okta/Auth0-style walls).
    if (fields.email && !fields.password && typeof creds.credentials.username === "string") {
      const step = await advanceUsernameFirstWall({
        page,
        emailField: fields.email,
        username: creds.credentials.username,
        diagnosis,
        notes,
        settle,
      });
      if (step === "advanced") fields = await locateAuthFields(page);
      else if (step === "wall") return done("wall_remains", { diag: await diagnoseLoginWall(page) });
    }
    if (!fields.email || !fields.password) {
      notes.push("portal auth: no sign-in form on this page");
      return {
        status: "not_an_auth_wall",
        verification_used: false,
        escalated_to_create: false,
        diagnosis: await diagnoseLoginWall(page),
        notes,
        secrets,
      };
    }
  }

  if (!creds.credentials.available) {
    notes.push("portal auth: no credentials available (set PORTAL_LOGIN_EMAIL/PASSWORD)");
    return done("wall_remains");
  }
  const { username, password } = creds.credentials;

  // Workday lands on Create Account after Apply Manually. Prefer Sign In
  // ONLY when the vault records an account for this host (#64, operator
  // directive night21 — standing credentials alone are no longer reason
  // to prefer sign-in: on first contact the account does not exist yet).
  // Do NOT click a Sign In *submit* — that posts an empty form. A real
  // flip is Workday's type=button signInLink. When both forms are already
  // on the page, skip the click and just target the Sign In form.
  let preferSignIn = false;
  const wallNow = await diagnoseLoginWall(page);
  if (
    knownAccount &&
    wallNow.classification === "create_account_form" &&
    creds.notes.some((n) => /standing portal login|vault: (existing|per-host)/i.test(n))
  ) {
    const signIn =
      (await firstVisible(page, sel.signInLink)) ??
      (await visibleNamed(page, /^(already have an account\??\s*)?sign in$/i));
    if (signIn && !(await isFormSubmitControl(signIn))) {
      await signIn.click({ timeout: 5_000 }).catch(() => undefined);
      await settlePage(page, settle, 800);
      preferSignIn = true;
      notes.push("portal auth: flipped Create Account → Sign In (standing credentials)");
    } else if (await visibleNamed(page, /^(sign in|log ?in)$/i)) {
      preferSignIn = true;
      notes.push(
        "portal auth: Sign In form already on this page — using standing credentials",
      );
    }
  }

  const attempt = async (
    kind: "sign_in" | "create",
  ): Promise<{ diag: LoginWallDiagnosis; formGone: boolean }> => {
    // Scope to the visible auth dialog when there is one (Workday's Sign
    // In modal sits over the Create Account form; the first visible submit
    // on the PAGE belonged to the form behind the modal).
    const root = await authScope(page);
    if (root !== page) notes.push(`portal auth ${kind}: targeting the visible auth dialog`);
    let submit =
      (await firstVisible(
        root,
        kind === "create" ? sel.createAccountSubmit : sel.signInSubmit,
      )) ??
      (await visibleNamed(
        root,
        kind === "create"
          ? /create account|sign up|register/i
          : /^(sign in|log ?in|continue|submit)$/i,
      ));
    if (!submit && kind === "create") {
      // Auth0-style universal login (UKG signin-us.ukg.net, live Bennett
      // Thrasher 2026-09-01): the Sign up route lands on /u/signup whose
      // ONLY submit says "Continue" — no create-labeled control exists
      // anywhere. When the URL path itself says signup/register, the
      // form's own submit IS the create submit; the path check keeps this
      // from ever grabbing a sign-in form's Continue.
      const path = ((): string => {
        try {
          return new URL(page.url()).pathname;
        } catch {
          return "";
        }
      })();
      if (/\b(sign-?up|register|create-?account)\b/i.test(path)) {
        submit = await firstVisible(
          root,
          "button[type='submit'], input[type='submit']",
        );
        if (submit) {
          notes.push(
            "portal auth create: signup-route page has no create-labeled submit — using the form's own submit",
          );
        }
      }
    }
    if (!submit) {
      notes.push(`portal auth: no ${kind} submit control found`);
      return { diag: await diagnoseLoginWall(page), formGone: false };
    }
    if (kind === "create") {
      // Read the portal's stated password rules BEFORE typing anything:
      // a non-compliant standing password makes Workday's Create Account
      // a silent no-op (live 2026-08-30, huntington.wd12). Park with the
      // exact gap; the operator sets a compliant per-host password
      // (accounts:set) or changes PORTAL_LOGIN_PASSWORD.
      const rulesText = await (root === page
        ? page.innerText("body", { timeout: 3_000 })
        : (root as Locator).innerText({ timeout: 3_000 })
      ).catch(() => "");
      const gaps = passwordPolicyGaps(rulesText, password);
      if (gaps.length > 0) {
        notes.push(
          `portal auth create: standing password fails this portal's password policy (missing: ${gaps.join(", ")}) — not submitting; set a compliant per-host password with accounts:set --host ${host} or change PORTAL_LOGIN_PASSWORD`,
        );
        return { diag: await diagnoseLoginWall(page), formGone: false };
      }
    }
    const form = await formOf(submit);
    const emailField = form
      ? form.locator(EMAIL_INPUT_SELECTOR).first()
      : ((await firstVisible(root, sel.emailInput)) ??
        (await firstVisible(root, EMAIL_INPUT_SELECTOR)));
    const passwordFields = form
      ? form.locator("input[type='password']")
      : root.locator("input[type='password']");
    const passwordCount = await passwordFields.count().catch(() => 0);
    // TIAA live 2026-08-30 (#63e): a just-rendered Workday auth form can
    // DROP keystrokes typed before its React handlers attach — the submit
    // then posts an empty form and the page answers nothing, ever (the
    // instrumented diagnostic with human pacing signed in instantly).
    // Settle before typing, then read the fields back and retype once.
    await settlePage(page, settle, 800);
    // #102 (live tiaa, two nights of "silent sign-in"): fill()'s synthetic
    // single-event write passes the DOM read-back below but this tenant's
    // anti-bot layer ignores it — the submit posts an empty form and the
    // page answers NOTHING. The paced diagnostic that signs in every time
    // clicks the field and types real keystrokes; do exactly that, with
    // fill() only as the fallback when the field click is intercepted.
    const typeInto = (f: NonNullable<typeof emailField>, text: string): Promise<void> =>
      typeCredential(f, text, settle);
    if (emailField && (await emailField.count().catch(() => 0)) > 0) {
      await typeInto(emailField, username);
    }
    for (let i = 0; i < Math.min(passwordCount, 2); i++) {
      await typeInto(passwordFields.nth(i), password);
    }
    credentialsTyped = true;
    await settlePage(page, settle, 500);
    if (emailField && (await emailField.count().catch(() => 0)) > 0) {
      const took = (await emailField.inputValue().catch(() => "")).trim();
      if (took === "") {
        notes.push(`portal auth ${kind}: email did not take — retyped once`);
        await typeInto(emailField, username);
      }
    }
    for (let i = 0; i < Math.min(passwordCount, 2); i++) {
      const f = passwordFields.nth(i);
      const took = (await f.inputValue().catch(() => "")).trim();
      if (took === "") {
        notes.push(`portal auth ${kind}: password did not take — retyped once`);
        await typeInto(f, password);
      }
    }
    const checkbox = await firstVisible(page, sel.createAccountCheckbox);
    if (kind === "create" && checkbox) {
      await checkbox.check({ timeout: 3_000 }).catch(() => undefined);
    }
    // #64: a swallowed click (obstruction interception, detached target)
    // must leave evidence — a silent catch hid the TIAA banner for two
    // nights. The Enter retry below still runs either way.
    const clickErr = await submit
      .click({ timeout: 10_000 })
      .then(() => null, (e: unknown) => String(e));
    if (clickErr) {
      notes.push(
        `portal auth ${kind}: submit click FAILED (${clickErr.replace(/\s+/g, " ").slice(0, 90)})`,
      );
      // #76 (live tiaa #23d): the visible Sign In sits under the
      // invisible-captcha click_filter overlay — the mouse click times
      // out on interception. A JS click on the submit fires the
      // framework handlers the pointer never reached (the paced
      // diagnostic that signed in clicked exactly this element).
      await submit
        .evaluate((el: { click: () => void }) => el.click())
        .catch(() => undefined);
      notes.push(`portal auth ${kind}: retried via JS click`);
    }
    await settlePage(page, settle, 1_200);
    // Workday answers a sign-in/create click AFTER the settle (live
    // huntington 2026-08-30 #8d: the 1.2s read said "sign_in_form", the
    // rejection banner landed a moment later and the escalation never
    // ran). Poll, bounded, until the page is decisive: an error, the form
    // gone, a verification-code input, or a different classification.
    let after = await diagnoseLoginWall(page);
    const before = after.classification;
    const stillSilent = async (): Promise<boolean> =>
      after.fields.password &&
      !after.errorText &&
      after.classification === before &&
      !(await firstVisible(page, sel.verificationCodeInput));
    const pollResponse = async (): Promise<void> => {
      const deadline = Date.now() + AUTH_RESPONSE_WAIT_MS;
      while (Date.now() < deadline && (await stillSilent())) {
        await page.waitForTimeout(500);
        after = await diagnoseLoginWall(page);
      }
    };
    if (settle > 0) {
      await pollResponse();
      // TIAA live 2026-08-30 (#63c, runs 22f/22i — account EXISTED):
      // the tenant's visible Sign In is an invisible-captcha overlay
      // (click_filter/noCaptchaWrapper); clicking the underlying button
      // is a silent no-op — no error, no navigation, ever. Keyboard
      // submit from the password field is the human-faithful retry and
      // bypasses the overlay. Once, noted, then the poll decides again.
      if (await stillSilent()) {
        const pw = form
          ? form.locator("input[type='password']").first()
          : passwordFields.first();
        await pw.press("Enter", { timeout: 5_000 }).catch(() => undefined);
        notes.push(
          `portal auth ${kind}: click answered nothing — retried with Enter from the password field`,
        );
        await settlePage(page, settle, 1_200);
        after = await diagnoseLoginWall(page);
        await pollResponse();
      }
    }
    const formGone = !after.fields.password && !after.errorText;
    notes.push(
      `portal auth ${kind}: ${formGone ? "form cleared" : after.classification}` +
        (after.errorText ? ` — "${after.errorText.slice(0, 100)}"` : ""),
    );
    return { diag: after, formGone };
  };

  const wallAfterChooser = await diagnoseLoginWall(page);
  let escalated = false;
  let startAsCreate =
    !preferSignIn && wallAfterChooser.classification === "create_account_form";
  // #64 create-before-sign-in: a sign-in-only wall on a host with NO
  // account on record takes the page's own Create Account route FIRST.
  // Sign-in on first contact was built on the false positive "create:
  // form cleared" — live tiaa nights 20-21. The portal answering
  // "already exists" (below) is the sanctioned flip back.
  if (
    !knownAccount &&
    !startAsCreate &&
    wallAfterChooser.classification === "sign_in_form" &&
    wallAfterChooser.createAccountRoute
  ) {
    const route = wallAfterChooser.createAccountRoute;
    const scopeNow = await authScope(page);
    const control =
      (await firstVisible(scopeNow, sel.createAccountLink)) ??
      (await visibleNamed(scopeNow, new RegExp(`^${escapeRe(route)}$`, "i"))) ??
      (await visibleNamed(page, new RegExp(`^${escapeRe(route)}$`, "i")));
    if (control && !(await isFormSubmitControl(control))) {
      await control.click({ timeout: 5_000 }).catch(() => undefined);
      await settlePage(page, settle, 1_000);
      notes.push(
        `portal auth: no account on record for ${host} — taking "${route}" first (create-before-sign-in)`,
      );
      startAsCreate = true;
    }
  }
  let state = startAsCreate ? await attempt("create") : await attempt("sign_in");
  if (startAsCreate) escalated = true;

  // The portal explicitly says the account exists — the ONLY sanctioned
  // reason to sign in on a first-contact host (#64).
  if (
    escalated &&
    !state.formGone &&
    state.diag.errorText &&
    ACCOUNT_EXISTS_RE.test(state.diag.errorText)
  ) {
    notes.push(
      "portal auth: portal says an account already exists for this email — signing in",
    );
    const signInFlip =
      (await firstVisible(await authScope(page), sel.signInLink)) ??
      (await visibleNamed(page, /^(already have an account\??\s*)?sign in$/i));
    if (signInFlip && !(await isFormSubmitControl(signInFlip))) {
      await signInFlip.click({ timeout: 5_000 }).catch(() => undefined);
      await settlePage(page, settle, 800);
    }
    escalated = false;
    state = await attempt("sign_in");
  }

  // #163 (live alcon.wd5 2026-09-03): the sign-in is REFUSED until the
  // account is verified — "Verify your account before you sign in or
  // request a verification email." That is neither a wrong password nor a
  // missing account: creating would fail "already exists" and the silent
  // branch below would take the Create Account route anyway (it did — the
  // mailbox was consulted on the wrong page). Work the emailed link NOW,
  // while the banner and its Resend control are on the page.
  if (
    !state.formGone &&
    state.diag.errorText &&
    sel.accountVerificationMarkers.test(state.diag.errorText)
  ) {
    notes.push(
      `portal auth: sign-in refused until the account is verified — "${state.diag.errorText.slice(0, 100)}"; working the emailed link`,
    );
    const verified = await settleEmailedCodeWall({
      username,
      escalated,
      signInAfterLink: () => attempt("sign_in"),
    });
    if (verified) return verified;
    notes.push(
      "portal auth: account-verification banner shown but no verification prompt was readable — parking",
    );
    return done("wall_remains", { escalated, diag: state.diag });
  }

  if (!state.formGone && state.diag.classification === "account_locked") {
    // A locked account is neither a wrong password nor a missing account:
    // creating would fail "already exists", retrying extends the lock.
    notes.push(
      `portal auth: account locked on ${host} — ${(state.diag.errorText ?? "").slice(0, 120)}; not escalating, not retrying`,
    );
    return done("wall_remains", { escalated, diag: state.diag });
  }
  if (!state.formGone && state.diag.classification === "credentials_rejected") {
    const route = state.diag.createAccountRoute;
    // Dual-form walls already show Create Account. Clicking that submit
    // would POST an empty create form; just fill it.
    if (state.diag.fields.confirmPassword) {
      notes.push("portal auth: sign-in rejected — creating the account on this page");
      escalated = true;
      state = await attempt("create");
    } else if (route) {
      // Prefer the vendor's own view-switch link INSIDE the auth scope
      // (Workday: createAccountLink in the Sign In dialog). A page-wide
      // name match found the create form's submit BEHIND the modal.
      const scopeNow = await authScope(page);
      const control =
        (await firstVisible(scopeNow, sel.createAccountLink)) ??
        (await visibleNamed(scopeNow, new RegExp(`^${escapeRe(route)}$`, "i"))) ??
        (await visibleNamed(page, new RegExp(`^${escapeRe(route)}$`, "i")));
      if (control && !(await isFormSubmitControl(control))) {
        await control.click({ timeout: 5_000 }).catch(() => undefined);
        await settlePage(page, settle, 1_000);
        notes.push(`portal auth: sign-in rejected — opened "${route}" to create the account`);
        escalated = true;
        state = await attempt("create");
      } else if (control && (await isFormSubmitControl(control))) {
        notes.push("portal auth: sign-in rejected — creating the account on this page");
        escalated = true;
        state = await attempt("create");
      }
    } else {
      notes.push(
        "portal auth: sign-in rejected and no create-account route is offered on this page",
      );
    }
  }

  // SILENT sign-in (TIAA live 2026-08-30 #60b): the Sign In click answered
  // NOTHING within the response wait — no error banner, no navigation, the
  // form just stood — so the credentials_rejected escalation never fired
  // and the run parked "wall remains (sign_in_form)". On first contact
  // with a tenant the missing ACCOUNT is the common cause (huntington and
  // bah both needed create). Take the page's own Create Account route
  // ONCE: creating against an existing account fails with an inline error,
  // so the asymmetry is safe, and the attempt cap bounds the walk.
  if (
    !escalated &&
    !state.formGone &&
    state.diag.classification === "sign_in_form" &&
    !state.diag.errorText &&
    state.diag.createAccountRoute
  ) {
    const route = state.diag.createAccountRoute;
    const scopeNow = await authScope(page);
    const control =
      (await firstVisible(scopeNow, sel.createAccountLink)) ??
      (await visibleNamed(scopeNow, new RegExp(`^${escapeRe(route)}$`, "i"))) ??
      (await visibleNamed(page, new RegExp(`^${escapeRe(route)}$`, "i")));
    if (control && !(await isFormSubmitControl(control))) {
      await control.click({ timeout: 5_000 }).catch(() => undefined);
      await settlePage(page, settle, 1_000);
      notes.push(
        `portal auth: sign-in answered nothing — taking the page's "${route}" route to create the account`,
      );
      escalated = true;
      state = await attempt("create");
    }
  }

  const codeResult = await settleEmailedCodeWall({ username, escalated });
  if (codeResult) return codeResult;

  const finalDiag = await diagnoseLoginWall(page);
  if (!finalDiag.fields.password || finalDiag.classification === "no_form_found") {
    // #64: "form cleared" is not success. When Workday's signed-OUT
    // header button is still on the page, the dialog merely closed —
    // nights 20-21 reported "create: form cleared" five times for an
    // account whose creation nothing ever evidenced.
    if (await firstVisible(page, "[data-automation-id='utilityButtonSignIn']")) {
      notes.push(
        "portal auth: form cleared but the header still shows Sign In — NOT signed in; parking",
      );
      return done("wall_remains", { escalated, diag: finalDiag });
    }
    if (escalated && creds.credentials.available) {
      // Record the verified creation so the next run on this host takes
      // sign-in first — the vault entry IS the "account exists" evidence.
      setAccount(host, {
        email: username,
        password,
        runId: `portal-auth-${Date.now()}`,
      });
      notes.push(`portal auth: created account recorded in the vault for ${host}`);
    }
    return done(escalated ? "account_created" : "signed_in", {
      escalated,
      diag: finalDiag,
    });
  }
  notes.push(`portal auth: wall remains (${finalDiag.classification})`);
  return done("wall_remains", { escalated, diag: finalDiag });
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tests pass settleMs: 0 so fixture clicks stay synchronous. */
async function settlePage(
  page: Page,
  settle: number,
  liveFloorMs: number,
): Promise<void> {
  const ms = settle === 0 ? 0 : Math.max(settle, liveFloorMs);
  if (ms > 0) await page.waitForTimeout(ms);
}

/**
 * Poll for the auth form to render. Workday's SPA rebuilds the page after
 * "Apply Manually" and takes SECONDS — live 2026-08-14 (Crowe): the walk
 * clicked Apply, clicked Apply Manually, waited 800ms, found no third
 * button, and returned; the Create Account form the operator was looking
 * at rendered right after. The run then reported "no sign-in form on this
 * page" with credentials sitting unused in the env. Bounded poll, and
 * tests keep settle 0 so fixtures stay synchronous.
 */
async function waitForAuthForm(
  page: Page,
  settle: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (settle === 0) return (await firstVisible(page, "input[type='password']")) !== null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await firstVisible(page, "input[type='password']")) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(300);
  }
}

/**
 * Workday SSO sign-in chooser (TIAA live 2026-08-30): after Apply
 * Manually the flow renders signInContent — Apple / Google / LinkedIn
 * buttons plus "Sign in with email" — and NO inputs, so the form waiters
 * see nothing and the run parked "no sign-in form on this page".
 * Operator directive 2026-08-30: ALWAYS take the email path, never a
 * third-party provider. Click it and wait for the real email/password
 * form; the standing PORTAL_LOGIN_* credentials fill it downstream.
 */
async function clickSignInWithEmail(
  page: Page,
  notes: string[],
  settle: number,
): Promise<boolean> {
  const btn =
    (await firstVisible(page, "[data-automation-id='SignInWithEmailButton']")) ??
    (await visibleNamed(page, /^sign ?in with email$/i));
  if (!btn) return false;
  await btn.click({ timeout: 8_000 }).catch(() => undefined);
  notes.push("portal auth: SSO chooser — clicked Sign in with email");
  if (await waitForAuthForm(page, settle)) {
    notes.push("portal auth: email sign-in form rendered");
    return true;
  }
  notes.push("portal auth: email form did not render after Sign in with email");
  return false;
}

/**
 * Workday posting → Start Your Application modal → Apply Manually.
 * Cap 3 clicks. Never Autofill with Resume. Never wizard submit.
 */
async function openWorkdayApplyChooser(
  page: Page,
  notes: string[],
  settle: number,
): Promise<void> {
  const sel = workdaySelectorsV1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await firstVisible(page, "input[type='password']")) return;

    const manual =
      (await firstVisible(page, sel.applyMethods.applyManually)) ??
      (await visibleNamed(page, /^apply manually$/i));
    if (manual) {
      await manual.click({ timeout: 8_000 }).catch(() => undefined);
      notes.push(`portal auth: clicked Apply Manually (attempt ${attempt})`);
      // Apply Manually is the LAST click before the account form — wait for
      // it rather than probing for another button 800ms later.
      if (await waitForAuthForm(page, settle)) {
        notes.push("portal auth: account form rendered after Apply Manually");
        return;
      }
      // The tenant may have rendered the SSO chooser instead of a form.
      if (await clickSignInWithEmail(page, notes, settle)) return;
      notes.push("portal auth: no account form within 15s of Apply Manually");
      continue;
    }

    const apply =
      (await firstVisible(page, sel.applyButton)) ??
      (await firstVisible(page, sel.auth.gatedEntry)) ??
      (await visibleNamed(page, /^apply( now)?$/i));
    if (apply) {
      const label = ((await apply.textContent().catch(() => null)) ?? "Apply")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      // The shared transition primitive replaces click+800ms-floor:
      // change-detected settle, one obstruction-sweep retry on a silent
      // no-op click, and telemetry for the improve loop.
      const transition = await performTransition(page, apply, {
        settleTimeoutMs: settle === 0 ? 0 : 15_000,
        adoptPopups: false,
      });
      recordTransitionOutcome({
        seam: "portal_auth_apply",
        host: safeHost(page.url()),
        result: transition,
      });
      notes.push(`portal auth: clicked "${label || "Apply"}" (attempt ${attempt})`);
      continue;
    }

    // No button left to click. That is usually because the form — or the
    // Start Your Application CHOOSER — is ON ITS WAY: Workday paints the
    // modal seconds after the Apply/Continue click (#75, live tiaa
    // 2026-08-31: the walk probed before the modal rendered, waited 15s
    // for a password form that never comes, and planned an anonymous
    // shell without ever signing in). Poll for ANY of the three
    // continuations: a password form, the Apply Manually button, or the
    // SSO email button — then loop.
    if (attempt > 1) {
      const deadline = Date.now() + (settle === 0 ? 0 : 15_000);
      let found: "form" | "manual" | "sso" | null = null;
      for (;;) {
        if (await firstVisible(page, "input[type='password']")) {
          found = "form";
          break;
        }
        if (
          (await firstVisible(page, workdaySelectorsV1.applyMethods.applyManually)) ??
          (await visibleNamed(page, /^apply manually$/i))
        ) {
          found = "manual";
          break;
        }
        if (await firstVisible(page, "[data-automation-id='SignInWithEmailButton']")) {
          found = "sso";
          break;
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(400);
      }
      if (found === "form") {
        notes.push("portal auth: account form rendered while waiting");
        return;
      }
      if (found === "manual") {
        notes.push("portal auth: chooser modal rendered while waiting");
        continue;
      }
    }
    if (await clickSignInWithEmail(page, notes, settle)) return;
    notes.push(
      `portal auth: Apply / Apply Manually not found on attempt ${attempt}`,
    );
    return;
  }
}
