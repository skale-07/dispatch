import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { identityFromProfile } from "../../src/candidate/identity.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { readEncryptedFile } from "../../src/candidate/sensitiveCrypto.js";
import { loadConfig } from "../../src/config/env.js";
import { assertScopesAllowed, refreshAccessToken } from "../../src/gmail/accessToken.js";
import { assertDraftsOnlyEndpoint, buildRfc822, createDraftViaApi, toBase64Url } from "../../src/gmail/draftsApi.js";
import { exchangeAuthorizationCode } from "../../src/gmail/oauthExchange.js";
import {
  FORBIDDEN_GMAIL_IDENTIFIERS,
  GMAIL_ALLOWED_SCOPES,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  GmailWriteForbiddenError,
} from "../../src/gmail/readonlyGuards.js";
import { resetConfigCache } from "../../src/config/index.js";
import { gmailTokenPath, normalizeGmailToken, readGmailToken, tokenScopes } from "../../src/gmail/tokenStore.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { GMAIL_TOKEN_SECRET, runGmailExchange } from "../../src/tenants/gmailExchange.js";
import { deriveTenantKey } from "../../src/tenants/keys.js";
import { selectOutreachDraftRows } from "../../src/tenants/outreachMirror.js";
import { tenantPaths } from "../../src/tenants/paths.js";

/**
 * Plan M19 — per-user Gmail, drafts only. The compose scope is admitted
 * deliberately (operator decision 2026-09-11) and everything that could
 * send is banned or structurally absent: the identifier list, the token
 * file's scope set, the two-endpoint API transport with a per-request
 * assertion, the exchange's refusals, and the tenant job that stores the
 * grant as ciphertext. UNIT_CONFIRMED; nothing here touches Google.
 */

const UID = "11111111-2222-4333-8444-555555555555";
const KEY = deriveTenantKey(Buffer.alloc(32, 5), UID);
const MODIFY = "https://www.googleapis.com/auth/gmail.mod" + "ify"; // split so the literal scan stays meaningful

type Req = { url: string; method: string; body: string | null; auth: string | null };
function fakeFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const reqs: Req[] = [];
  const fetchImpl = async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    reqs.push({ url: u, method, body: init?.body ?? null, auth: init?.headers?.["Authorization"] ?? null });
    const key = Object.keys(routes).find((k) => k === `${method} ${new URL(u).pathname}`);
    const r = key ? routes[key]! : { status: 404, json: { error: `no route ${method} ${u}` } };
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json };
  };
  return { fetchImpl, reqs };
}

