import { toHandoffTaskRow, type HandoffKind, type HandoffTaskRow } from "../cloud/engineQueue.js";
import { listOpenReviewItems, type ReviewItem } from "../queue/reviewItems.js";
import type { Db } from "../storage/db/client.js";

/**
 * Which human steps a tenant run left behind (plan v0.5, M15 — the
 * derivation; provisioning/capture over a remote browser is M17).
 *
 * Sources, all already on the tenant's own SQLite / run report:
 *   AUTH_REQUIRED review with payload.service = 'jobright'  ⇒ jobright_reconnect
 *   any other AUTH_REQUIRED review                         ⇒ ats_login (host from the wall url)
 *   CAPTCHA_REQUIRED review                                ⇒ captcha
 *   run error code jobright_auth (discovery/pipeline)      ⇒ jobright_reconnect
 *   an `invalid_grant` note (Gmail refresh token dead)     ⇒ gmail_reconnect
 *
 * One task per kind (the cloud allows one active per (user, kind)); the
 * first application that hit the wall is the context. Pure: nothing here
 * writes anywhere.
 */

export type RunSignals = {
  /** Error codes the worker noted (e.g. "jobright_auth"). */
  errorCodes?: readonly string[];
  /** Free-text notes from the run report. */
  notes?: readonly string[];
};

type Candidate = {
  kind: HandoffKind;
  reason: string;
  host?: string | null;
  engineApplicationId?: string | null;
  ats?: string | null;
};

function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function fromReviewItem(item: ReviewItem): Candidate | null {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(item.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (item.kind === "AUTH_REQUIRED") {
    if (payload["service"] === "jobright") {
      return { kind: "jobright_reconnect", reason: item.title, engineApplicationId: item.application_id };
    }
    return {
      kind: "ats_login",
      reason: item.title,
      host: hostOf(payload["url"]) ?? hostOf(payload["host"]),
      engineApplicationId: item.application_id,
      ats: typeof payload["ats"] === "string" ? payload["ats"] : null,
    };
  }
  if (item.kind === "CAPTCHA_REQUIRED") {
    return {
      kind: "captcha",
      reason: item.title,
      host: hostOf(payload["url"]),
      engineApplicationId: item.application_id,
      ats: typeof payload["ats"] === "string" ? payload["ats"] : null,
    };
  }
  return null;
}

export function deriveHandoffsFromRun(input: {
  userId: string;
  db: Db;
  signals?: RunSignals;
}): HandoffTaskRow[] {
  const byKind = new Map<HandoffKind, Candidate>();
  const add = (c: Candidate): void => {
    if (!byKind.has(c.kind)) byKind.set(c.kind, c);
  };

  for (const item of listOpenReviewItems(input.db)) {
    const c = fromReviewItem(item);
    if (c) add(c);
  }
  const codes = input.signals?.errorCodes ?? [];
  if (codes.includes("jobright_auth")) {
    add({ kind: "jobright_reconnect", reason: "JobRight session expired during the run" });
  }
  const notes = input.signals?.notes ?? [];
  if (notes.some((n) => /invalid_grant/i.test(n))) {
    add({ kind: "gmail_reconnect", reason: "Gmail refresh token rejected (invalid_grant)" });
  }

  return [...byKind.values()].map((c) =>
    toHandoffTaskRow({
      userId: input.userId,
      kind: c.kind,
      status: "open",
      reason: c.reason,
      host: c.host ?? null,
      engineApplicationId: c.engineApplicationId ?? null,
      ats: c.ats ?? null,
    }),
  );
}
