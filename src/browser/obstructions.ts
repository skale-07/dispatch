import type { Page } from "playwright";

/**
 * Popup/interstitial dismisser — cookie banners, newsletter modals,
 * JobRight upsell dialogs: overlays that are NOT part of the application
 * and block the controls under them. Selectors live here (registry rule),
 * not in flow code.
 *
 * Safety posture:
 *   - Callers are already inside mutation-gated flows (NAVIGATION_ENABLED
 *     click phase, FORM_FILL execute paths) — this helper must never be
 *     called from a read-only/plan-only path.
 *   - Only elements INSIDE an overlay-ish container are ever clicked, and
 *     only when their accessible name matches an explicitly dismissive
 *     pattern. Anything that could progress, submit, agree to more than
 *     cookies, or spend (`neverClickPattern`) is refused even inside a
 *     dialog — a modal that only offers "Submit application" is left alone.
 *   - Hard caps: at most `maxDismissals` clicks, bounded settle waits.
 */
export const obstructionSelectorsV1 = {
  /** Overlay-ish containers worth inspecting. */
  containers:
    "[role='dialog'], [aria-modal='true'], [class*='modal' i], [id*='modal' i], [id*='timeout' i], [id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [class*='popup' i], [id*='onetrust' i], [data-automation-id*='legalnotice' i]",
  /** Accessible names that mean "make this go away". */
  dismissNamePattern:
    /^(accept( all)?( cookies)?|got it|ok(ay)?|close|dismiss|no,? thanks?|maybe later|not now|skip( for now)?|reject( all)?|decline|i (understand|agree)|allow all|later|✕|×|x)$/i,
  /** Close affordances that carry no text (X buttons). */
  closeControls:
    "button[aria-label*='close' i], button[aria-label*='dismiss' i], [role='button'][aria-label*='close' i]",
  /**
   * NEVER clicked, even inside a dialog — progression, submission,
   * account, or spend semantics. The application itself might live in a
   * modal on some sites; these words are how we never touch it.
   */
  neverClickPattern:
    /submit|apply|continue|next|save|send|sign|log ?in|log ?out|create|delete|remove|unsubscribe|buy|upgrade|pay|start|finish|confirm/i,
  /**
   * #153 (live UKG run 21): an inactivity dialog ("Are you still there?"
   * — Stay logged in / Log out, ~2 min countdown) mounts during a long
   * plan phase and intercepts every pointer event under it; letting it
   * expire ends the session. Its keep-alive control is the ONE
   * progression-shaped name the sweep clicks: the whole accessible name
   * must be a keep-alive phrase, checked before the flow-dialog and
   * never-click screens (so "Continue session" qualifies while a bare
   * "Continue" never does). The Log out sibling is never-click.
   */
  keepAlivePattern:
    /^(stay (logged|signed) in|keep me (logged|signed) in|(continue|extend|keep) (my )?session|i'?m still here|yes,? (i'?m|i am) (still )?here|stay (here|connected|on this page))$/i,
  /**
   * A dialog whose controls carry APPLICATION-FLOW semantics is part of
   * the flow, never dismissed — not even via its close-X (#75: the sweep
   * X-ed away Workday's "Start Your Application" chooser). Spend/upsell
   * words deliberately excluded: those dialogs are chrome and their X is
   * fair game.
   */
  flowDialogPattern:
    /\b(apply|submit(?! a review)|continue|sign ?in|log ?in|create account|autofill|use my last application)\b/i,
  /**
   * #218: dropdown menus left open over the page (Workday's header
   * account submenu after Create Account). Only role=menu — a listbox or
   * a combobox popup belongs to a field and is never touched here.
   */
  openMenus: "[role='menu']:not([aria-hidden='true'])",
  /** The control that opened such a menu (clicked to collapse it). */
  expandedMenuTriggers:
    "button[aria-expanded='true'][aria-haspopup='menu'], button[aria-expanded='true'][aria-haspopup='true'], [role='button'][aria-expanded='true'][aria-haspopup]",
  status: "UNVERIFIED_SELECTOR" as const,
} as const;

export type ObstructionDismissResult = {
  dismissed: string[];
  notes: string[];
};

/**
 * Best-effort, bounded dismissal of overlays on the current page. Returns
 * what was clicked (short labels) — telemetry for the caller's notes. A
 * page with no obstructions returns fast; failures never throw.
 */
