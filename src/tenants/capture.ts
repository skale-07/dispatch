import type { AuthValidationResult } from "../auth/types.js";
import type { RemoteBrowserProvider } from "../browser/remoteBrowser.js";
import { type HandoffKind, type HandoffStatus } from "../cloud/engineQueue.js";
import { logger } from "../logging/logger.js";
import { listOpenReviewItems, resolveReviewItem } from "../queue/reviewItems.js";
import { transitionApplication } from "../queue/stateMachine.js";
import type { Db } from "../storage/db/client.js";
import type { ContextStore } from "./browserContexts.js";
import type { TenantPaths } from "./paths.js";
import { sealSecret } from "./secrets.js";

/**
 * The JobRight connect / reconnect handoff, engine side (plan v0.5, M17).
 *
 *   open → requested (user clicks Start) → provisioning → live
 *   (live_view_url, expires in 15 min) → user_done (user clicks "I'm signed
 *   in") → verifying (engine attaches to the SAME remote session through
 *   the ordinary session seam, validates the app shell, reads
 *   storageState, seals it under the tenant key, probes premium) →
 *   completed | failed (a new `open` while attempts < 3) | expired.
 *
 * Nothing here launches a browser: `openSession` is the injected seam
 * (PlaywrightServiceSession in CDP_ATTACH mode with the provider's connect
 * URL, which src/auth/cdpPolicy.ts admits only behind
 * REMOTE_BROWSER_ENABLED). The connect URL is a secret — it never reaches
 * a cloud row or a log line.
 */

export const HANDOFF_LIVE_MINUTES = 15;
export const HANDOFF_MAX_ATTEMPTS = 3;
export const JOBRIGHT_STATE_SECRET = "jobright.storage";
/** The user's Gmail session, sealed the same way (decision 2026-09-14: Gmail through the remote Chrome, not OAuth). */
export const GMAIL_STATE_SECRET = "gmail.storage";

/** Which browser service a handoff kind signs into; null for kinds the remote browser does not resolve yet (ats_login, captcha). */
export type HandoffService = "jobright" | "gmail";
export function handoffService(kind: HandoffKind): HandoffService | null {
  if (kind === "jobright_connect" || kind === "jobright_reconnect") return "jobright";
  if (kind === "gmail_connect" || kind === "gmail_reconnect") return "gmail";
  return null;
}
export function stateSecretFor(service: HandoffService): string {
  return service === "gmail" ? GMAIL_STATE_SECRET : JOBRIGHT_STATE_SECRET;
}

export type HandoffTaskRecord = {
  id: string;
  user_id: string;
  kind: HandoffKind;
  status: HandoffStatus;
  attempts: number;
  provider_session_id: string | null;
  expires_at: string | null;
};

type UpdateResult = { error: { message: string } | null };

