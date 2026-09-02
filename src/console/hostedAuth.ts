import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Hosted-mode request security for the operator console
 * (docs/roadmap/cloud-deploy.md, "Hosted-auth design"). ADDITIVE and
 * fail-closed: nothing here runs unless CONSOLE_HOSTED_MODE_ENABLED is
 * true; local mode (security.ts — loopback Host pin + per-boot token) is
 * untouched byte-for-byte and never learns about this module.
 *
 * Hosted mode replaces BOTH local checks:
 *   - Host header must match an explicit allowlist of deployed hostnames
 *     (config, not code) — the DNS-rebinding guard for a public bind.
 *   - EVERY /api request (GET included — no "reads are safe because
 *     loopback" assumption) must carry a Supabase Auth JWT whose signature
 *     verifies against the project's JWKS, whose issuer is the project,
 *     whose audience is `authenticated`, which is unexpired, and whose
 *     `sub` is in the operator allowlist. The engine DB is single-tenant
 *     (the operator's), so only the operator's own cloud account(s) pass.
 *   - Mutations are refused outright: the hosted console is read-only in
 *     v0 (the per-boot token path does not exist in hosted mode, and no
 *     JWT unlocks a POST).
 *
 * Zero dependencies: JWS verification uses node:crypto directly (ES256 —
 * what Supabase issues for asymmetric-key projects — and RS256).
 */

export type Jwk = {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
};

export type JwtClaims = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  role?: string;
  email?: string;
  [key: string]: unknown;
};

export type VerifiedJwt = {
  sub: string;
  claims: JwtClaims;
};

export type JwtVerifyOptions = {
  issuer: string;
  audience: string;
  /** Seconds of clock skew tolerated on `exp`. */
  leewaySeconds?: number;
  now?: () => number;
};

const SUPPORTED_ALGS: Record<string, { hash: string; kty: string }> = {
  ES256: { hash: "sha256", kty: "EC" },
  RS256: { hash: "sha256", kty: "RSA" },
};

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function parseJson(buf: Buffer): unknown {
  return JSON.parse(buf.toString("utf8"));
}

/** Split a compact JWS; returns null unless the shape is exactly three base64url parts. */
export function decodeJwtUnverified(
  token: string,
): { header: { alg?: string; kid?: string; typ?: string }; claims: JwtClaims; signingInput: string; signature: Buffer } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(h) || !/^[A-Za-z0-9_-]+$/.test(p) || !/^[A-Za-z0-9_-]+$/.test(s)) {
    return null;
  }
  try {
    const header = parseJson(b64urlDecode(h));
    const claims = parseJson(b64urlDecode(p));
    if (typeof header !== "object" || header === null) return null;
    if (typeof claims !== "object" || claims === null) return null;
    return {
      header: header as { alg?: string; kid?: string; typ?: string },
      claims: claims as JwtClaims,
      signingInput: `${h}.${p}`,
      signature: b64urlDecode(s),
    };
  } catch {
    return null;
  }
}

export function jwkToKeyObject(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
}

/**
 * Verify a compact JWS against a key set. Returns the subject + claims or
 * throws with a specific, non-secret reason. Algorithm comes from the
 * TOKEN header but must be one of SUPPORTED_ALGS and must match the JWK's
 * key type — `alg: none` and HS* are rejected outright.
 */
