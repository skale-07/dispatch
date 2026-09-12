/**
 * Workday hosted career sites (<tenant>.wdN.myworkdayjobs.com) — Tier-2:
 * a multi-page wizard behind a per-tenant account. Workday ships stable
 * `data-automation-id` hooks across tenants; these selectors are authored
 * from those public conventions.
 *
 * UNVERIFIED_SELECTOR: not yet confirmed against a captured live DOM. The
 * live-fill form-snapshot instrumentation captures the real DOM on first
 * encounter; the /improve loop heals from there.
 */
export const workdaySelectorsV1 = {
  /** Posting page: the Apply button that opens the auth/apply flow. */
  /**
   * #72 (live tiaa 2026-08-31): a signed-in session with a DRAFT in
   * progress renders continueButton instead of adventureButton on the
   * posting — same role, resumes the wizard.
   */
  applyButton:
    "a[data-automation-id='adventureButton'], button[data-automation-id='adventureButton'], a[data-automation-id='continueButton'], button[data-automation-id='continueButton'], a[role='button'][data-uxi-element-id*='Apply' i]",
  /** Apply-method chooser after Apply. */
  applyMethods: {
    autofillWithResume: "a[data-automation-id='autofillWithResume'], button[data-automation-id='autofillWithResume']",
    applyManually: "a[data-automation-id='applyManually'], button[data-automation-id='applyManually']",
    /**
     * #275 (operator directive 2026-09-12): the Autofill with Resume route.
     * Workday reveals a file input plus a drop zone after the chooser click;
     * the input is the only thing Playwright can set. `fileUpload` is the
     * wrapper Workday paints, kept for the visibility probe — the
     * `input[type=file]` inside it is frequently CSS-hidden, so callers set
     * files on the INPUT and never require it to be visible.
     */
    autofillFileInput:
      "input[type='file'][data-automation-id='file-upload-input-ref'], [data-automation-id='quickApplyResumeUpload'] input[type='file'], [data-automation-id='fileUpload'] input[type='file'], input[type='file']",
    autofillDropZone:
      "[data-automation-id='quickApplyResumeUpload'], [data-automation-id='fileUpload'], [data-automation-id='file-upload-drop-zone']",
    /** Progress/complete markers Workday paints while it parses the file. */
    autofillUploadedItem:
      "[data-automation-id='file-upload-item'], [data-automation-id='fileUploadItem'], [data-automation-id='attachment-item']",
    /** Continue/Next after the parse, before the account or wizard form. */
    autofillContinue:
      "[role='button'][data-automation-id='click_filter'][aria-label*='continue' i], button[data-automation-id='continueButton'], button[data-automation-id='bottom-navigation-next-button']",
  },
  auth: {
    /** Sign-in / create-account page detection. */
    emailInput:
      "input[data-automation-id='email'], input[type='email'][data-automation-id], input[data-automation-id='userName'], input[autocomplete='email']",
    passwordInput: "input[data-automation-id='password']",
    verifyPasswordInput: "input[data-automation-id='verifyPassword']",
    createAccountCheckbox: "input[data-automation-id='createAccountCheckbox']",
    /**
     * Live huntington.wd12 (2026-08-30): the real <button type=submit
     * data-automation-id=signInSubmitButton> is aria-hidden/tabindex=-2;
     * the VISIBLE control is a <div role=button aria-label="Sign In"
     * data-automation-id="click_filter">. Both auth forms carry one, so
     * callers scope to the visible dialog first.
     */
    /**
     * #92 (live tiaa, ~35 silent sign-ins across two nights): the
     * underlying signInSubmitButton is aria-hidden UNDER the
     * click_filter overlay — Playwright counts it visible, firstVisible
     * returned it FIRST, and every click was intercepted. The overlay's
     * own click_filter is the human-clickable control (the paced
     * diagnostic that signed in clicked exactly it) — it goes first.
     */
    signInSubmit:
      "[role='button'][data-automation-id='click_filter'][aria-label*='sign in' i], button[data-automation-id='click_filter'], button[data-automation-id='signInSubmitButton']",
    createAccountSubmit:
      "[role='button'][data-automation-id='click_filter'][aria-label*='create' i], button[data-automation-id='click_filter'], button[data-automation-id='createAccountSubmitButton']",
    /** Robot trap planted next to both forms — never a field, never filled. */
    honeypot: "input[data-automation-id='beecatcher'], input[name='website']",
    /** Link/button that flips between the two auth forms. */
    createAccountLink:
      "button[data-automation-id='createAccountLink'], a[data-automation-id='createAccountLink']",
    signInLink:
      "button[data-automation-id='signInLink'], a[data-automation-id='signInLink']",
    /**
     * Posting/chooser pages that SHOW a Sign In / Apply control but have
     * not yet revealed the email+password form (Crowe live 2026-08-14:
     * submit=[Sign In], fields all false). Clicking these is how the form
     * appears; they are not the form submit.
     */
    gatedEntry:
      "a[data-automation-id='adventureButton'], button[data-automation-id='adventureButton'], a[data-automation-id='continueButton'], button[data-automation-id='continueButton']",
    /** Email-verification code entry (tenants that require it). */
    verificationCodeInput:
      "input[data-automation-id='verificationCode'], input[autocomplete='one-time-code']",
    verificationSubmit:
      "button[data-automation-id='verifyButton'], button[data-automation-id='click_filter']",
    /**
     * #163 (operator screenshot 2026-09-03, Alcon "2027 Summer Software,
     * Data & AI Engineering"): an account-verification wall with NO code
     * input. The sign-in page itself carries a red banner — "Verify your
     * account before you sign in or request a verification email" — and
     * the email holds a LINK, not a code. The emailed-code handler
     * required a visible code input, so this wall was never worked.
     */
    accountVerificationMarkers:
      /verify your account|account (is )?not (yet )?verified|verify your email( address)? before|confirm your email( address)? before|request a verification email/i,
    /** Re-send the verification email when the mailbox has none. */
    resendVerification:
      "a[href*='resend' i], button[id*='resend' i], button[name*='resend' i]",
    resendVerificationNames: [
      /resend account verification/i,
      /resend verification( email)?/i,
      /request a (new )?verification email/i,
      /send verification email/i,
    ] as RegExp[],
    /** Page-text markers. */
    signInMarkers: /sign in|log in/i,
    createAccountMarkers: /create account|create an account|sign up/i,
    /**
     * Live Amazon flow (operator screenshots 2026-08-12): the portal shows
     * a sign-in page with a "Create an Amazon.jobs account" link. The
     * create route is taken ONLY after a sign-in attempt is rejected.
     */
    createAccountRouteNames: [
      /create an? .{0,40}account/i,
      /^create account$/i,
      /^sign up$/i,
      /new to .{0,30}\?/i,
    ] as RegExp[],
    confirmPasswordNames: [
      /^confirm( new)? password$/i,
      /^re-?enter password$/i,
      /^verify password$/i,
    ] as RegExp[],
    badCredentialsMarkers:
      /incorrect|invalid|doesn'?t match|does not match|no account|can'?t find|verify your email/i,
  },
  /**
   * #198 (live morningstar.wd5 2026-09-08): the header's account submenu
   * (`ul[role=menu][aria-labelledby=account-submenu-button]`) was left OPEN
   * over the My Information page and intercepted every pointer event —
   * 6 field clicks timed out at 5s, 12 verify mismatches, all "(empty)".
   * Any open header menu is closed (Escape, then a click on the page
   * heading) before the wizard is filled; never a menu item.
   */
  header: {
    container: "[data-automation-id='header']",
    openMenu:
      "[data-automation-id='header'] [role='menu'], [data-automation-id='header'] ul[aria-labelledby='account-submenu-button'], [data-automation-id='header'] [aria-expanded='true']",
  },
  wizard: {
    /** Wizard page container + progress bar. */
    pageMarkers:
      /data-automation-id=["']progressBar|data-automation-id=["']myInformationPage|My Information|Application Questions|Voluntary Disclosures|Self Identify|Review/i,
    nextButton:
      "button[data-automation-id='bottom-navigation-next-button'], button[data-automation-id='pageFooterNextButton']",
    /** FINAL submit — never clicked outside the gated submit path. */
    submitButton: "button[data-automation-id='bottom-navigation-submit-button'], button[data-automation-id='pageFooterSubmitButton']",
    resumeUpload:
      "input[data-automation-id='file-upload-input-ref'], input[type='file']",
    /** My Information page fields. */
    fields: {
      firstName: "input[data-automation-id='legalNameSection_firstName']",
      lastName: "input[data-automation-id='legalNameSection_lastName']",
      email: "input[data-automation-id='email']",
      phone: "input[data-automation-id='phone-number']",
      addressLine1: "input[data-automation-id='addressSection_addressLine1']",
      city: "input[data-automation-id='addressSection_city']",
      postalCode: "input[data-automation-id='addressSection_postalCode']",
      /** Dropdown buttons (Workday custom selects). */
      state: "button[data-automation-id='addressSection_countryRegion']",
      country: "button[data-automation-id='addressSection_country']",
      phoneType: "button[data-automation-id='phone-device-type']",
      source: "button[data-automation-id='sourceSection_source']",
      previousWorker: "input[data-automation-id='previousWorker']",
    },
  },
  /**
   * Vendor error containers for the shared page-error reader (#66a) —
   * Workday's page-level "N errors found" banner and inline messages.
   */
  errorContainers: [
    "[data-automation-id='errorBanner']",
    "[data-automation-id='pageLevelErrorBanner']",
    "[data-automation-id='errorMessage']",
    "[data-automation-id='alertMessage']",
    "[data-automation-id='inputError']",
  ],
  /** Post-submit confirmation — deliberately narrow. */
  confirmationMarkers:
    /application (?:submitted|received|complete)|thank you for applying|you(?:'ve| have) successfully (?:applied|submitted)/i,
  formMarkers: /data-automation-id=/i,
  status: "UNVERIFIED_SELECTOR" as const,
} as const;