/** The supabase-js surface this module touches (fake in tests). */
export type HandoffClient = {
  from(table: string): {
    update(patch: Record<string, unknown>): { eq(column: string, value: string): PromiseLike<UpdateResult> };
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function updateHandoffTask(
  client: HandoffClient,
  id: string,
  patch: Partial<{
    status: HandoffStatus;
    reason: string | null;
    live_view_url: string | null;
    provider_session_id: string | null;
    expires_at: string | null;
    attempts: number;
    result: Record<string, unknown> | null;
  }>,
): Promise<void> {
  const { error } = await client.from("handoff_tasks").update(patch).eq("id", id);
  if (error) throw new Error(`handoff_tasks update failed: ${error.message}`);
}

/**
 * requested → provisioning → live. Returns the live row fields; on a
 * provider failure the task is `failed` with the reason (never a thrown
 * secret).
 */
export async function provisionHandoff(input: {
  client: HandoffClient;
  provider: RemoteBrowserProvider;
  task: HandoffTaskRecord;
  /** Persisted-context bookkeeping per tenant; absent ⇒ a fresh browser every time. */
  contexts?: ContextStore;
  now?: () => Date;
}): Promise<{ status: "live" | "failed"; liveViewUrl: string | null; providerSessionId: string | null; expiresAt: string | null; reason: string | null }> {
  const now = input.now ?? (() => new Date());
  await updateHandoffTask(input.client, input.task.id, { status: "provisioning" });
  try {
    // One persisted context per tenant: created on their first handoff,
    // reused for every later one (reconnects, the other service). A
    // context that cannot be created is a note, never a blocked login —
    // the session then runs without persistence.
    let contextId: string | undefined;
    if (input.contexts && input.provider.createContext) {
      const existing = input.contexts.get(input.task.user_id);
      if (existing) contextId = existing;
      else {
        try {
          contextId = await input.provider.createContext({ userId: input.task.user_id });
          input.contexts.set(input.task.user_id, contextId);
        } catch (err) {
          logger.warn("remote browser context unavailable; session without persistence", {
            service: "tenants",
            action: "handoff_context_failed",
            metadata: { user_id: input.task.user_id, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) },
          });
        }
      }
    }
    const session = await input.provider.createSession({ userId: input.task.user_id, ...(contextId ? { contextId } : {}) });
    const expiresAt = new Date(now().getTime() + HANDOFF_LIVE_MINUTES * 60_000).toISOString();
    await updateHandoffTask(input.client, input.task.id, {
      status: "live",
      live_view_url: session.liveViewUrl,
      provider_session_id: session.sessionId,
      expires_at: expiresAt,
    });
    logger.info("handoff live", {
      service: "tenants",
      action: "handoff_live",
      metadata: { user_id: input.task.user_id, kind: input.task.kind, provider: session.provider, session_id: session.sessionId },
    });
    return { status: "live", liveViewUrl: session.liveViewUrl, providerSessionId: session.sessionId, expiresAt, reason: null };
  } catch (err) {
    const reason = `remote browser unavailable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    await updateHandoffTask(input.client, input.task.id, { status: "failed", reason, result: { error: reason } });
    return { status: "failed", liveViewUrl: null, providerSessionId: null, expiresAt: null, reason };
  }
}

/** What a capture needs from a browser session — PlaywrightServiceSession satisfies it. */
export type CaptureSession = {
  open(): Promise<void>;
  validate(): Promise<AuthValidationResult>;
  getContext(): { storageState(): Promise<unknown> };
  newPage(): Promise<{ goto(url: string, opts?: Record<string, unknown>): Promise<unknown>; locator(sel: string): { count(): Promise<number> }; innerText?: unknown; close(): Promise<void> }>;
  close(): Promise<void>;
};

export type PremiumProbe = "present" | "absent" | "unknown";

/**
 * Pure: page text → premium signal. The user's own self-report in the
 * wizard remains the authority; the RPC only ever promotes to true. Any
 * doubt is "unknown", never "absent".
 */
export function assessPremiumText(bodyText: string): PremiumProbe {
  const t = bodyText.toLowerCase();
  if (/\b(turbo|premium)\s+(member|plan active|active)\b|you(?:'| a)re on (?:the )?(?:turbo|premium)/.test(t)) return "present";
  if (/\bupgrade to (?:turbo|premium)\b|\bgo (?:turbo|premium)\b|\bunlock (?:turbo|premium)\b/.test(t)) return "absent";
  return "unknown";
}

function looksLikeStorageState(state: unknown): state is { cookies: unknown[]; origins: unknown[] } {
  return (
    !!state &&
    typeof state === "object" &&
    Array.isArray((state as { cookies?: unknown }).cookies) &&
    Array.isArray((state as { origins?: unknown }).origins)
  );
}

export type CaptureOutcome = {
  status: "completed" | "open" | "failed";
  validation: AuthValidationResult | null;
  premium: PremiumProbe;
  sealedPath: string | null;
  attempts: number;
  reason: string | null;
};

/**
 * user_done → verifying → completed | open (retry) | failed. Seals the
 * captured storageState under the tenant key and mirrors
 * user_integrations through the service-role RPC. The provider session
 * is always released.
 */
export async function captureHandoff(input: {
  client: HandoffClient;
  provider: RemoteBrowserProvider;
  task: HandoffTaskRecord;
  paths: TenantPaths;
  tenantKey: Buffer;
  /** Builds the session for the provider's connect URL (the seam; tests inject a fake). */
  openSession: (connectUrl: string) => CaptureSession;
  connectUrl: string;
  probeText?: (session: CaptureSession) => Promise<string>;
  now?: () => Date;
}): Promise<CaptureOutcome> {
  const now = input.now ?? (() => new Date());
  const attempts = (input.task.attempts ?? 0) + 1;
  const service = handoffService(input.task.kind);
  if (!service) {
    throw new Error(`handoff kind ${input.task.kind} has no browser service to capture`);
  }
  const serviceLabel = service === "gmail" ? "Gmail" : "JobRight";
  await updateHandoffTask(input.client, input.task.id, { status: "verifying", attempts });

  let session: CaptureSession | null = null;
  let outcome: CaptureOutcome = { status: "failed", validation: null, premium: "unknown", sealedPath: null, attempts, reason: null };
  try {
    session = input.openSession(input.connectUrl);
    await session.open();
    const validation = await session.validate();
    if (!validation.ok) {
      outcome = { ...outcome, validation, reason: `${serviceLabel} did not look signed in: ${validation.reason}` };
    } else {
      const state = await session.getContext().storageState();
      if (!looksLikeStorageState(state)) throw new Error("captured storageState is not a Playwright state (cookies[]/origins[] missing)");
      const sealedPath = sealSecret(input.paths, stateSecretFor(service), state, input.tenantKey);
      let premium: PremiumProbe = "unknown";
      // The premium probe is a JobRight question; a mailbox has no such signal.
      if (input.probeText && service === "jobright") {
        try {
          premium = assessPremiumText(await input.probeText(session));
        } catch {
          premium = "unknown";
        }
      }
      outcome = { status: "completed", validation, premium, sealedPath, attempts, reason: null };
    }
  } catch (err) {
    outcome = { ...outcome, reason: `capture failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  } finally {
    if (session) await session.close().catch(() => undefined);
    if (input.task.provider_session_id) await input.provider.endSession(input.task.provider_session_id).catch(() => undefined);
  }

  if (outcome.status === "completed") {
    await updateHandoffTask(input.client, input.task.id, {
      status: "completed",
      live_view_url: null,
      provider_session_id: null,
      result: { validated_at: outcome.validation?.checkedAt ?? now().toISOString(), premium: outcome.premium },
    });
    const meta: Record<string, unknown> = {};
    if (outcome.premium === "present") meta["premium"] = true;
    const { error } = await input.client.rpc("engine_set_integration_status", {
      p_user: input.task.user_id,
      p_provider: service,
      p_status: "connected",
      p_meta: meta,
    });
    if (error) throw new Error(`engine_set_integration_status failed: ${error.message}`);
  } else {
    // A failed attempt reopens the task while attempts remain — the user
    // sees the reason and can try again; at the cap it stays failed.
    const status: HandoffStatus = attempts < HANDOFF_MAX_ATTEMPTS ? "open" : "failed";
    outcome = { ...outcome, status: status === "open" ? "open" : "failed" };
    await updateHandoffTask(input.client, input.task.id, {
      status,
      reason: outcome.reason,
      live_view_url: null,
      provider_session_id: null,
      result: { error: outcome.reason, attempts },
    });
  }
  logger.info("handoff capture finished", {
    service: "tenants",
    action: "handoff_capture",
    metadata: { user_id: input.task.user_id, kind: input.task.kind, status: outcome.status, attempts, premium: outcome.premium },
  });
  return outcome;
}

/**
 * After a successful reconnect: the tenant's AUTH_REQUIRED parks for
 * JobRight are resolved and their applications requeued through the
 * legal AUTH_REQUIRED → APPLICATION_OPENING edge. Other walls are left
 * alone.
 */
export function resolveJobrightAuthParks(db: Db, now: Date = new Date()): { resolved: number; requeued: number } {
  let resolved = 0;
  for (const item of listOpenReviewItems(db)) {
    if (item.kind !== "AUTH_REQUIRED") continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(item.payload_json) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (payload["service"] !== "jobright") continue;
    resolveReviewItem(db, item.id, { resolved_by: "jobright_reconnect", at: now.toISOString() });
    resolved += 1;
  }
  const parked = db.prepare(`SELECT id FROM applications WHERE state = 'AUTH_REQUIRED'`).all() as Array<{ id: string }>;
  let requeued = 0;
  for (const row of parked) {
    try {
      transitionApplication(db, { applicationId: row.id, nextState: "APPLICATION_OPENING", reason: "jobright_reconnect" });
      requeued += 1;
    } catch {
      // an application whose graph refuses stays where it is
    }
  }
  return { resolved, requeued };
}
