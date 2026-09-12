import type { HandoffKind, HandoffStatus, HandoffTaskRow, IntegrationRow } from "../contract.js";

/**
 * Step 11 — the JobRight connect handoff, as the UI sees it. Pure so the
 * phase mapping and the poll bounds are unit-tested; IntegrationsStep
 * does the I/O.
 *
 * Lifecycle (20260911000800): open → requested (user) → provisioning →
 * live (live_view_url) → user_done (user) → verifying (engine) →
 * completed | failed | expired | cancelled. The UI never marks a task
 * completed; only the engine's read-back does.
 */

export const ACTIVE_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  "open",
  "requested",
  "provisioning",
  "live",
  "user_done",
  "verifying",
];

export type HandoffPhase =
  | "none"
  | "requested"
  | "live"
  | "verifying"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export function handoffPhase(task: HandoffTaskRow | null): HandoffPhase {
  if (!task) return "none";
  switch (task.status) {
    case "open":
    case "requested":
    case "provisioning":
      return "requested";
    case "live":
      return "live";
    case "user_done":
    case "verifying":
      return "verifying";
    case "completed":
    case "failed":
    case "expired":
    case "cancelled":
      return task.status;
  }
}

/** Every task is a row; the newest ACTIVE one of the kinds wins, else the newest finished one. */
export function pickHandoff(tasks: readonly HandoffTaskRow[], kinds: readonly HandoffKind[]): HandoffTaskRow | null {
  const mine = tasks
    .filter((t) => kinds.includes(t.kind))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return mine.find((t) => ACTIVE_HANDOFF_STATUSES.includes(t.status)) ?? mine[0] ?? null;
}

export function isActiveHandoff(task: HandoffTaskRow | null): boolean {
  return task !== null && ACTIVE_HANDOFF_STATUSES.includes(task.status);
}

/**
 * While a handoff or a feed sample is in flight the step re-reads its
 * rows on a bounded schedule (no realtime publication yet): every 5 s,
 * at most 180 times (15 min) — then it stops and says so, and the manual
 * refresh remains. House rule: no unbounded polling.
 */
export const HANDOFF_POLL_MS = 5000;
export const HANDOFF_POLL_CAP = 180;

export const JOBRIGHT_CONNECT_KINDS: readonly HandoffKind[] = ["jobright_connect", "jobright_reconnect"];

/** What the user does in the live browser, in order. */
export const JOBRIGHT_CHECKLIST: readonly string[] = [
  "Sign in to JobRight with your email and password. (Google sign-in inside a hosted browser is often challenged; the email route is the reliable one.)",
  "Set your job filters the way you want Dispatch to search — titles, locations, remote.",
  "Open the Recommended feed once so it loads with your filters applied.",
];

export function integrationFor(rows: readonly IntegrationRow[], provider: IntegrationRow["provider"]): IntegrationRow | null {
  return rows.find((r) => r.provider === provider) ?? null;
}

/** Copy for an integration's status line; never invents a state. */
export function integrationStatusLabel(row: IntegrationRow | null): string {
  if (!row) return "not connected";
  switch (row.status) {
    case "connected":
      return row.account_email ? `connected as ${row.account_email}` : "connected";
    case "pending_handoff":
      return "waiting for you to sign in";
    case "expired":
      return "session expired — reconnect";
    case "revoked":
      return "access revoked — reconnect";
    case "disconnected":
      return "not connected";
  }
}
