import fs from "node:fs";
import { tenantPaths, type TenantPaths } from "./paths.js";

/**
 * "Am I a tenant child?" — read once from the env the runner composed
 * (CANDIDATE_KEY_PROVIDER=tenant + TENANT_USER_ID) and the workspace
 * manifest. Null in the operator's own process, so every existing code
 * path keeps its single-tenant behaviour unless it asks.
 */

export type TenantContext = {
  userId: string;
  paths: TenantPaths;
  email: string | null;
  eligibility: {
    jobright_status: string;
    jobright_premium: boolean;
    gmail_status: string;
    outreach_eligible: boolean;
  } | null;
};

export function currentTenant(env: NodeJS.ProcessEnv = process.env): TenantContext | null {
  if (env.CANDIDATE_KEY_PROVIDER?.trim().toLowerCase() !== "tenant") return null;
  const id = env.TENANT_USER_ID?.trim();
  if (!id) return null;
  const paths = tenantPaths(id, env.TENANTS_ROOT?.trim() || undefined);
  let email: string | null = null;
  let eligibility: TenantContext["eligibility"] = null;
  if (fs.existsSync(paths.manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as Record<string, unknown>;
      email = typeof m["email"] === "string" ? m["email"] : null;
      const e = m["eligibility"];
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        eligibility = {
          jobright_status: String(o["jobright_status"] ?? "disconnected"),
          jobright_premium: o["jobright_premium"] === true,
          gmail_status: String(o["gmail_status"] ?? "disconnected"),
          outreach_eligible: o["outreach_eligible"] === true,
        };
      }
    } catch {
      // an unreadable manifest is "no eligibility", never a crash in a child
    }
  }
  return { userId: paths.userId, paths, email, eligibility };
}