export function verifyJwt(
  token: string,
  keys: Jwk[],
  options: JwtVerifyOptions,
): VerifiedJwt {
  const decoded = decodeJwtUnverified(token);
  if (!decoded) throw new Error("malformed token");
  const alg = decoded.header.alg ?? "";
  const spec = SUPPORTED_ALGS[alg];
  if (!spec) throw new Error(`unsupported alg: ${alg || "(none)"}`);

  const candidates = keys.filter(
    (k) =>
      k.kty === spec.kty &&
      (k.use === undefined || k.use === "sig") &&
      (k.alg === undefined || k.alg === alg) &&
      (decoded.header.kid === undefined || k.kid === decoded.header.kid),
  );
  if (candidates.length === 0) throw new Error("no matching signing key");

  const data = Buffer.from(decoded.signingInput, "utf8");
  const ok = candidates.some((jwk) => {
    try {
      const key = jwkToKeyObject(jwk);
      return alg === "ES256"
        ? cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, decoded.signature)
        : cryptoVerify("sha256", data, key, decoded.signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error("bad signature");

  const c = decoded.claims;
  const now = Math.floor((options.now ?? (() => Date.now()))() / 1000);
  const leeway = options.leewaySeconds ?? 30;
  if (typeof c.exp !== "number") throw new Error("token has no exp");
  if (c.exp + leeway <= now) throw new Error("token expired");
  if (c.iss !== options.issuer) throw new Error("wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : c.aud === undefined ? [] : [c.aud];
  if (!aud.includes(options.audience)) throw new Error("wrong audience");
  if (typeof c.sub !== "string" || c.sub === "") throw new Error("token has no sub");
  return { sub: c.sub, claims: c };
}

/**
 * JWKS cache with a TTL and a bounded refetch-on-unknown-kid (at most one
 * forced refresh per `minRefreshMs`) — no unbounded polling.
 */
export class JwksCache {
  private keys: Jwk[] = [];
  private fetchedAt = 0;
  private lastForcedRefresh = 0;

  constructor(
    private readonly fetchJwks: () => Promise<Jwk[]>,
    private readonly options: { ttlMs?: number; minRefreshMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  async get(): Promise<Jwk[]> {
    const ttl = this.options.ttlMs ?? 10 * 60_000;
    if (this.keys.length === 0 || this.now() - this.fetchedAt > ttl) {
      await this.refresh();
    }
    return this.keys;
  }

  /** Called when a token names a kid we do not hold; rate-limited. */
  async refreshForUnknownKid(): Promise<Jwk[]> {
    const min = this.options.minRefreshMs ?? 60_000;
    if (this.now() - this.lastForcedRefresh < min) return this.keys;
    this.lastForcedRefresh = this.now();
    await this.refresh();
    return this.keys;
  }

  private async refresh(): Promise<void> {
    const keys = await this.fetchJwks();
    if (!Array.isArray(keys)) throw new Error("JWKS response is not a key array");
    this.keys = keys;
    this.fetchedAt = this.now();
  }
}

export async function fetchSupabaseJwks(supabaseUrl: string): Promise<Jwk[]> {
  const base = supabaseUrl.replace(/\/+$/, "");
  const r = await fetch(`${base}/auth/v1/.well-known/jwks.json`);
  if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
  const body = (await r.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

export function supabaseIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

/** Comma/whitespace-separated list → trimmed, lowercased, de-duplicated. */
export function parseList(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Host header (port stripped, lowercased) must be one of the deployed hostnames. */
export function checkAllowedHost(req: IncomingMessage, allowedHosts: string[]): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name !== "" && allowedHosts.includes(name);
}

export function bearerFromRequest(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

export type HostedAuthConfig = {
  supabaseUrl: string;
  allowedHosts: string[];
  allowedUserIds: string[];
};

export type HostedAuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * The hosted-mode gate for one API request. Pure over its inputs apart
 * from the JWKS cache; never throws for a bad token — it classifies.
 */
export class HostedAuthenticator {
  private readonly jwks: JwksCache;
  private readonly issuer: string;

  constructor(
    private readonly config: HostedAuthConfig,
    deps: { fetchJwks?: () => Promise<Jwk[]>; now?: () => number } = {},
  ) {
    this.issuer = supabaseIssuer(config.supabaseUrl);
    this.jwks = new JwksCache(
      deps.fetchJwks ?? (() => fetchSupabaseJwks(config.supabaseUrl)),
      { ...(deps.now ? { now: deps.now } : {}) },
    );
    this.now = deps.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  async authenticate(req: IncomingMessage): Promise<HostedAuthResult> {
    const token = bearerFromRequest(req);
    if (token === null) return { ok: false, status: 401, error: "missing bearer token" };
    const decoded = decodeJwtUnverified(token);
    if (!decoded) return { ok: false, status: 401, error: "malformed token" };

    let keys: Jwk[];
    try {
      keys = await this.jwks.get();
      const kid = decoded.header.kid;
      if (kid !== undefined && !keys.some((k) => k.kid === kid)) {
        keys = await this.jwks.refreshForUnknownKid();
      }
    } catch (err) {
      return {
        ok: false,
        status: 401,
        error: `signing keys unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let verified: VerifiedJwt;
    try {
      verified = verifyJwt(token, keys, {
        issuer: this.issuer,
        audience: "authenticated",
        now: this.now,
      });
    } catch (err) {
      return { ok: false, status: 401, error: err instanceof Error ? err.message : String(err) };
    }
    if (!this.config.allowedUserIds.includes(verified.sub.toLowerCase())) {
      return { ok: false, status: 403, error: "user not allowed on this console" };
    }
    return { ok: true, userId: verified.sub };
  }
}
