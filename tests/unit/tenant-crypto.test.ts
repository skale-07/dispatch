import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson, resolveCandidateDataKey, selectedKeyProvider } from "../../src/candidate/sensitiveCrypto.js";
import { resetConfigCache } from "../../src/config/index.js";
import { deriveTenantKey, TENANT_KEY_BYTES } from "../../src/tenants/keys.js";
import { assertTenantId, isInsideTenant, tenantMasterKeyPath, tenantPaths } from "../../src/tenants/paths.js";
import {
  hasSealed,
  listSealed,
  sealSecret,
  sealedPath,
  unsealSecret,
  wipeUnsealed,
  writeUnsealed,
} from "../../src/tenants/secrets.js";

/**
 * Plan M13 — the candidate key-provider seam and the tenant workspace
 * primitives. No DPAPI here: the tenant provider is exercised through the
 * insecure test master (ALLOW_INSECURE_CANDIDATE_KEY=1), exactly as the
 * operator's own key path is in other tests. UNIT_CONFIRMED.
 */

const A = "11111111-2222-4333-8444-555555555555";
const B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const MASTER = Buffer.alloc(32, 7);

describe("tenant ids and paths (UNIT_CONFIRMED)", () => {
  it("only a canonical uuid becomes a workspace path", () => {
    expect(assertTenantId(` ${A.toUpperCase()} `)).toBe(A);
    for (const bad of ["", "..", "../x", "not-a-uuid", `${A}/..`, "11111111222243338444555555555555"]) {
      expect(() => assertTenantId(bad), bad).toThrow(/canonical uuid/);
    }
  });

  it("every path lies under <root>/<uuid>", () => {
    const root = path.join(os.tmpdir(), "dispatch-tenants-test");
    const p = tenantPaths(A, root);
    expect(p.root).toBe(path.join(path.resolve(root), A));
    for (const k of ["manifestPath", "privateDir", "candidateDir", "authDir", "atsAccountsDir", "browserProfilesDir", "unsealedDir", "secretsDir", "dataDir", "dbPath", "artifactsDir", "runsDir"] as const) {
      expect(isInsideTenant(p, p[k]), k).toBe(true);
    }
    expect(p.dbPath).toBe(path.join(p.root, "data", "app.sqlite"));
    expect(isInsideTenant(p, tenantPaths(B, root).dbPath)).toBe(false);
    expect(isInsideTenant(p, path.join(p.root, "..", "master.key.dpapi"))).toBe(false);
    expect(tenantMasterKeyPath(root)).toBe(path.join(path.resolve(root), "master.key.dpapi"));
  });
});

describe("per-tenant keys (UNIT_CONFIRMED)", () => {
  it("HKDF: deterministic per tenant, distinct across tenants, 32 bytes, never the master", () => {
    const a1 = deriveTenantKey(MASTER, A);
    const a2 = deriveTenantKey(MASTER, A.toUpperCase());
    const b = deriveTenantKey(MASTER, B);
    expect(a1.length).toBe(TENANT_KEY_BYTES);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
    expect(a1.equals(MASTER)).toBe(false);
    expect(deriveTenantKey(Buffer.alloc(32, 8), A).equals(a1)).toBe(false);
    expect(() => deriveTenantKey(Buffer.alloc(16, 1), A)).toThrow(/at least 32 bytes/);
    expect(() => deriveTenantKey(MASTER, "nope")).toThrow(/canonical uuid/);
  });

  it("a blob sealed for tenant A does not open for tenant B", () => {
    const blob = encryptJson({ token: "t" }, deriveTenantKey(MASTER, A));
    expect(decryptJson<{ token: string }>(blob, deriveTenantKey(MASTER, A)).token).toBe("t");
    expect(() => decryptJson(blob, deriveTenantKey(MASTER, B))).toThrow();
  });
});

