import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfig } from "../config/index.js";
import { deriveTenantKey } from "../tenants/keys.js";
import { tenantMasterKeyPath } from "../tenants/paths.js";

const KEY_BYTES = 32;

export function candidateKeyPaths(privateDir = getConfig().privateDir): {
  dpapiKeyPath: string;
  encProfilePath: string;
  plaintextDraftPath: string;
} {
  const dir = path.join(privateDir, "candidate");
  return {
    dpapiKeyPath: path.join(dir, "master.key.dpapi"),
    encProfilePath: path.join(dir, "sensitive-profile.enc"),
    plaintextDraftPath: path.join(dir, "sensitive-profile.draft.json"),
  };
}

/**
 * The key-provider seam (plan v0.5, M13). Three providers, selected by
 * CANDIDATE_KEY_PROVIDER in the process env:
 *
 *   dpapi   the operator's own Windows DPAPI-wrapped master (today's path)
 *   env     the insecure test key (ALLOW_INSECURE_CANDIDATE_KEY=1 + CANDIDATE_DATA_KEY)
 *   tenant  a per-tenant key: HKDF of the DPAPI-wrapped master under
 *           TENANTS_ROOT with TENANT_USER_ID as the salt (src/tenants/keys.ts).
 *           Set only in a tenant child's env by the tenant runner.
 *
 * ABSENT ⇒ exactly the pre-M13 behaviour: env when the insecure switch is
 * on, otherwise dpapi. A later Fargate deployment swaps the master's
 * source (KMS) inside the tenant branch; nothing above this seam changes.
 */
export type CandidateKeyProvider = "dpapi" | "env" | "tenant";

export function selectedKeyProvider(env: NodeJS.ProcessEnv = process.env): CandidateKeyProvider {
  const raw = env.CANDIDATE_KEY_PROVIDER?.trim().toLowerCase();
  if (raw === "dpapi" || raw === "env" || raw === "tenant") return raw;
  if (raw) throw new Error(`CANDIDATE_KEY_PROVIDER must be dpapi|env|tenant (got "${raw}")`);
  return env.ALLOW_INSECURE_CANDIDATE_KEY === "1" ? "env" : "dpapi";
}

/** Resolve the 32-byte AES key for THIS process's candidate data. */
export function resolveCandidateDataKey(): Buffer {
  switch (selectedKeyProvider()) {
    case "env":
      return insecureEnvKey();
    case "tenant":
      return resolveTenantKey();
    case "dpapi":
      return operatorDpapiKey();
  }
}

function insecureEnvKey(): Buffer {
  if (process.env.ALLOW_INSECURE_CANDIDATE_KEY !== "1") {
    throw new Error("the env key provider requires ALLOW_INSECURE_CANDIDATE_KEY=1 (tests/dev only)");
  }
  const raw = process.env.CANDIDATE_DATA_KEY;
  if (!raw) {
    throw new Error(
      "ALLOW_INSECURE_CANDIDATE_KEY=1 requires CANDIDATE_DATA_KEY (tests/dev only)",
    );
  }
  return normalizeKeyMaterial(raw);
}

function operatorDpapiKey(): Buffer {
  if (process.platform === "win32") {
    return loadOrCreateDpapiKey(candidateKeyPaths().dpapiKeyPath);
  }
  throw new Error(
    "Candidate data key unavailable. On Windows, DPAPI master.key.dpapi is used. " +
      "For tests only, set ALLOW_INSECURE_CANDIDATE_KEY=1 and CANDIDATE_DATA_KEY.",
  );
}

/**
 * Per-tenant key. The master is the DPAPI-wrapped file under TENANTS_ROOT
 * (or, in tests, the insecure env material standing in for it); the
 * tenant key is derived, never stored, and the master never leaves here.
 */
function resolveTenantKey(): Buffer {
  const userId = process.env.TENANT_USER_ID?.trim();
  if (!userId) {
    throw new Error("CANDIDATE_KEY_PROVIDER=tenant requires TENANT_USER_ID in the child env");
  }
  return deriveTenantKey(resolveTenantMasterKey(), userId);
}

/**
 * The tenant MASTER (the parent process — materializer, runner — needs it
 * to derive a tenant's key before spawning the child). DPAPI-wrapped file
 * under TENANTS_ROOT, created on first use; in tests the insecure env
 * material stands in for it. Callers derive; they never persist this.
 */
export function resolveTenantMasterKey(tenantsRoot = getConfig().tenantsRoot): Buffer {
  if (process.env.ALLOW_INSECURE_CANDIDATE_KEY === "1" && process.env.CANDIDATE_DATA_KEY) {
    return normalizeKeyMaterial(process.env.CANDIDATE_DATA_KEY);
  }
  if (process.platform !== "win32") {
    throw new Error("tenant master key needs Windows DPAPI on this host (Fargate swaps in KMS at this seam)");
  }
  return loadOrCreateDpapiKey(tenantMasterKeyPath(tenantsRoot));
}

function normalizeKeyMaterial(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

function loadOrCreateDpapiKey(dpapiKeyPath: string): Buffer {
  fs.mkdirSync(path.dirname(dpapiKeyPath), { recursive: true });
  if (fs.existsSync(dpapiKeyPath)) {
    return unprotectDpapiFile(dpapiKeyPath);
  }
  const key = randomBytes(KEY_BYTES);
  protectDpapiFile(dpapiKeyPath, key);
  return key;
}

function protectDpapiFile(filePath: string, plaintext: Buffer): void {
  const b64 = plaintext.toString("base64");
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes('${filePath.replace(/'/g, "''")}', $protected)
`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function unprotectDpapiFile(filePath: string): Buffer {
  const script = `
Add-Type -AssemblyName System.Security
$protected = [IO.File]::ReadAllBytes('${filePath.replace(/'/g, "''")}')
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($bytes)
`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  const key = Buffer.from(out, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`DPAPI key has unexpected length ${key.length}`);
  }
  return key;
}

export type EncryptedBlob = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function encryptJson(data: unknown, key = resolveCandidateDataKey()): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson<T>(blob: EncryptedBlob, key = resolveCandidateDataKey()): T {
  if (blob.v !== 1 || blob.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted blob format");
  }
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function writeEncryptedFile(
  filePath: string,
  data: unknown,
  key = resolveCandidateDataKey(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const blob = encryptJson(data, key);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(blob, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readEncryptedFile<T>(
  filePath: string,
  key = resolveCandidateDataKey(),
): T {
  const blob = JSON.parse(fs.readFileSync(filePath, "utf8")) as EncryptedBlob;
  return decryptJson<T>(blob, key);
}
