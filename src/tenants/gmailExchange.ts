import type { AppConfig } from "../config/index.js";
import { exchangeAuthorizationCode, type ExchangedGrant } from "../gmail/oauthExchange.js";
import type { GmailTokenFile } from "../gmail/tokenStore.js";
import { logger } from "../logging/logger.js";
import type { TenantPaths } from "./paths.js";
import { sealSecret } from "./secrets.js";

/**
 * The `gmail_exchange` job (plan v0.5, M19): a hosted user consented in
 * the web app (PKCE, readonly + compose) and submit_gmail_oauth_code put
 * the code + verifier in gmail_oauth_requests. The ENGINE — the only
 * holder of the Web client secret — exchanges it, refuses any grant
 * outside the two scopes, stores the refresh token as cloud ciphertext
 * (engine_store_integration_secret), seals a workspace copy under the
 * tenant key (secrets/gmail.oauth.enc — the shape the Gmail client reads)
 * and deletes the request. A request older than 15 minutes is dead
 * (Google's codes expire) and is deleted unexchanged with the reason on
 * the integration row.
 */

export const GMAIL_TOKEN_SECRET = "gmail.oauth";
export const GMAIL_REQUEST_MAX_AGE_MS = 15 * 60_000;

export type GmailExchangeClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }> };
    };
    delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type GmailExchangeResult = {
  outcome: "connected" | "no_request" | "stale" | "refused" | "exchange_failed";
  reason: string | null;
  accountEmail: string | null;
  scopes: string[];
  sealedPath: string | null;
};

export async function runGmailExchange(input: {
  client: GmailExchangeClient;
  config: AppConfig;
  userId: string;
  paths: TenantPaths;
  tenantKey: Buffer;
  exchange?: typeof exchangeAuthorizationCode;
  now?: () => Date;
}): Promise<GmailExchangeResult> {
  const now = input.now ?? (() => new Date());
  const exchange = input.exchange ?? exchangeAuthorizationCode;
  const clientId = input.config.gmailOauthClientId;
  const clientSecret = input.config.gmailOauthClientSecret;
  if (!clientId || !clientSecret) {
    return { outcome: "refused", reason: "GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET are not set — the engine cannot exchange a user's code", accountEmail: null, scopes: [], sealedPath: null };
  }

  const { data, error } = await input.client.from("gmail_oauth_requests").select("user_id, code, code_verifier, redirect_uri, created_at").eq("user_id", input.userId).maybeSingle();
  if (error) throw new Error(`gmail_oauth_requests read failed: ${error.message}`);
  if (!data) return { outcome: "no_request", reason: "no pending Gmail authorization for this user", accountEmail: null, scopes: [], sealedPath: null };

  const code = String(data["code"] ?? "");
  const verifier = String(data["code_verifier"] ?? "");
  const redirectUri = String(data["redirect_uri"] ?? "");
  const createdAt = typeof data["created_at"] === "string" ? new Date(data["created_at"]).getTime() : 0;

  const drop = async (): Promise<void> => {
    const { error: delError } = await input.client.from("gmail_oauth_requests").delete().eq("user_id", input.userId);
    if (delError) throw new Error(`gmail_oauth_requests delete failed: ${delError.message}`);
  };
  const markFailed = async (reason: string): Promise<void> => {
    const { error: stError } = await input.client.rpc("engine_set_integration_status", {
      p_user: input.userId,
      p_provider: "gmail",
      p_status: "disconnected",
      p_meta: { last_error: reason.slice(0, 300) },
    });
    if (stError) throw new Error(`engine_set_integration_status failed: ${stError.message}`);
  };

  if (!createdAt || now().getTime() - createdAt > GMAIL_REQUEST_MAX_AGE_MS) {
    await drop();
    const reason = "Gmail authorization expired before the engine could exchange it — connect again";
    await markFailed(reason);
    return { outcome: "stale", reason, accountEmail: null, scopes: [], sealedPath: null };
  }

  let grant: ExchangedGrant;
  try {
    grant = await exchange({ code, codeVerifier: verifier, redirectUri, clientId, clientSecret, now });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await drop(); // a code is single-use either way
    await markFailed(reason);
    const refused = /drafts only|lacks gmail\.readonly|no scope/i.test(reason);
    logger.warn("gmail exchange did not connect", { service: "tenants", action: "gmail_exchange", metadata: { user_id: input.userId, refused, reason: reason.slice(0, 200) } });
    return { outcome: refused ? "refused" : "exchange_failed", reason, accountEmail: null, scopes: [], sealedPath: null };
  }

  // Cloud ciphertext first (the record of truth), then the workspace copy.
  const secret: GmailTokenFile = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: grant.refreshToken,
    account_email: grant.accountEmail ?? "unknown@invalid",
    scopes: grant.scopes,
    obtained_at: grant.obtainedAt,
  };
  const { error: storeError } = await input.client.rpc("engine_store_integration_secret", {
    p_user: input.userId,
    p_provider: "gmail",
    // Never the client secret in the cloud: the engine adds it back from its own env when it unseals.
    p_secret: JSON.stringify({ refresh_token: grant.refreshToken, scopes: grant.scopes, account_email: grant.accountEmail, obtained_at: grant.obtainedAt, client: "web" }),
    p_meta: { account_email: grant.accountEmail, scopes: grant.scopes },
  });
  if (storeError) throw new Error(`engine_store_integration_secret failed: ${storeError.message}`);
  const sealedPath = sealSecret(input.paths, GMAIL_TOKEN_SECRET, secret, input.tenantKey);
  await drop();
  logger.info("gmail connected for tenant", {
    service: "tenants",
    action: "gmail_exchange",
    metadata: { user_id: input.userId, scopes: grant.scopes, account_email_present: grant.accountEmail !== null },
  });
  return { outcome: "connected", reason: null, accountEmail: grant.accountEmail, scopes: grant.scopes, sealedPath };
}