describe("key provider seam (UNIT_CONFIRMED)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["CANDIDATE_KEY_PROVIDER", "ALLOW_INSECURE_CANDIDATE_KEY", "CANDIDATE_DATA_KEY", "TENANT_USER_ID", "TENANTS_ROOT"];
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetConfigCache();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });

  it("absent ⇒ today's path (env when the insecure switch is on, else dpapi); unknown values refuse", () => {
    expect(selectedKeyProvider({})).toBe("dpapi");
    expect(selectedKeyProvider({ ALLOW_INSECURE_CANDIDATE_KEY: "1" })).toBe("env");
    expect(selectedKeyProvider({ CANDIDATE_KEY_PROVIDER: "tenant" })).toBe("tenant");
    expect(() => selectedKeyProvider({ CANDIDATE_KEY_PROVIDER: "kms" })).toThrow(/dpapi\|env\|tenant/);
  });

  it("tenant provider: needs TENANT_USER_ID, derives from the (test) master, differs per tenant", () => {
    process.env.CANDIDATE_KEY_PROVIDER = "tenant";
    process.env.ALLOW_INSECURE_CANDIDATE_KEY = "1";
    process.env.CANDIDATE_DATA_KEY = "test-master-material";
    expect(() => resolveCandidateDataKey()).toThrow(/TENANT_USER_ID/);
    process.env.TENANT_USER_ID = A;
    const a = resolveCandidateDataKey();
    process.env.TENANT_USER_ID = B;
    const b = resolveCandidateDataKey();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    // The env provider with the same material is the MASTER, never a tenant key.
    process.env.CANDIDATE_KEY_PROVIDER = "env";
    expect(resolveCandidateDataKey().equals(a)).toBe(false);
  });

  it("env provider still requires the explicit insecure switch", () => {
    process.env.CANDIDATE_KEY_PROVIDER = "env";
    process.env.CANDIDATE_DATA_KEY = "x";
    expect(() => resolveCandidateDataKey()).toThrow(/ALLOW_INSECURE_CANDIDATE_KEY/);
  });
});

describe("sealed secrets + unsealed plaintext (UNIT_CONFIRMED)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-tenant-secrets-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("seal / unseal round-trips under the tenant key; wrong tenant cannot read; names are closed", () => {
    const p = tenantPaths(A, root);
    const keyA = deriveTenantKey(MASTER, A);
    expect(unsealSecret(p, "jobright.storage", keyA)).toBeNull();
    const file = sealSecret(p, "jobright.storage", { cookies: [1, 2] }, keyA);
    expect(file).toBe(sealedPath(p, "jobright.storage"));
    expect(isInsideTenant(p, file)).toBe(true);
    expect(hasSealed(p, "jobright.storage")).toBe(true);
    expect(listSealed(p)).toEqual(["jobright.storage"]);
    expect(unsealSecret<{ cookies: number[] }>(p, "jobright.storage", keyA)?.cookies).toEqual([1, 2]);
    expect(() => unsealSecret(p, "jobright.storage", deriveTenantKey(MASTER, B))).toThrow();
    // The file on disk is ciphertext, not the secret.
    expect(fs.readFileSync(file, "utf8")).not.toContain("cookies");
    for (const bad of ["", "../x", "UPPER", "a/b", "x".repeat(65)]) {
      expect(() => sealedPath(p, bad), bad).toThrow(/invalid secret name/);
    }
  });

  it("unsealed plaintext lives only under private/unsealed and wipeUnsealed removes all of it", () => {
    const p = tenantPaths(A, root);
    const f1 = writeUnsealed(p, "jobright.storage", { a: 1 });
    const f2 = writeUnsealed(p, "gmail.token", { b: 2 });
    expect(path.dirname(f1)).toBe(p.unsealedDir);
    expect(fs.existsSync(f2)).toBe(true);
    expect(wipeUnsealed(p)).toBe(2);
    expect(fs.readdirSync(p.unsealedDir)).toEqual([]);
    expect(wipeUnsealed(p)).toBe(0);
    expect(wipeUnsealed(tenantPaths(B, root))).toBe(0);
  });
});
