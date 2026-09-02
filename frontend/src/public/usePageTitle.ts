import { useEffect } from "react";

const SUFFIX = "Dispatch";

/**
 * One document.title per public route. Before this every page shared
 * the shell's title, so the browser tab, the history list, and a screen
 * reader's page announcement could not tell sign-in from the dashboard
 * (QA 2026-09-02, defect D-09).
 */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} — ${SUFFIX}` : `${SUFFIX} — job applications, done with receipts`;
  }, [title]);
}
