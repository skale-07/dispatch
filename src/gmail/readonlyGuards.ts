/**
 * Gmail safety boundary. Two scopes exist in this repo and nothing wider:
 *
 *   gmail.readonly — reading verification codes / magic links during
 *                    navigation (the original, operator-only use).
 *   gmail.compose  — creating DRAFTS in a hosted user's own mailbox
 *                    (plan v0.5 M19, operator decision 2026-09-11). Compose
 *                    can also send in Google's model, so the API transport
 *                    is structurally drafts-only (src/gmail/draftsApi.ts:
 *                    exactly POST users/me/drafts + GET users/me/drafts/{id},
 *                    asserted per request) and every send endpoint —
 *                    messages and drafts, dotted and slashed — is a banned
 *                    identifier below, enforced by scripts/check-forbidden.ts
 *                    (same discipline as the Outlook send guards).
 *
 * Mail is never sent by this system. Error text says "drafts only".
 */

export class GmailWriteForbiddenError extends Error {
  constructor(message = "Gmail access is drafts only (readonly + compose). Sending is forbidden.") {
    super(message);
    this.name = "GmailWriteForbiddenError";
  }
}

/** The readonly scope — required on every grant (verification codes are why Gmail exists here). */
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";

/**
 * The compose scope — the ONLY additional scope a HOSTED user's grant may
 * carry, and this file is the ONLY place its literal may appear (the
 * literal is assembled so a stray copy elsewhere still trips the scan).
 */
export const GMAIL_COMPOSE_SCOPE = ["https://www.googleapis.com/auth/gmail", "compose"].join(".");

/** Every scope this repo may request, accept or store. Nothing else parses. */
export const GMAIL_ALLOWED_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE] as const;

/** Patterns that must not appear in production source (see check-forbidden). */
export const FORBIDDEN_GMAIL_IDENTIFIERS = [
  // message send — dotted (client libraries) and slashed (REST paths)
  ["users", "messages", "send"].join("."),
  ["gmail", "users", "messages", "send"].join("."),
  ["users", "me", "messages", "send"].join("/"),
  ["messages", "send"].join("/"),
  // draft send — the compose scope's one dangerous verb
  ["users", "drafts", "send"].join("."),
  ["gmail", "users", "drafts", "send"].join("."),
  ["users", "me", "drafts", "send"].join("/"),
  ["drafts", "send"].join("/"),
  // scopes wider than readonly + compose
  ["auth/gmail", "send"].join("."),
  ["auth/gmail", "modify"].join("."),
  ["auth/gmail", "insert"].join("."),
  ["GMAIL", "SEND", "ENABLED"].join("_"),
  // Tool-slug shapes. An integration layer (Composio and friends) reaches
  // mail by NAME, so `execute("GMAIL_SEND_EMAIL")` is a send call that
  // contains none of the API-shaped strings above — it passed this check
  // clean until 2026-08-12. The slugs ship in the same toolkit as the
  // draft ones, one identifier apart.
  ["GMAIL", "SEND", "EMAIL"].join("_"),
  ["GMAIL", "SEND", "DRAFT"].join("_"),
  ["GMAIL", "REPLY", "TO", "THREAD"].join("_"),
] as const;
