import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "../config/index.js";
import { GMAIL_ALLOWED_SCOPES, GMAIL_READONLY_SCOPE } from "./readonlyGuards.js";

/**
 * Refresh-token storage for the Gmail client. Lives under private/
 * (gitignored + pre-commit-enforced), written 0600. Gmail is API-only —
 * deliberately NOT a ServiceName / browser session.
 *
 * v2 (plan M19): the grant records its `scopes` (⊆ readonly + compose,
 * readonly required). A v1 file carries the single readonly `scope` and
 * still parses; a file claiming anything wider than the allowed set fails
 * to parse at all. `scope` is kept on disk as the readonly literal so the
 * operator's tooling reads it unchanged.
 */
const allowedScope = z.enum([GMAIL_ALLOWED_SCOPES[0], GMAIL_ALLOWED_SCOPES[1]]);

const tokenFileSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    account_email: z.string().email(),
    scope: z.literal(GMAIL_READONLY_SCOPE).optional(),
    scopes: z.array(allowedScope).optional(),
    obtained_at: z.string(),
  })
  .refine((t) => t.scope !== undefined || (t.scopes?.length ?? 0) > 0, {
    message: "token file must record its scope(s)",
  })
  .refine((t) => tokenScopes(t).includes(GMAIL_READONLY_SCOPE), {
    message: "token file must include the readonly scope",
  });

export type GmailTokenFile = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  account_email: string;
  /** v1 field: the readonly literal (present whenever readonly is granted). */
  scope?: typeof GMAIL_READONLY_SCOPE;
  /** v2 field: every granted scope, ⊆ GMAIL_ALLOWED_SCOPES. */
  scopes?: string[];
  obtained_at: string;
};

/** The granted scopes of a token file, v1 or v2. */
export function tokenScopes(token: { scope?: string | undefined; scopes?: string[] | undefined }): string[] {
  const set = new Set<string>(token.scopes ?? []);
  if (token.scope) set.add(token.scope);
  return [...set].sort();
}

/** Normalize: `scopes` always present; `scope` = readonly literal when granted. */
export function normalizeGmailToken(token: GmailTokenFile): GmailTokenFile & { scopes: string[] } {
  const scopes = tokenScopes(token);
  return {
    ...token,
    scopes,
    ...(scopes.includes(GMAIL_READONLY_SCOPE) ? { scope: GMAIL_READONLY_SCOPE } : {}),
  };
}

export function gmailTokenPath(): string {
  return path.join(getConfig().privateDir, "auth", "gmail.oauth.json");
}

export function readGmailToken(): (GmailTokenFile & { scopes: string[] }) | null {
  const p = gmailTokenPath();
  if (!fs.existsSync(p)) return null;
  return normalizeGmailToken(tokenFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8"))) as GmailTokenFile);
}

export function writeGmailToken(token: GmailTokenFile): string {
  const p = gmailTokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const normalized = normalizeGmailToken(tokenFileSchema.parse(token) as GmailTokenFile);
  fs.writeFileSync(p, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return p;
}
