import { randomUUID } from "node:crypto";
import type { TokenFetch } from "./accessToken.js";
import { GmailWriteForbiddenError } from "./readonlyGuards.js";

/**
 * Drafts-only Gmail API transport (plan v0.5, M19).
 *
 * Exactly two endpoints exist in this module, and every request passes
 * through assertDraftsOnlyEndpoint first:
 *
 *   POST users/me/drafts          create a draft
 *   GET  users/me/drafts/{id}     read it back (labelIds must contain DRAFT)
 *
 * There is no send here — not as a method, not as a URL, not as a
 * parameter. The banned identifiers in readonlyGuards.ts + check-forbidden
 * keep it that way at the source level; this assertion keeps it that way
 * at runtime even if a caller hands in a URL.
 */

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const DRAFTS_PATH = "/users/me/drafts";

export function assertDraftsOnlyEndpoint(method: string, url: string): void {
  const m = method.toUpperCase();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GmailWriteForbiddenError(`Gmail API: unparsable URL — drafts only; refusing.`);
  }
  if (u.origin !== "https://gmail.googleapis.com") {
    throw new GmailWriteForbiddenError(`Gmail API: host ${u.host} is not the Gmail API — drafts only; refusing.`);
  }
  const p = u.pathname.replace(/\/+$/, "");
  const createOk = m === "POST" && p === `/gmail/v1${DRAFTS_PATH}`;
  const readOk = m === "GET" && new RegExp(`^/gmail/v1${DRAFTS_PATH}/[A-Za-z0-9_-]+$`).test(p);
  if (!createOk && !readOk) {
    throw new GmailWriteForbiddenError(`Gmail API: ${m} ${p} is not a drafts endpoint — drafts only; refusing.`);
  }
}

export type DraftAttachment = { filename: string; contentType: string; bytes: Buffer };

export type DraftMessage = {
  to: string;
  subject: string;
  bodyText: string;
  from?: string;
  attachments?: DraftAttachment[];
};

function encodeHeader(value: string): string {
  // RFC 2047 for anything outside printable ASCII (names with accents, em dashes).
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(bytes: Buffer): string {
  return bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/** RFC 822 message text; multipart/mixed when attachments are present. */
export function buildRfc822(msg: DraftMessage): string {
  if (!msg.to.trim() || !msg.to.includes("@")) throw new Error("draft needs a recipient address");
  const headers: string[] = [];
  if (msg.from) headers.push(`From: ${encodeHeader(msg.from)}`);
  headers.push(`To: ${msg.to.trim()}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  headers.push("MIME-Version: 1.0");
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    return `${headers.join("\r\n")}\r\n\r\n${base64Lines(Buffer.from(msg.bodyText, "utf8"))}\r\n`;
  }
  const boundary = `dispatch_${randomUUID().replace(/-/g, "")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(Buffer.from(msg.bodyText, "utf8"))}\r\n`,
  ];
  for (const a of attachments) {
    const name = a.filename.replace(/["\r\n]/g, "");
    parts.push(
      `--${boundary}\r\nContent-Type: ${a.contentType}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.bytes)}\r\n`,
    );
  }
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("")}--${boundary}--\r\n`;
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type CreatedDraft = {
  draftId: string;
  messageId: string | null;
  labelIds: string[];
  /** The read-back proved the draft exists in Drafts (labelIds ∋ DRAFT). */
  verified: boolean;
};

/**
 * Create a draft and read it back. The read-back is the evidence: a
 * draft whose labelIds lack DRAFT is reported unverified, never assumed.
 */
export async function createDraftViaApi(input: {
  accessToken: string;
  message: DraftMessage;
  fetchImpl?: TokenFetch;
}): Promise<CreatedDraft> {
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as TokenFetch);
  const createUrl = `${GMAIL_API_BASE}${DRAFTS_PATH}`;
  assertDraftsOnlyEndpoint("POST", createUrl);
  const res = await fetchImpl(createUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: toBase64Url(buildRfc822(input.message)) } }),
  });
  if (!res.ok) throw new Error(`Gmail draft create failed (HTTP ${res.status})`);
  const created = (await res.json()) as { id?: string; message?: { id?: string; labelIds?: string[] } };
  if (!created.id) throw new Error("Gmail draft create returned no draft id");

  const readUrl = `${GMAIL_API_BASE}${DRAFTS_PATH}/${encodeURIComponent(created.id)}`;
  assertDraftsOnlyEndpoint("GET", readUrl);
  const back = await fetchImpl(readUrl, { headers: { Authorization: `Bearer ${input.accessToken}` } });
  if (!back.ok) {
    return { draftId: created.id, messageId: created.message?.id ?? null, labelIds: [], verified: false };
  }
  const draft = (await back.json()) as { id?: string; message?: { id?: string; labelIds?: string[] } };
  const labelIds = draft.message?.labelIds ?? [];
  if (labelIds.includes("SENT")) {
    // Cannot happen with these scopes; if it ever did, say so loudly rather than report a draft.
    throw new GmailWriteForbiddenError("Gmail draft read-back shows SENT — refusing to report this as a draft.");
  }
  return {
    draftId: draft.id ?? created.id,
    messageId: draft.message?.id ?? created.message?.id ?? null,
    labelIds,
    verified: labelIds.includes("DRAFT"),
  };
}
