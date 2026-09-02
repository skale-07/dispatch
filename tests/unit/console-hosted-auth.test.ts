import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createConsoleHandler } from "../../src/console/server.js";
import { generateBootToken } from "../../src/console/security.js";
import {
  checkAllowedHost,
  decodeJwtUnverified,
  HostedAuthenticator,
  JwksCache,
  parseList,
  supabaseIssuer,
  verifyJwt,
  type Jwk,
} from "../../src/console/hostedAuth.js";
import { loadConfig, resetConfigCache } from "../../src/config/index.js";

/**
 * Hosted-mode console auth (CONSOLE_HOSTED_MODE_ENABLED). Tokens here are
 * signed with a throwaway ES256 keypair generated per test file — the
 * same JWS shape (alg/kid header, iss/aud/sub/exp claims) Supabase Auth
 * issues, verified by the same node:crypto path.
 */

const SUPABASE_URL = "https://testref.supabase.co";
const ISSUER = supabaseIssuer(SUPABASE_URL);
const OPERATOR_UID = "11111111-2222-3333-4444-555555555555";
const STRANGER_UID = "99999999-8888-7777-6666-555555555555";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function keypair(kid: string): { jwk: Jwk; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  return { jwk: { ...jwk, kid, alg: "ES256", use: "sig" }, privateKey };
}

function sign(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const signer = createSign("sha256");
  signer.update(`${h}.${p}`);
  const sig = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64url(sig)}`;
}

const NOW = 1_800_000_000_000; // fixed clock (ms)
function claimsFor(sub: string, overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: "authenticated",
    sub,
    role: "authenticated",
    iat: NOW / 1000 - 60,
    exp: NOW / 1000 + 3600,
    ...overrides,
  };
}

const KEY = keypair("kid-1");
const OTHER = keypair("kid-other");

describe("verifyJwt (UNIT_CONFIRMED)", () => {
  const opts = { issuer: ISSUER, audience: "authenticated", now: () => NOW };

  it("accepts a well-formed ES256 token from a JWKS key", () => {
    const token = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1", typ: "JWT" }, claimsFor(OPERATOR_UID));
    const out = verifyJwt(token, [KEY.jwk], opts);
    expect(out.sub).toBe(OPERATOR_UID);
    expect(out.claims.role).toBe("authenticated");
  });

  it("rejects a token signed by a different key, and a tampered payload", () => {
    const foreign = sign(OTHER.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(OPERATOR_UID));
    expect(() => verifyJwt(foreign, [KEY.jwk], opts)).toThrow(/bad signature/);
    const good = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(STRANGER_UID));
    const [h, , s] = good.split(".") as [string, string, string];
    const tampered = `${h}.${b64url(JSON.stringify(claimsFor(OPERATOR_UID)))}.${s}`;
    expect(() => verifyJwt(tampered, [KEY.jwk], opts)).toThrow(/bad signature/);
  });

  it("rejects alg=none, HS256, unknown kid, expiry, wrong issuer, wrong audience, missing sub", () => {
    const none = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claimsFor(OPERATOR_UID)))}.`;
    expect(() => verifyJwt(none, [KEY.jwk], opts)).toThrow(/malformed|unsupported/);
    const hs = `${b64url(JSON.stringify({ alg: "HS256" }))}.${b64url(JSON.stringify(claimsFor(OPERATOR_UID)))}.${b64url("x")}`;
    expect(() => verifyJwt(hs, [KEY.jwk], opts)).toThrow(/unsupported alg: HS256/);
    const unknownKid = sign(KEY.privateKey, { alg: "ES256", kid: "nope" }, claimsFor(OPERATOR_UID));
    expect(() => verifyJwt(unknownKid, [KEY.jwk], opts)).toThrow(/no matching signing key/);
    const expired = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(OPERATOR_UID, { exp: NOW / 1000 - 120 }));
    expect(() => verifyJwt(expired, [KEY.jwk], opts)).toThrow(/expired/);
    const issuer = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(OPERATOR_UID, { iss: "https://evil.example/auth/v1" }));
    expect(() => verifyJwt(issuer, [KEY.jwk], opts)).toThrow(/issuer/);
    const aud = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(OPERATOR_UID, { aud: "anon" }));
    expect(() => verifyJwt(aud, [KEY.jwk], opts)).toThrow(/audience/);
    const nosub = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(OPERATOR_UID, { sub: "" }));
    expect(() => verifyJwt(nosub, [KEY.jwk], opts)).toThrow(/sub/);
  });

  it("decodeJwtUnverified rejects non-JWS shapes", () => {
    expect(decodeJwtUnverified("abc")).toBeNull();
    expect(decodeJwtUnverified("a.b")).toBeNull();
    expect(decodeJwtUnverified("a.b.c.d")).toBeNull();
    expect(decodeJwtUnverified("!!.b.c")).toBeNull();
  });
});

