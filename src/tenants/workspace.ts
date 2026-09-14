import fs from "node:fs";
import path from "node:path";
import { resolveTenantMasterKey, writeEncryptedFile } from "../candidate/sensitiveCrypto.js";
import { materializeTenant, toSensitiveProfile, type SensitivePlain } from "../cloud/tenantMaterializer.js";
import type { OnboardedUser } from "../cloud/syncMapping.js";
import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { deriveTenantKey } from "./keys.js";
import { tenantPaths, type TenantPaths } from "./paths.js";
import { listUnsealed } from "./secrets.js";

/**
 * materializeWorkspace (plan v0.5, M14): cloud rows → a tenant's files on
 * disk, idempotently. The pure mapping is src/cloud/tenantMaterializer.ts;
 * this module only writes bytes, downloads documents and seals the one
 * secret it touches.
 *
 * Fail-closed behind TENANT_ENGINE_ENABLED (writing a hosted user's data
 * to this machine is a capability). Every path comes from tenantPaths(),
 * so a row can never place a file outside <TENANTS_ROOT>/<uuid>/.
 *
 * Documents are re-downloaded only when the row's uploaded_at differs
 * from the last materialization (documents.state.json) or the file is
 * missing. The self-identification plaintext is read through the
 * service-role RPC and written ONLY as sensitive-profile.enc under the
 * tenant key; consent withdrawn ⇒ the sealed file is removed.
 */

/**
 * The two client surfaces this module touches — injected in tests. The
 * real supabase-js `rpc()` returns a thenable query builder, not a
 * Promise, so both are typed as PromiseLike.
 */
