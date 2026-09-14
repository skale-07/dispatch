import { resolveRemoteBrowserProvider, type RemoteBrowserProvider } from "../browser/remoteBrowser.js";
import type { AppConfig } from "../config/index.js";
import type { Db } from "../storage/db/client.js";
import {
  captureHandoff,
  resolveJobrightAuthParks,
  type CaptureOutcome,
  type CaptureSession,
  type HandoffClient,
  type HandoffTaskRecord,
  handoffService,
  type HandoffService,
} from "./capture.js";
import type { TenantPaths } from "./paths.js";

/**
 * The `reconnect_verify` job (plan v0.5, M17): the user has clicked "I'm
 * signed in" on a jobright_connect / jobright_reconnect task; the engine
 * attaches to that remote session, captures + seals the storageState,
 * marks the integration connected and requeues the applications the
 * expired session parked.
 *
 * The session seam is imported lazily so the tenant runner does not load
 * Playwright for every job; tests inject `openSession` and `provider`.
 */

export type ReconnectSeams = {
  provider?: RemoteBrowserProvider;
  openSession?: (connectUrl: string) => CaptureSession;
  now?: () => Date;
};

/** HandoffClient plus the one read this job needs (a fake in tests). */
export type TaskClient = {
  from(table: string): {
    update(patch: Record<string, unknown>): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }> };
    };
  };
  rpc: HandoffClient["rpc"];
};

export async function readHandoffTask(client: TaskClient, id: string): Promise<HandoffTaskRecord | null> {
  const { data, error } = await client.from("handoff_tasks").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`handoff_tasks read failed: ${error.message}`);
  if (!data) return null;
  return {
    id: String(data["id"]),
    user_id: String(data["user_id"]),
    kind: data["kind"] as HandoffTaskRecord["kind"],
    status: data["status"] as HandoffTaskRecord["status"],
    attempts: typeof data["attempts"] === "number" ? data["attempts"] : 0,
    provider_session_id: typeof data["provider_session_id"] === "string" ? data["provider_session_id"] : null,
    expires_at: typeof data["expires_at"] === "string" ? data["expires_at"] : null,
  };
}

async function defaultOpenSession(connectUrl: string, service: HandoffService): Promise<CaptureSession> {
  const { PlaywrightServiceSession } = await import("../auth/serviceSession.js");
  return new PlaywrightServiceSession({ service, mode: "CDP_ATTACH", cdpUrl: connectUrl, skipAuthValidation: true });
}

export type ReconnectResult = {
  outcome: "completed" | "capture_failed" | "refused";
  reason: string | null;
  capture: CaptureOutcome | null;
  parks: { resolved: number; requeued: number } | null;
};

export async function runReconnectVerify(input: {
  client: TaskClient;
  config: AppConfig;
  userId: string;
  taskId: string | null;
  paths: TenantPaths;
  tenantKey: Buffer;
  /** The tenant database, already open; used for the post-capture requeue. */
  db: Db;
  seams?: ReconnectSeams;
}): Promise<ReconnectResult> {
  const seams = input.seams ?? {};
  if (!input.taskId) return { outcome: "refused", reason: "reconnect_verify needs payload.task_id", capture: null, parks: null };
  const task = await readHandoffTask(input.client, input.taskId);
  if (!task) return { outcome: "refused", reason: `handoff task ${input.taskId} not found`, capture: null, parks: null };
  if (task.user_id !== input.userId) return { outcome: "refused", reason: "handoff task belongs to another user", capture: null, parks: null };
  const service = handoffService(task.kind);
  if (!service) {
    return { outcome: "refused", reason: `handoff kind ${task.kind} is not a JobRight or Gmail connect (its remote-browser resolution is a later milestone)`, capture: null, parks: null };
  }
  if (task.status !== "user_done") return { outcome: "refused", reason: `handoff task is ${task.status}, not user_done`, capture: null, parks: null };
  if (!task.provider_session_id) return { outcome: "refused", reason: "handoff task has no provider session", capture: null, parks: null };

  const provider = seams.provider ?? resolveRemoteBrowserProvider(input.config);
  let connectUrl: string;
  try {
    connectUrl = provider.connectUrl(task.provider_session_id);
  } catch (err) {
    return { outcome: "refused", reason: err instanceof Error ? err.message : String(err), capture: null, parks: null };
  }
  let openSession: (url: string) => CaptureSession;
  if (seams.openSession) {
    openSession = seams.openSession;
  } else {
    const real = await defaultOpenSession(connectUrl, service);
    openSession = () => real;
  }
  const capture = await captureHandoff({
    client: input.client,
    provider,
    task,
    paths: input.paths,
    tenantKey: input.tenantKey,
    connectUrl,
    openSession,
    probeText: async (session) => {
      const page = await session.newPage();
      try {
        await page.goto("https://jobright.ai/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        const body = page as unknown as { locator(sel: string): { innerText?: () => Promise<string> } };
        const inner = body.locator("body").innerText;
        return inner ? await inner() : "";
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    ...(seams.now ? { now: seams.now } : {}),
  });
  if (capture.status !== "completed") {
    return { outcome: "capture_failed", reason: capture.reason, capture, parks: null };
  }
  // A fresh JobRight session unparks the applications that were waiting
  // on it; a Gmail session parks nothing (drafts simply resume).
  const parks = service === "jobright" ? resolveJobrightAuthParks(input.db, (seams.now ?? (() => new Date()))()) : null;
  return { outcome: "completed", reason: null, capture, parks };
}