describe("gmail guards after the compose decision (UNIT_CONFIRMED)", () => {
  it("compose is an allowed scope; every send endpoint — messages and drafts, dotted and slashed — is banned", () => {
    expect(GMAIL_ALLOWED_SCOPES).toEqual([GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE]);
    expect(FORBIDDEN_GMAIL_IDENTIFIERS).not.toContain(GMAIL_COMPOSE_SCOPE);
    for (const banned of [
      ["users", "messages", "send"].join("."),
      ["users", "drafts", "send"].join("."),
      ["users", "me", "drafts", "send"].join("/"),
      ["drafts", "send"].join("/"),
      ["users", "me", "messages", "send"].join("/"),
      ["auth/gmail", "send"].join("."),
      ["auth/gmail", "modify"].join("."),
    ]) {
      expect(FORBIDDEN_GMAIL_IDENTIFIERS, banned).toContain(banned);
    }
    expect(() => assertScopesAllowed([GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE], "x")).not.toThrow();
    expect(() => assertScopesAllowed([GMAIL_READONLY_SCOPE, MODIFY], "x")).toThrow(GmailWriteForbiddenError);
  });

  it("token files: v1 readonly parses; v2 with compose parses; readonly is required; nothing wider parses", () => {
    const base = { client_id: "c", client_secret: "s", refresh_token: "r", account_email: "a@b.io", obtained_at: "2026-09-14T00:00:00Z" };
    expect(tokenScopes({ scope: GMAIL_READONLY_SCOPE })).toEqual([GMAIL_READONLY_SCOPE]);
    const v2 = normalizeGmailToken({ ...base, scopes: [GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE] });
    expect(v2.scopes).toEqual([GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE].sort());
    expect(v2.scope).toBe(GMAIL_READONLY_SCOPE);
    // Reading from disk goes through the schema: readonly required, allowed set only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gmail-token-"));
    const saved = process.env.PRIVATE_DIR;
    try {
      process.env.PRIVATE_DIR = dir;
      resetConfigCache();
      fs.mkdirSync(path.dirname(gmailTokenPath()), { recursive: true });
      fs.writeFileSync(gmailTokenPath(), JSON.stringify({ ...base, scope: GMAIL_READONLY_SCOPE }));
      expect(readGmailToken()?.scopes).toEqual([GMAIL_READONLY_SCOPE]);
      fs.writeFileSync(gmailTokenPath(), JSON.stringify({ ...base, scopes: [GMAIL_COMPOSE_SCOPE] }));
      expect(() => readGmailToken()).toThrow(/readonly/);
      fs.writeFileSync(gmailTokenPath(), JSON.stringify({ ...base, scopes: [GMAIL_READONLY_SCOPE, MODIFY] }));
      expect(() => readGmailToken()).toThrow();
    } finally {
      if (saved === undefined) delete process.env.PRIVATE_DIR;
      else process.env.PRIVATE_DIR = saved;
      resetConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drafts-only API transport (UNIT_CONFIRMED)", () => {
  it("admits exactly POST users/me/drafts and GET users/me/drafts/{id}; refuses everything else by name", () => {
    expect(() => assertDraftsOnlyEndpoint("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts")).not.toThrow();
    expect(() => assertDraftsOnlyEndpoint("GET", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-123_ab")).not.toThrow();
    const sendPath = ["https://gmail.googleapis.com/gmail/v1/users/me", "drafts", "send"].join("/");
    expect(() => assertDraftsOnlyEndpoint("POST", sendPath)).toThrow(/drafts only/);
    expect(() => assertDraftsOnlyEndpoint("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-1")).toThrow(/drafts only/);
    expect(() => assertDraftsOnlyEndpoint("DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-1")).toThrow(/drafts only/);
    expect(() => assertDraftsOnlyEndpoint("POST", "https://evil.example/gmail/v1/users/me/drafts")).toThrow(/not the Gmail API/);
    expect(() => assertDraftsOnlyEndpoint("POST", "nope")).toThrow(GmailWriteForbiddenError);
  });

  it("builds RFC 822 text (plain and with an attachment) and base64url", () => {
    const plain = buildRfc822({ to: "maya@pitt.edu", subject: "Quick question — Acme", bodyText: "Hi Maya,\n\nthanks.\n" });
    expect(plain).toMatch(/^To: maya@pitt\.edu\r\nSubject: =\?UTF-8\?B\?/);
    expect(plain).toContain('Content-Type: text/plain; charset="UTF-8"');
    const withPdf = buildRfc822({ to: "maya@pitt.edu", subject: "Resume", bodyText: "see attached", attachments: [{ filename: 'Maya "Resume".pdf', contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4") }] });
    expect(withPdf).toContain("multipart/mixed; boundary=");
    expect(withPdf).toContain('filename="Maya Resume.pdf"');
    expect(withPdf).toContain(Buffer.from("%PDF-1.4").toString("base64"));
    expect(() => buildRfc822({ to: "nobody", subject: "x", bodyText: "y" })).toThrow(/recipient/);
    expect(toBase64Url("a+b/c==")).toBe(Buffer.from("a+b/c==").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  });

  it("creates a draft and proves it by read-back; a read-back without DRAFT is reported unverified; SENT is refused", async () => {
    const { fetchImpl, reqs } = fakeFetch({
      "POST /gmail/v1/users/me/drafts": { json: { id: "d1", message: { id: "m1" } } },
      "GET /gmail/v1/users/me/drafts/d1": { json: { id: "d1", message: { id: "m1", labelIds: ["DRAFT"] } } },
    });
    const r = await createDraftViaApi({ accessToken: "at", message: { to: "maya@pitt.edu", subject: "s", bodyText: "b" }, fetchImpl });
    expect(r).toEqual({ draftId: "d1", messageId: "m1", labelIds: ["DRAFT"], verified: true });
    expect(reqs.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual(["POST /gmail/v1/users/me/drafts", "GET /gmail/v1/users/me/drafts/d1"]);
    expect(reqs[0]!.auth).toBe("Bearer at");
    expect(JSON.parse(reqs[0]!.body!)).toEqual({ message: { raw: expect.any(String) } });

    const { fetchImpl: noLabel } = fakeFetch({
      "POST /gmail/v1/users/me/drafts": { json: { id: "d2" } },
      "GET /gmail/v1/users/me/drafts/d2": { json: { id: "d2", message: { id: "m2", labelIds: [] } } },
    });
    expect((await createDraftViaApi({ accessToken: "at", message: { to: "a@b.io", subject: "s", bodyText: "b" }, fetchImpl: noLabel })).verified).toBe(false);

    const { fetchImpl: sent } = fakeFetch({
      "POST /gmail/v1/users/me/drafts": { json: { id: "d3" } },
      "GET /gmail/v1/users/me/drafts/d3": { json: { id: "d3", message: { id: "m3", labelIds: ["SENT"] } } },
    });
    await expect(createDraftViaApi({ accessToken: "at", message: { to: "a@b.io", subject: "s", bodyText: "b" }, fetchImpl: sent })).rejects.toThrow(GmailWriteForbiddenError);
  });
});

describe("authorization-code exchange (UNIT_CONFIRMED)", () => {
  const args = { code: "4/abc", codeVerifier: "ver", redirectUri: "https://app/gmail/callback", clientId: "web-id", clientSecret: "web-secret" };

  it("stores readonly+compose grants with the account email; refuses wider, compose-only, and offline-less grants", async () => {
    const { fetchImpl, reqs } = fakeFetch({
      "POST /token": { json: { access_token: "at", refresh_token: "rt", scope: `${GMAIL_COMPOSE_SCOPE} ${GMAIL_READONLY_SCOPE}` } },
      "GET /gmail/v1/users/me/profile": { json: { emailAddress: "maya@gmail.com" } },
    });
    const g = await exchangeAuthorizationCode({ ...args, fetchImpl, now: () => new Date("2026-09-14T07:00:00Z") });
    expect(g).toEqual({ refreshToken: "rt", scopes: [GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE].sort(), accountEmail: "maya@gmail.com", obtainedAt: "2026-09-14T07:00:00.000Z" });
    expect(reqs[0]!.body).toContain("code_verifier=ver");
    expect(reqs[0]!.body).toContain("grant_type=authorization_code");

    const wider = fakeFetch({ "POST /token": { json: { access_token: "at", refresh_token: "rt", scope: `${GMAIL_READONLY_SCOPE} ${MODIFY}` } } });
    await expect(exchangeAuthorizationCode({ ...args, fetchImpl: wider.fetchImpl })).rejects.toThrow(GmailWriteForbiddenError);
    const composeOnly = fakeFetch({ "POST /token": { json: { access_token: "at", refresh_token: "rt", scope: GMAIL_COMPOSE_SCOPE } } });
    await expect(exchangeAuthorizationCode({ ...args, fetchImpl: composeOnly.fetchImpl })).rejects.toThrow(/lacks gmail\.readonly/);
    const noRefresh = fakeFetch({ "POST /token": { json: { access_token: "at", scope: GMAIL_READONLY_SCOPE } } });
    await expect(exchangeAuthorizationCode({ ...args, fetchImpl: noRefresh.fetchImpl })).rejects.toThrow(/no refresh_token/);
    const denied = fakeFetch({ "POST /token": { status: 400, json: { error: "invalid_grant" } } });
    await expect(exchangeAuthorizationCode({ ...args, fetchImpl: denied.fetchImpl })).rejects.toThrow(/HTTP 400 invalid_grant/);
  });

  it("refresh: a response outside the allowed set is refused; invalid_grant names itself", async () => {
    const ok = fakeFetch({ "POST /token": { json: { access_token: "at", scope: GMAIL_READONLY_SCOPE } } });
    expect((await refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl: ok.fetchImpl })).accessToken).toBe("at");
    const bad = fakeFetch({ "POST /token": { json: { access_token: "at", scope: MODIFY } } });
    await expect(refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl: bad.fetchImpl })).rejects.toThrow(GmailWriteForbiddenError);
    const dead = fakeFetch({ "POST /token": { status: 400, json: { error: "invalid_grant" } } });
    await expect(refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl: dead.fetchImpl })).rejects.toThrow(/invalid_grant/);
  });
});

describe("gmail_exchange tenant job (UNIT_CONFIRMED)", () => {
  type Call = { rpc?: string; args?: Record<string, unknown>; deleted?: string };
  function fakeClient(row: Record<string, unknown> | null) {
    const calls: Call[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        delete: () => ({ eq: async (_c: string, v: string) => { calls.push({ deleted: v }); return { error: null }; } }),
      }),
      rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ rpc: fn, args }); return { data: null, error: null }; },
    };
    return { client, calls };
  }
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", GMAIL_OAUTH_CLIENT_ID: "web-id", GMAIL_OAUTH_CLIENT_SECRET: "web-secret" });
  const NOW = new Date("2026-09-14T07:00:00Z");
  const fresh = { user_id: UID, code: "4/abc", code_verifier: "ver", redirect_uri: "https://app/gmail/callback", created_at: "2026-09-14T06:55:00Z" };

  it("connected: ciphertext stored without the client secret, workspace copy sealed under the tenant key, request deleted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gx-"));
    try {
      const paths = tenantPaths(UID, root);
      const { client, calls } = fakeClient(fresh);
      const seen: Record<string, unknown>[] = [];
      const r = await runGmailExchange({
        client, config, userId: UID, paths, tenantKey: KEY, now: () => NOW,
        exchange: async (input) => { seen.push(input); return { refreshToken: "rt", scopes: [GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE], accountEmail: "maya@gmail.com", obtainedAt: NOW.toISOString() }; },
      });
      expect(r.outcome).toBe("connected");
      expect(seen[0]).toMatchObject({ code: "4/abc", codeVerifier: "ver", redirectUri: "https://app/gmail/callback", clientId: "web-id", clientSecret: "web-secret" });
      const store = calls.find((c) => c.rpc === "engine_store_integration_secret")!;
      expect(store.args).toMatchObject({ p_user: UID, p_provider: "gmail", p_meta: { account_email: "maya@gmail.com" } });
      expect(String(store.args!["p_secret"])).not.toContain("web-secret");
      expect(JSON.parse(String(store.args!["p_secret"]))).toMatchObject({ refresh_token: "rt", scopes: [GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE] });
      expect(calls.some((c) => c.deleted === UID)).toBe(true);
      const sealed = readEncryptedFile<{ refresh_token: string; client_secret: string; scopes: string[] }>(path.join(paths.secretsDir, `${GMAIL_TOKEN_SECRET}.enc`), KEY);
      expect(sealed.refresh_token).toBe("rt");
      expect(sealed.client_secret).toBe("web-secret");
      expect(fs.readFileSync(r.sealedPath!, "utf8")).not.toContain("rt\"");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no request ⇒ no_request; stale ⇒ deleted + disconnected with the reason; refused grant ⇒ refused; missing client settings ⇒ refused before any read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gx2-"));
    try {
      const paths = tenantPaths(UID, root);
      expect((await runGmailExchange({ client: fakeClient(null).client, config, userId: UID, paths, tenantKey: KEY })).outcome).toBe("no_request");
      const stale = fakeClient({ ...fresh, created_at: "2026-09-14T06:00:00Z" });
      const s = await runGmailExchange({ client: stale.client, config, userId: UID, paths, tenantKey: KEY, now: () => NOW });
      expect(s.outcome).toBe("stale");
      expect(stale.calls.some((c) => c.deleted === UID)).toBe(true);
      expect(stale.calls.find((c) => c.rpc === "engine_set_integration_status")!.args).toMatchObject({ p_provider: "gmail", p_status: "disconnected" });
      const refused = fakeClient(fresh);
      const rr = await runGmailExchange({ client: refused.client, config, userId: UID, paths, tenantKey: KEY, now: () => NOW, exchange: async () => { throw new GmailWriteForbiddenError("Gmail grant carries scopes outside readonly+compose (x) — drafts only; refusing."); } });
      expect(rr.outcome).toBe("refused");
      expect(fs.existsSync(path.join(paths.secretsDir, `${GMAIL_TOKEN_SECRET}.enc`))).toBe(false);
      const noCreds = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite" });
      const nc = await runGmailExchange({ client: fakeClient(fresh).client, config: noCreds, userId: UID, paths, tenantKey: KEY });
      expect(nc.outcome).toBe("refused");
      expect(nc.reason).toMatch(/GMAIL_OAUTH_CLIENT_ID/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("outreach_drafts mirror + candidate identity (UNIT_CONFIRMED)", () => {
  it("mirrors DRAFTED rows as company/contact/subject/draft id — never a body", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-od-"));
    const db = openDatabase(path.join(dir, "app.sqlite"));
    try {
      migrate(db);
      const job = upsertJobByFingerprint(db, { company: "Acme", role: "SWE Intern", applicationUrl: "https://jobs.lever.co/acme/1" });
      const app = createApplication(db, { jobId: job.id, state: "COMPLETED" });
      db.prepare(`INSERT INTO contacts (id, application_id, name, email, created_at) VALUES ('c1', ?, 'Paola M', 'p@acme.com', '2026-09-14T00:00:00Z')`).run(app.id);
      db.prepare(`INSERT INTO gmail_drafts (id, application_id, contact_id, recipient_email, subject, status, verified, created_at, metadata_json) VALUES ('g1', ?, 'c1', 'p@acme.com', 'Quick question', 'DRAFTED', 1, '2026-09-14T00:01:00Z', '{"gmail_draft_id":"r-77","body":"never mirrored"}')`).run(app.id);
      db.prepare(`INSERT INTO gmail_drafts (id, application_id, contact_id, recipient_email, subject, status, verified, created_at, metadata_json) VALUES ('g2', ?, 'c1', 'x@acme.com', 'Failed one', 'FAILED', 0, '2026-09-14T00:02:00Z', '{}')`).run(app.id);
      const rows = selectOutreachDraftRows(db, UID);
      expect(rows).toEqual([{ user_id: UID, engine_application_id: app.id, company: "Acme", contact_name: "Paola M", subject: "Quick question", gmail_draft_id: "r-77" }]);
      expect(JSON.stringify(rows)).not.toContain("never mirrored");
    } finally {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("identity comes from the loaded profile; blanks stay blank", () => {
    const p = parsePublicProfile({ legal_name: { first: "Maya", middle: "", last: "Okafor" }, preferred_name: "", email: "maya@pitt.edu", linkedin_url: "https://www.linkedin.com/in/maya/" });
    expect(identityFromProfile(p)).toEqual({ fullName: "Maya Okafor", firstName: "Maya", linkedinUrl: "https://www.linkedin.com/in/maya", email: "maya@pitt.edu" });
    const blank = parsePublicProfile({ legal_name: { first: "", middle: "", last: "" }, email: "" });
    expect(identityFromProfile(blank)).toEqual({ fullName: "", firstName: "", linkedinUrl: null, email: null });
  });
});