describe("JwksCache (UNIT_CONFIRMED, bounded refresh)", () => {
  it("fetches once within the TTL and rate-limits unknown-kid refreshes", async () => {
    let clock = NOW;
    let fetches = 0;
    const cache = new JwksCache(
      async () => {
        fetches += 1;
        return [KEY.jwk];
      },
      { ttlMs: 10_000, minRefreshMs: 5_000, now: () => clock },
    );
    await cache.get();
    await cache.get();
    expect(fetches).toBe(1);
    await cache.refreshForUnknownKid();
    await cache.refreshForUnknownKid(); // within minRefreshMs ⇒ no fetch
    expect(fetches).toBe(2);
    clock += 11_000;
    await cache.get(); // TTL elapsed
    expect(fetches).toBe(3);
  });
});

describe("hosted helpers (UNIT_CONFIRMED)", () => {
  it("parseList normalizes and de-duplicates", () => {
    expect(parseList(" Console.Example.com, console.example.com\nAPI.example.com ")).toEqual([
      "console.example.com",
      "api.example.com",
    ]);
    expect(parseList(undefined)).toEqual([]);
  });

  it("checkAllowedHost matches the allowlist exactly (port stripped), never loopback by default", () => {
    const req = (host?: string) => ({ headers: host ? { host } : {} }) as IncomingMessage;
    const allowed = ["console.example.com"];
    expect(checkAllowedHost(req("console.example.com"), allowed)).toBe(true);
    expect(checkAllowedHost(req("CONSOLE.example.com:8899"), allowed)).toBe(true);
    expect(checkAllowedHost(req("127.0.0.1"), allowed)).toBe(false);
    expect(checkAllowedHost(req("evil.example"), allowed)).toBe(false);
    expect(checkAllowedHost(req(), allowed)).toBe(false);
  });
});