export type WorkspaceClient = {
  storage: {
    from(bucket: string): {
      download(objectPath: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
    };
  };
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type MaterializeOptions = {
  client: WorkspaceClient;
  /** Defaults to the process config; tests pass a loadConfig() result. */
  config?: AppConfig;
  /** Defaults to HKDF(master under TENANTS_ROOT, uuid). */
  tenantKey?: Buffer;
  now?: Date;
  /** Re-download every document regardless of uploaded_at. */
  force?: boolean;
  /** Skip the self-ID RPC (e.g. a dry materialization for inspection). */
  skipSensitive?: boolean;
};

export type MaterializeReport = {
  userId: string;
  root: string;
  written: string[];
  removed: string[];
  downloaded: string[];
  unchanged: string[];
  persona: "present" | "absent";
  personaReason: string | null;
  sensitiveProfile: "sealed" | "none" | "skipped";
  answerAliases: "copied" | "missing";
  manifestPath: string;
};

const DOCUMENT_STATE = "documents.state.json";

function rel(paths: TenantPaths, file: string): string {
  return path.relative(paths.root, file).split(path.sep).join("/");
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function removeIfExists(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** The operator's global answer aliases (not user data): the real file, else the example. */
function answerAliasesSource(config: AppConfig): string | null {
  for (const name of ["answer-aliases.json", "answer-aliases.example.json"]) {
    const p = path.join(config.privateDir, "candidate", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function materializeWorkspace(user: OnboardedUser, opts: MaterializeOptions): Promise<MaterializeReport> {
  const config = opts.config ?? getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error(
      "TENANT_ENGINE_ENABLED is false (fail-closed default) — refusing to materialize a tenant workspace on this machine.",
    );
  }
  const paths = tenantPaths(user.userId, config.tenantsRoot);
  const now = opts.now ?? new Date();
  const m = materializeTenant(user, now);
  const written: string[] = [];
  const removed: string[] = [];
  const downloaded: string[] = [];
  const unchanged: string[] = [];

  for (const dir of [paths.candidateDir, paths.authDir, paths.atsAccountsDir, paths.browserProfilesDir, paths.secretsDir, paths.dataDir, paths.artifactsDir, paths.runsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── the engine's candidate files ─────────────────────────────────────
  const profileFile = path.join(paths.candidateDir, "public-profile.json");
  writeJson(profileFile, m.publicProfile);
  written.push(rel(paths, profileFile));

  const bankFile = path.join(paths.candidateDir, "screeners.json");
  writeJson(bankFile, m.screenerBank);
  written.push(rel(paths, bankFile));

  const aboutFile = path.join(paths.candidateDir, "about-me.md");
  if (m.aboutMe) {
    writeText(aboutFile, m.aboutMe);
    written.push(rel(paths, aboutFile));
  } else if (removeIfExists(aboutFile)) {
    removed.push(rel(paths, aboutFile));
  }

  const personaFile = path.join(paths.candidateDir, "personas", "default.json");
  if (m.persona.persona) {
    writeJson(personaFile, m.persona.persona);
    written.push(rel(paths, personaFile));
  } else if (removeIfExists(personaFile)) {
    removed.push(rel(paths, personaFile)); // a persona that no longer validates must not linger
  }

  const policyFile = path.join(paths.candidateDir, "application-education-policy.json");
  if (m.educationPolicy) {
    // Resume paths in the policy are workspace-relative; the engine
    // resolves them from the tenant's cwd, so anchor them here.
    const anchored = {
      ...m.educationPolicy,
      resumes: {
        general: path.join(paths.candidateDir, m.educationPolicy.resumes.general),
        ds_ai: path.join(paths.candidateDir, m.educationPolicy.resumes.ds_ai),
      },
      ...(m.educationPolicy.baseline_resumes
        ? {
            baseline_resumes: {
              general: path.join(paths.candidateDir, m.educationPolicy.baseline_resumes.general),
              ds_ai: path.join(paths.candidateDir, m.educationPolicy.baseline_resumes.ds_ai),
            },
          }
        : {}),
    };
    writeJson(policyFile, anchored);
    written.push(rel(paths, policyFile));
  } else if (removeIfExists(policyFile)) {
    removed.push(rel(paths, policyFile));
  }

  // Answer aliases are the operator's global phrase book, not user data.
  const aliasesSource = answerAliasesSource(config);
  const aliasesFile = path.join(paths.candidateDir, "answer-aliases.json");
  if (aliasesSource) {
    fs.copyFileSync(aliasesSource, aliasesFile);
    written.push(rel(paths, aliasesFile));
  }

  // ── documents (bytes from the user's own bucket paths) ───────────────
  const stateFile = path.join(paths.candidateDir, DOCUMENT_STATE);
  const previous: Record<string, string | null> = fs.existsSync(stateFile)
    ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, string | null>)
    : {};
  const state: Record<string, string | null> = {};
  for (const doc of m.documents) {
    const target = path.join(paths.candidateDir, doc.relativeTarget);
    const stamp = doc.uploadedAt ?? "unknown";
    state[doc.relativeTarget] = stamp;
    if (!opts.force && fs.existsSync(target) && previous[doc.relativeTarget] === stamp) {
      unchanged.push(rel(paths, target));
    } else {
      const { data, error } = await opts.client.storage.from(doc.bucket).download(doc.objectPath);
      if (error || !data) {
        throw new Error(`document download failed (${doc.bucket}/${doc.objectPath}): ${error?.message ?? "no data"}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await data.arrayBuffer()));
      downloaded.push(rel(paths, target));
    }
    if (doc.kind === "resume" && doc.isDefault) {
      const def = path.join(paths.candidateDir, "resumes", "default.pdf");
      fs.copyFileSync(target, def);
      written.push(rel(paths, def));
    }
  }
  writeJson(stateFile, state);

  // ── self-identification: RPC plaintext → sealed file, nothing else ───
  let sensitive: MaterializeReport["sensitiveProfile"] = "skipped";
  const encFile = path.join(paths.candidateDir, "sensitive-profile.enc");
  if (!opts.skipSensitive) {
    const { data, error } = await opts.client.rpc("engine_read_sensitive_profile", { p_user: paths.userId });
    if (error) throw new Error(`engine_read_sensitive_profile failed: ${error.message}`);
    const profile = toSensitiveProfile((data as SensitivePlain | null) ?? null);
    if (profile) {
      const key = opts.tenantKey ?? deriveTenantKey(resolveTenantMasterKey(config.tenantsRoot), paths.userId);
      writeEncryptedFile(encFile, profile, key);
      written.push(rel(paths, encFile));
      sensitive = "sealed";
    } else {
      if (removeIfExists(encFile)) removed.push(rel(paths, encFile));
      sensitive = "none";
    }
  }

  // ── manifest ─────────────────────────────────────────────────────────
  writeJson(paths.manifestPath, { ...m.manifest, sensitive_profile: sensitive, answer_aliases: aliasesSource ? "copied" : "missing" });
  written.push(rel(paths, paths.manifestPath));

  const report: MaterializeReport = {
    userId: paths.userId,
    root: paths.root,
    written,
    removed,
    downloaded,
    unchanged,
    persona: m.persona.persona ? "present" : "absent",
    personaReason: m.persona.reason,
    sensitiveProfile: sensitive,
    answerAliases: aliasesSource ? "copied" : "missing",
    manifestPath: paths.manifestPath,
  };
  logger.info("tenant workspace materialized", {
    service: "tenants",
    action: "materialize",
    metadata: {
      user_id: paths.userId,
      written: written.length,
      removed: removed.length,
      downloaded: downloaded.length,
      unchanged: unchanged.length,
      persona: report.persona,
      sensitive_profile: sensitive,
    },
  });
  return report;
}

/** What `tenant:status` reports per workspace — read-only, never a secret's contents. */
export type WorkspaceStatus = {
  userId: string;
  root: string;
  manifest: Record<string, unknown> | null;
  files: string[];
  sealed: string[];
  /** Plaintext left under private/unsealed/ or private/auth/*.storage.json — should be empty between runs. */
  staleUnsealed: string[];
  hasDatabase: boolean;
};

export function inspectWorkspace(userId: string, root = getConfig().tenantsRoot): WorkspaceStatus {
  const p = tenantPaths(userId, root);
  const manifest = fs.existsSync(p.manifestPath)
    ? (JSON.parse(fs.readFileSync(p.manifestPath, "utf8")) as Record<string, unknown>)
    : null;
  const files = fs.existsSync(p.candidateDir)
    ? fs.readdirSync(p.candidateDir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(p.candidateDir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join("/"))
        .sort()
    : [];
  const sealed = fs.existsSync(p.secretsDir) ? fs.readdirSync(p.secretsDir).filter((f) => f.endsWith(".enc")).sort() : [];
  const staleUnsealed = listUnsealed(p);
  return { userId: p.userId, root: p.root, manifest, files, sealed, staleUnsealed, hasDatabase: fs.existsSync(p.dbPath) };
}

/** Every workspace under the root (uuid-named directories only). */
export function listWorkspaces(root = getConfig().tenantsRoot): string[] {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) return [];
  return fs
    .readdirSync(resolved, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.name))
    .map((d) => d.name)
    .sort();
}