export async function dismissPageObstructions(
  page: Page,
  options: { maxDismissals?: number; settleMs?: number } = {},
): Promise<ObstructionDismissResult> {
  const sel = obstructionSelectorsV1;
  const maxDismissals = options.maxDismissals ?? 3;
  const settleMs = options.settleMs ?? 400;
  const dismissed: string[] = [];
  const notes: string[] = [];

  try {
    // #218 (live redhat.wd5, day28 cycle 81): after Create Account, Workday
    // left its header account submenu (<ul role="menu"
    // aria-labelledby="account-submenu-button">) open, and that menu
    // intercepted the pointer on EVERY form field — 7 fills timed out and
    // the how-did-you-hear combobox read the phone-country list instead
    // of its own. An open menu is chrome, not flow: Escape first, then the
    // menu's own expanded trigger; never any item inside it.
    const openMenus = await page.locator(sel.openMenus).all().catch(() => []);
    for (const menu of openMenus.slice(0, maxDismissals)) {
      if (!(await menu.isVisible().catch(() => false))) continue;
      const labelledBy = await menu.getAttribute("aria-labelledby").catch(() => null);
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(Math.min(settleMs, 300));
      if (await menu.isVisible().catch(() => false)) {
        const trigger = labelledBy
          ? page.locator(`[id="${labelledBy}"][aria-expanded="true"]`).first()
          : page.locator(sel.expandedMenuTriggers).first();
        if ((await trigger.count().catch(() => 0)) > 0) {
          // The open menu often overlays its own trigger, so a pointer
          // click is intercepted; a dispatched click reaches the handler.
          await trigger.dispatchEvent("click").catch(() => undefined);
          await page.waitForTimeout(Math.min(settleMs, 300));
        }
      }
      if (!(await menu.isVisible().catch(() => false))) {
        dismissed.push(`open menu: ${(labelledBy ?? "role=menu").slice(0, 32)}`);
      } else {
        notes.push(`open menu still visible: ${(labelledBy ?? "role=menu").slice(0, 32)}`);
      }
    }
    for (let round = 0; round < maxDismissals; round++) {
      const containers = await page.locator(sel.containers).all();
      let clickedThisRound = false;
      for (const container of containers) {
        if (dismissed.length >= maxDismissals) break;
        if (!(await container.isVisible().catch(() => false))) continue;

        // #75 (live tiaa 2026-08-31): Workday's "Start Your Application"
        // chooser is a [role=dialog] with a close-X — the X matched
        // closeControls and the sweep DISMISSED the application flow
        // itself (the walk then found no Apply Manually, ever). A dialog
        // whose controls carry progression semantics is flow, not
        // chrome: never dismissed, not even via its X.
        const containerButtons = await container
          .locator("button, [role='button'], a")
          .all()
          .catch(() => []);
        const containerButtonNames: string[] = [];
        let keepAlive: (typeof containerButtons)[number] | null = null;
        let keepAliveName = "";
        for (const b of containerButtons.slice(0, 12)) {
          const name = (
            ((await b.textContent().catch(() => null)) ?? "") ||
            ((await b.getAttribute("aria-label").catch(() => null)) ?? "")
          )
            .replace(/\s+/g, " ")
            .trim();
          if (!name || name.length > 40) continue;
          containerButtonNames.push(name);
          if (!keepAlive && sel.keepAlivePattern.test(name)) {
            keepAlive = b;
            keepAliveName = name;
          }
        }
        // #153: a session keep-alive dialog is cleared by its own
        // keep-alive control — the only thing on it that keeps the
        // application alive (its sibling is Log out).
        if (keepAlive) {
          const label = `keep-alive: ${keepAliveName.slice(0, 24)}`;
          await keepAlive.click({ timeout: 2_000 }).catch(() => {
            notes.push(`dismiss click failed: ${label}`);
          });
          dismissed.push(label);
          clickedThisRound = true;
          await page.waitForTimeout(settleMs);
          continue;
        }
        if (containerButtonNames.some((n) => sel.flowDialogPattern.test(n))) {
          continue;
        }

        // Preferred: an explicit close affordance inside the container.
        let target = container.locator(sel.closeControls).first();
        let label = "close (aria-label)";
        if ((await target.count().catch(() => 0)) === 0) {
          // Else: a button/link whose whole name is dismissive.
          const candidates = await container
            .locator("button, [role='button'], a")
            .all()
            .catch(() => []);
          let found = null;
          for (const c of candidates.slice(0, 12)) {
            const name = (
              ((await c.textContent().catch(() => null)) ?? "") ||
              ((await c.getAttribute("aria-label").catch(() => null)) ?? "")
            ).trim();
            if (!name || name.length > 40) continue;
            if (sel.neverClickPattern.test(name)) continue;
            if (!sel.dismissNamePattern.test(name)) continue;
            found = c;
            label = name.slice(0, 30);
            break;
          }
          if (!found) continue;
          target = found;
        } else {
          // aria-close buttons still get the never-click screen on their label
          const aria =
            ((await target.getAttribute("aria-label").catch(() => null)) ?? "").trim();
          if (aria && sel.neverClickPattern.test(aria)) continue;
        }

        await target.click({ timeout: 2_000 }).catch(() => {
          notes.push(`dismiss click failed: ${label}`);
        });
        dismissed.push(label);
        clickedThisRound = true;
        await page.waitForTimeout(settleMs);
      }
      if (!clickedThisRound) break; // nothing left that qualifies
    }
  } catch (err) {
    notes.push(
      `obstruction scan error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
  }
  return { dismissed, notes };
}