describe("hosted mode config gate (UNIT_CONFIRMED, fail-closed)", () => {
  it("is off by default and leaves the local CONSOLE_HOST assertion intact", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.consoleHostedModeEnabled).toBe(false);
    expect(cfg.consoleHostedAllowedHosts).toEqual([]);
    expect(() => loadConfig({ CONSOLE_HOST: "0.0.0.0" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /CONSOLE_HOST must be 127.0.0.1 or localhost/,
    );
  });

  it("refuses to load hosted mode without SUPABASE_URL + both allowlists", () => {
    expect(() =>
      loadConfig({ CONSOLE_HOSTED_MODE_ENABLED: "true" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/SUPABASE_URL, CONSOLE_HOSTED_ALLOWED_HOSTS, CONSOLE_HOSTED_ALLOWED_USER_IDS/);
    expect(() =>
      loadConfig({
        CONSOLE_HOSTED_MODE_ENABLED: "true",
        SUPABASE_URL,
        CONSOLE_HOSTED_ALLOWED_HOSTS: "console.example.com",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/CONSOLE_HOSTED_ALLOWED_USER_IDS/);
  });

  it("allows a public bind only when fully configured", () => {
    const cfg = loadConfig({
      CONSOLE_HOSTED_MODE_ENABLED: "true",
      CONSOLE_HOST: "0.0.0.0",
      SUPABASE_URL,
      CONSOLE_HOSTED_ALLOWED_HOSTS: "console.example.com",
      CONSOLE_HOSTED_ALLOWED_USER_IDS: OPERATOR_UID.toUpperCase(),
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.consoleHostedModeEnabled).toBe(true);
    expect(cfg.consoleHost).toBe("0.0.0.0");
    expect(cfg.consoleHostedAllowedUserIds).toEqual([OPERATOR_UID]);
  });
});

type FakeResponse = { statusCode: number; body: string };

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  url: string,
  options: { host?: string | null; bearer?: string } = {},
): Promise<FakeResponse> {
  const out: FakeResponse = { statusCode: 0, body: "" };
  const headers: Record<string, string> = {};
  if (options.host !== null) headers["host"] = options.host ?? "console.example.com";
  if (options.bearer) headers["authorization"] = `Bearer ${options.bearer}`;
  const req = Object.assign(
    (async function* () {})(),
    { method, url, headers },
  ) as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number) {
      out.statusCode = status;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer) {
      out.body = chunk === undefined ? "" : chunk.toString();
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return out;
}

describe("console handler in hosted mode (UNIT_CONFIRMED)", () => {
  let tmpDir: string;
  let db: Db;
  const bootToken = generateBootToken();
  let jwksFetches = 0;

  function hostedHandler(allowedUserIds: string[] = [OPERATOR_UID]) {
    const auth = new HostedAuthenticator(
      { supabaseUrl: SUPABASE_URL, allowedHosts: ["console.example.com"], allowedUserIds },
      {
        fetchJwks: async () => {
          jwksFetches += 1;
          return [KEY.jwk];
        },
        now: () => NOW,
      },
    );
    return createConsoleHandler({
      db,
      token: bootToken,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
      hosted: { auth, allowedHosts: ["console.example.com"] },
    });
  }

  function localHandler() {
    return createConsoleHandler({
      db,
      token: bootToken,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
    });
  }

  const operatorJwt = () =>
    sign(KEY.privateKey, { alg: "ES256", kid: "kid-1", typ: "JWT" }, claimsFor(OPERATOR_UID));

  beforeEach(() => {
    resetConfigCache();
    jwksFetches = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-hosted-"));
    fs.mkdirSync(path.join(tmpDir, "dist"));
    fs.writeFileSync(path.join(tmpDir, "dist", "index.html"), "<html>spa</html>");
    const dbPath = path.join(tmpDir, "app.sqlite");
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("requires a valid operator JWT on GET /api routes (no loopback read exemption)", async () => {
    const h = hostedHandler();
    expect((await invoke(h, "GET", "/api/summary")).statusCode).toBe(401);
    expect(JSON.parse((await invoke(h, "GET", "/api/summary")).body).error).toBe("missing bearer token");
    // The per-boot token is NOT a credential in hosted mode.
    expect((await invoke(h, "GET", "/api/summary", { bearer: bootToken })).statusCode).toBe(401);
    const ok = await invoke(h, "GET", "/api/summary", { bearer: operatorJwt() });
    expect(ok.statusCode).toBe(200);
    expect(typeof JSON.parse(ok.body)).toBe("object");
    expect(jwksFetches).toBe(1);
  });

  it("rejects an authenticated but non-allowlisted user with 403", async () => {
    const h = hostedHandler();
    const stranger = sign(KEY.privateKey, { alg: "ES256", kid: "kid-1" }, claimsFor(STRANGER_UID));
    const r = await invoke(h, "GET", "/api/summary", { bearer: stranger });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/not allowed/);
  });

  it("pins the Host header to the deployed hostname allowlist; loopback is not special", async () => {
    const h = hostedHandler();
    const jwt = operatorJwt();
    expect((await invoke(h, "GET", "/api/summary", { host: "127.0.0.1", bearer: jwt })).statusCode).toBe(403);
    expect((await invoke(h, "GET", "/api/summary", { host: "evil.example", bearer: jwt })).statusCode).toBe(403);
    expect((await invoke(h, "GET", "/api/summary", { host: null, bearer: jwt })).statusCode).toBe(403);
    expect((await invoke(h, "GET", "/api/summary", { host: "console.example.com:443", bearer: jwt })).statusCode).toBe(200);
  });

  it("is read-only: every POST /api is refused even with a valid JWT or the boot token", async () => {
    const h = hostedHandler();
    for (const bearer of [operatorJwt(), bootToken, undefined]) {
      const r = await invoke(h, "POST", "/api/automation/arm", bearer ? { bearer } : {});
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.body).error).toBe("hosted console is read-only");
    }
    expect((await invoke(h, "PUT", "/api/summary", { bearer: operatorJwt() })).statusCode).toBe(405);
  });

  it("serves the static bundle without a token (nothing sensitive lives there)", async () => {
    const h = hostedHandler();
    const r = await invoke(h, "GET", "/");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("spa");
    expect((await invoke(h, "POST", "/")).statusCode).toBe(404);
  });

  it("local mode is unchanged: no JWT needed for reads, boot token gates POST, loopback Host pin", async () => {
    const h = localHandler();
    expect((await invoke(h, "GET", "/api/summary", { host: "127.0.0.1:8899" })).statusCode).toBe(200);
    expect((await invoke(h, "GET", "/api/summary", { host: "console.example.com" })).statusCode).toBe(403);
    expect((await invoke(h, "POST", "/api/automation/arm", { host: "127.0.0.1" })).statusCode).toBe(401);
    // A Supabase JWT is not a credential in local mode.
    expect(
      (await invoke(h, "POST", "/api/automation/arm", { host: "127.0.0.1", bearer: operatorJwt() })).statusCode,
    ).toBe(401);
    expect(jwksFetches).toBe(0);
  });
});
