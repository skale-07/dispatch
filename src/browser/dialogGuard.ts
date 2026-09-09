import type { BrowserContext, Dialog } from "playwright";
import { logger } from "../logging/logger.js";

/**
 * Context-level JavaScript-dialog guard (#205, day28 2026-09-09).
 *
 * Without a `dialog` listener Playwright auto-dismisses every alert /
 * confirm / prompt / beforeunload itself — and on a CDP-attached Chrome
 * that internal dismiss can race a dialog the page already closed:
 * `Protocol error (Page.handleJavaScriptDialog): No dialog is showing`
 * surfaced as an UNHANDLED rejection from Playwright's event path and
 * killed a live auto:cycle mid-fill (cisco e56b7e7a, 15:41 UTC). A
 * registered listener turns auto-dismiss off; ours dismisses with the
 * failure swallowed and the dialog text logged, so a site that pops a
 * dialog can never take the process down. Dismiss (not accept) is the
 * safe default: a confirm answers "no", a beforeunload keeps the page.
 *
 * Attach once per context (every browser seam does), detach on close.
 */
export type DialogGuardContext = Pick<BrowserContext, "on" | "off">;

export function attachDialogGuard(
  context: DialogGuardContext,
  service: string,
): () => void {
  const onDialog = (dialog: Dialog): void => {
    logger.info("page dialog dismissed", {
      service,
      action: "dialog",
      metadata: {
        type: dialog.type(),
        message: dialog.message().slice(0, 200),
      },
    });
    // The dialog may already be gone (the race this guard exists for) —
    // a failed dismiss is exactly the outcome we want, not an error.
    void dialog.dismiss().catch(() => undefined);
  };
  context.on("dialog", onDialog);
  return () => {
    context.off("dialog", onDialog);
  };
}
