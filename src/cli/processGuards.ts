import { logger } from "../logging/logger.js";

let installed = false;

/**
 * Process-boundary safety net (#205, day28 2026-09-09).
 *
 * Node's default for a rejected promise nobody awaits is to crash the
 * process. A live auto:cycle died that way mid-fill when Playwright's own
 * dialog auto-dismiss raced a dialog the page had already closed — the
 * pipeline's error handling never saw it, the application row was left
 * in NATIVE_AUTOFILL_RUNNING, and the cycle reported the previous cycle's
 * summary. The root cause has its own guard (browser/dialogGuard.ts);
 * this is the last line: log the rejection loudly, with its stack, and
 * keep the process alive so the pipeline's own bounded error handling
 * decides what happens to the application. Installed once, from the CLI
 * entry only — never from library code, never in tests (vitest must keep
 * treating an unhandled rejection as a failure).
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandled promise rejection — process kept alive (#205)", {
      service: "cli",
      action: "unhandled_rejection",
      metadata: {
        error: err.message.slice(0, 500),
        stack: err.stack?.split("\n").slice(0, 8).join(" | "),
      },
    });
  });
}
