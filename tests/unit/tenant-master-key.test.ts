import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTenantMasterKey, resolveTenantMasterKey } from "../../src/candidate/sensitiveCrypto.js";

/**
 * The hosted engine's master key seam (deploy/aws): on Linux there is no
 * DPAPI, so the tenant master arrives from the host's secret store as
 * TENANT_MASTER_KEY. The two things pinned here: only real key material
 * is accepted (a passphrase is refused by name, never hashed into a
 * key), and the injected key wins over the insecure test path and over
 * the platform check. UNIT_CONFIRMED.
 */

const HEX = "a".repeat(32) + "b".repeat(32);
const B64 = Buffer.from(HEX, "hex").toString("base64");

describe("TENANT_MASTER_KEY (UNIT_CONFIRMED)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["TENANT_MASTER_KEY", "ALLOW_INSECURE_CANDIDATE_KEY", "CANDIDATE_DATA_KEY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("accepts 64 hex chars or 44-char base64 of 32 bytes, and nothing else", () => {
    expect(parseTenantMasterKey(HEX)).toEqual(Buffer.from(HEX, "hex"));
    expect(parseTenantMasterKey(` ${B64}\n`)).toEqual(Buffer.from(HEX, "hex"));
    for (const bad of ["", "correct horse battery staple", HEX.slice(0, 62), `${HEX}00`, Buffer.alloc(31, 1).toString("base64")]) {
      expect(() => parseTenantMasterKey(bad)).toThrow(/TENANT_MASTER_KEY must be 32 random bytes/);
    }
  });

  it("the injected key wins over the insecure test path and needs no DPAPI", () => {
    process.env.TENANT_MASTER_KEY = HEX;
    process.env.ALLOW_INSECURE_CANDIDATE_KEY = "1";
    process.env.CANDIDATE_DATA_KEY = "something else";
    expect(resolveTenantMasterKey("/nonexistent/tenants")).toEqual(Buffer.from(HEX, "hex"));
  });

  it("a malformed injected key refuses by name without falling back to anything", () => {
    process.env.TENANT_MASTER_KEY = "not-a-key";
    process.env.ALLOW_INSECURE_CANDIDATE_KEY = "1";
    process.env.CANDIDATE_DATA_KEY = "fallback";
    expect(() => resolveTenantMasterKey("/nonexistent/tenants")).toThrow(/TENANT_MASTER_KEY must be/);
  });

  it("error text never echoes the value", () => {
    process.env.TENANT_MASTER_KEY = "hunter2-secret-passphrase";
    let message = "";
    try {
      resolveTenantMasterKey("/nonexistent/tenants");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("hunter2");
  });
});
