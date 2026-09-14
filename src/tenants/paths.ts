import path from "node:path";
import { getConfig } from "../config/index.js";

/**
 * Tenant workspace layout (plan v0.5, docs/roadmap/cloud-deploy.md):
 *
 *   <TENANTS_ROOT>/
 *     master.key.dpapi              DPAPI-wrapped master; per-tenant keys
 *                                   derive from it (keys.ts)
 *     <uuid>/
 *       tenant.json                 manifest (ids, eligibility, versions)
 *       private/candidate/          public-profile.json, about-me.md,
 *                                   screeners.json, resumes/, personas/,
 *                                   sensitive-profile.enc (tenant key)
 *       private/auth/               storage state the engine unseals for a run
 *       private/ats-accounts/       per-host portal accounts (tenant's own)
 *       private/browser-profiles/   headless Chrome profile dirs
 *       private/unsealed/           plaintext session files that exist ONLY
 *                                   during a run and are wiped after
 *       secrets/*.enc               sealed secrets (AES-GCM, tenant key)
 *       data/app.sqlite             the tenant's OWN SQLite (one process = one tenant)
 *       artifacts/                  run artifacts, receipts
 *       runs/<job>/                 per-job logs + result.json
 *
 * Every path is derived from the tenant's uuid through assertTenantId, so a
 * cloud row can never name a directory outside its own workspace.
 */

export const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lower-cased canonical uuid, or a loud refusal — never a path segment from raw input. */
export function assertTenantId(raw: string): string {
  const id = String(raw ?? "").trim().toLowerCase();
  if (!TENANT_ID_RE.test(id)) {
    throw new Error("tenant id must be a canonical uuid (refusing to derive a workspace path from it)");
  }
  return id;
}

export type TenantPaths = {
  userId: string;
  root: string;
  manifestPath: string;
  privateDir: string;
  candidateDir: string;
  authDir: string;
  atsAccountsDir: string;
  browserProfilesDir: string;
  unsealedDir: string;
  secretsDir: string;
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  runsDir: string;
};

export function tenantsRootDir(root = getConfig().tenantsRoot): string {
  return path.resolve(root);
}

/** The DPAPI-wrapped master key shared by every tenant under one root. */
export function tenantMasterKeyPath(root = getConfig().tenantsRoot): string {
  return path.join(tenantsRootDir(root), "master.key.dpapi");
}

export function tenantPaths(userId: string, root = getConfig().tenantsRoot): TenantPaths {
  const id = assertTenantId(userId);
  const base = path.join(tenantsRootDir(root), id);
  const privateDir = path.join(base, "private");
  return {
    userId: id,
    root: base,
    manifestPath: path.join(base, "tenant.json"),
    privateDir,
    candidateDir: path.join(privateDir, "candidate"),
    authDir: path.join(privateDir, "auth"),
    atsAccountsDir: path.join(privateDir, "ats-accounts"),
    browserProfilesDir: path.join(privateDir, "browser-profiles"),
    unsealedDir: path.join(privateDir, "unsealed"),
    secretsDir: path.join(base, "secrets"),
    dataDir: path.join(base, "data"),
    dbPath: path.join(base, "data", "app.sqlite"),
    artifactsDir: path.join(base, "artifacts"),
    runsDir: path.join(base, "runs"),
  };
}

/** True when `candidate` lies inside the tenant's workspace (after resolution). */
export function isInsideTenant(paths: TenantPaths, candidate: string): boolean {
  const rel = path.relative(paths.root, path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
