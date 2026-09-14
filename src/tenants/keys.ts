import { hkdfSync } from "node:crypto";
import { assertTenantId } from "./paths.js";

/**
 * Per-tenant data keys (plan v0.5 "key provider seam").
 *
 * One DPAPI-wrapped master under TENANTS_ROOT; each tenant's 32-byte
 * AES-256-GCM key is HKDF-SHA256(master, salt = tenant uuid, info below).
 * Deterministic — the same master and uuid always yield the same key, so
 * nothing per tenant is stored — and one-way: a tenant key reveals nothing
 * about the master or any other tenant's key. Fargate later swaps the
 * master's SOURCE (KMS) at this seam; the derivation stays.
 *
 * The master itself is never handed to callers; they get a tenant key.
 */

export const TENANT_KEY_BYTES = 32;
export const TENANT_KEY_INFO = "dispatch/tenant-candidate-key/v1";

export function deriveTenantKey(master: Buffer, userId: string): Buffer {
  if (master.length < 32) {
    throw new Error("tenant master key must be at least 32 bytes");
  }
  const id = assertTenantId(userId);
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(id, "utf8"), TENANT_KEY_INFO, TENANT_KEY_BYTES));
}
