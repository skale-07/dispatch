/**
 * Generic employer-form selectors. Unlike a vendor registry these are not
 * a product's DOM contract — they are the shape an application form takes
 * on almost any site, so everything here is role/attribute based and the
 * cascade in shared/submitControl.ts + shared/uploadResolve.ts does the
 * real resolution work.
 */
export const genericSelectorsV1 = {
  /** Any form containing at least one text-ish control. */
  form: "form",
  /** Fallback CSS for the submit cascade; the name pattern leads. */
  submit:
    "button[type='submit'], input[type='submit'], button[id*='submit' i], button[class*='submit' i]",
  submitCascade: {
    form: "form",
    css: "button[type='submit'], input[type='submit']",
    // Same pattern lever/ashby/workable already share, plus the phrasings
    // company-hosted forms use ("send application", "submit application").
    namePattern:
      /^(submit|submit application|send application|apply|apply now|send|finish|complete application)$/i,
    excludePattern:
      /(save|draft|cancel|back|previous|next|continue|sign in|log ?in|create account|upload|browse|attach|add|remove|search|filter|share|print|withdraw)/i,
  },
  /**
   * #145: section-EDITOR forms (UKG Pro OpportunityApply, live 2026-09-01):
   * each section is read-only until its "Edit <Section>" / "Add <Thing>"
   * button opens a focused editor with the real controls plus Save/Cancel.
   * Attribute tier first (UKG stamps data-automation), accessible-name
   * pattern as the vendor-blind fallback. Live run 16 showed editors are
   * strictly ONE at a time (every other pencil disables while one is
   * open), so walkSectionEditors (#145c) cycles open → re-plan+fill →
   * Save per editor instead of a blanket open pass.
   */
  sectionEditors: {
    trigger:
      "button[data-automation='primary-action-button'], collapsible-panel-button button",
    triggerNamePattern: /^(edit|add)\b/i,
    save: "button[data-automation='save-button']",
    saveNamePattern: /^save$/i,
  },
  /** Upload resolution seeds; uploadResolve falls back to keyword + lone input. */
  resume:
    "input[type='file'][name*='resume' i], input[type='file'][name*='cv' i], input[type='file'][id*='resume' i], input[type='file']",
  loginMarkers:
    /sign in|log in|login|create an account|create account|password/i,
  /**
   * "A form is present." Deliberately structural: an employer page has no
   * vendor data-attribute to key on, so this is the presence of a form
   * with fillable controls.
   */
  formMarkers: /<form[\s>][\s\S]{0,20000}?<(input|textarea|select)[\s>]/i,
  /**
   * Post-submit confirmation language. Already ~80% shared with the five
   * vendor registries — the phrasing is industry-standard, the DOM is not.
   * NOTE: this is only ever the POSITIVE half. Confirmation additionally
   * requires the form to be structurally gone (see submission.ts), because
   * "thank you for your interest" appears in footers on live forms.
   */
  confirmationMarkers:
    /application (?:submitted|received|complete[d]?|successful)|thank you for (?:applying|your application|your interest in applying)|we(?:'ve| have) received your application|your application has been (?:submitted|received)|successfully (?:applied|submitted)/i,
  status: "GENERIC_HEURISTIC" as const,
} as const;
