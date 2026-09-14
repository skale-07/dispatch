import fs from "node:fs";
import path from "node:path";
import { readEncryptedFile, writeEncryptedFile } from "../candidate/sensitiveCrypto.js";
import type { TenantPaths } from "./paths.js";

/**
 * Sealed tenant secrets: the captured JobRight storage state, a Gmail
 * refresh token — anything that must survive between runs. Each lives as
 * <workspace>/secrets/<name>.enc, AES-256-GCM under the TENANT key (the
 * same blob format as the operator's sensitive-profile.enc, via the
 * candidate crypto seam). A run unseals what it needs into
 * private/unsealed/, and wipeUnsealed() removes every plaintext file when
 * the run ends, success or not.
 *
 * Names are a closed shape so a cloud row can never pick a filename.
 */

export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function assertSecretName(name: string): string {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(`invalid secret name "${name}" (lowercase letters, digits, . _ - ; max 64)`);
  }
  return name;
}

export function sealedPath(paths: TenantPaths, name: string): string {
  return path.join(paths.secretsDir, `${assertSecretName(name)}.enc`);
}

/** Write (or replace) a sealed secret; returns its path. */
export function sealSecret(paths: TenantPaths, name: string, data: unknown, tenantKey: Buffer): string {
  const target = sealedPath(paths, name);
  writeEncryptedFile(target, data, tenantKey);
  return target;
}

/** Read a sealed secret, or null when none is on file. A wrong key throws (GCM tag). */
export function unsealSecret<T>(paths: TenantPaths, name: string, tenantKey: Buffer): T | null {
  const target = sealedPath(paths, name);
  if (!fs.existsSync(target)) return null;
  return readEncryptedFile<T>(target, tenantKey);
}

export function hasSealed(paths: TenantPaths, name: string): boolean {
  return fs.existsSync(sealedPath(paths, name));
}

export function listSealed(paths: TenantPaths): string[] {
  if (!fs.existsSync(paths.secretsDir)) return [];
  return fs
    .readdirSync(paths.secretsDir)
    .filter((f) => f.endsWith(".enc"))
    .map((f) => f.slice(0, -".enc".length))
    .sort();
}

/**
 * Write plaintext the run needs (e.g. a Playwright storageState) under
 * private/unsealed/. Returns the path. Callers pair this with
 * wipeUnsealed() in a finally.
 */
export function writeUnsealed(paths: TenantPaths, name: string, data: unknown): string {
  fs.mkdirSync(paths.unsealedDir, { recursive: true });
  const target = path.join(paths.unsealedDir, `${assertSecretName(name)}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

/**
 * The one plaintext file the engine reads from a FIXED location: the
 * Playwright storageState at <privateDir>/auth/<service>.storage.json
 * (src/auth/serviceRegistry.ts derives it from PRIVATE_DIR). Written for
 * the run, listed as unsealed plaintext, wiped with the rest.
 */
export function unsealedStorageStatePath(paths: TenantPaths, service: "jobright" | "linkedin" | "outlook" | "gmail"): string {
  return path.join(paths.authDir, `${service}.storage.json`);
}

export function writeUnsealedStorageState(
  paths: TenantPaths,
  service: "jobright" | "linkedin" | "outlook" | "gmail",
  state: unknown,
): string {
  fs.mkdirSync(paths.authDir, { recursive: true });
  const target = unsealedStorageStatePath(paths, service);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

/** Plaintext currently on disk that should not outlive a run (workspace-relative). */
export function listUnsealed(paths: TenantPaths): string[] {
  const out: string[] = [];
  if (fs.existsSync(paths.unsealedDir)) {
    for (const entry of fs.readdirSync(paths.unsealedDir)) out.push(`private/unsealed/${entry}`);
  }
  if (fs.existsSync(paths.authDir)) {
    for (const entry of fs.readdirSync(paths.authDir)) {
      if (entry.endsWith(".storage.json")) out.push(`private/auth/${entry}`);
    }
  }
  return out.sort();
}

/**
 * Remove every unsealed plaintext file (private/unsealed/* and the
 * auth/*.storage.json a run wrote); returns how many were removed.
 * Idempotent.
 */
export function wipeUnsealed(paths: TenantPaths): number {
  let n = 0;
  if (fs.existsSync(paths.unsealedDir)) {
    for (const entry of fs.readdirSync(paths.unsealedDir)) {
      fs.rmSync(path.join(paths.unsealedDir, entry), { recursive: true, force: true });
      n += 1;
    }
  }
  if (fs.existsSync(paths.authDir)) {
    for (const entry of fs.readdirSync(paths.authDir)) {
      if (!entry.endsWith(".storage.json")) continue;
      fs.rmSync(path.join(paths.authDir, entry), { force: true });
      n += 1;
    }
  }
  return n;
}
