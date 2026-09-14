import fs from "node:fs";
import path from "node:path";
import { assertTenantId } from "./paths.js";

/**
 * Which persisted remote-browser context belongs to which tenant.
 *
 * Browserbase contexts carry cookies and storage between sessions, so a
 * tenant who signed into JobRight and Gmail once in a handoff finds the
 * next handoff (a reconnect, or the other service) already signed in —
 * the "sign in once" the operator wants for hosted users, and the
 * datacenter-fingerprint hedge from the spike doc. The id is not a
 * secret (it is useless without the API key), so it lives as a plain
 * file in the tenant's workspace: <TENANTS_ROOT>/<uuid>/browser-context.json.
 */

export type ContextStore = {
  get(userId: string): string | null;
  set(userId: string, contextId: string): void;
};

export function tenantContextPath(tenantsRoot: string, userId: string): string {
  assertTenantId(userId);
  return path.join(tenantsRoot, userId, "browser-context.json");
}

export function fileContextStore(tenantsRoot: string): ContextStore {
  return {
    get(userId) {
      const p = tenantContextPath(tenantsRoot, userId);
      if (!fs.existsSync(p)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { context_id?: unknown };
        return typeof parsed.context_id === "string" && parsed.context_id.trim() ? parsed.context_id : null;
      } catch {
        return null;
      }
    },
    set(userId, contextId) {
      const p = tenantContextPath(tenantsRoot, userId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ context_id: contextId, created_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    },
  };
}

/** In-memory store for tests and for providers without contexts. */
export function memoryContextStore(initial: Record<string, string> = {}): ContextStore {
  const m = new Map(Object.entries(initial));
  return { get: (u) => m.get(u) ?? null, set: (u, id) => void m.set(u, id) };
}
