import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { resolveGmailCdpUrl } from "../verification/gmailWebProvider.js";
import { getContact } from "../contacts/repository.js";
import { LINKEDIN_PROFILE_URL } from "../contacts/emailGenerate.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { getRegisteredResume } from "../jobright/materialsRegister.js";

/**
 * Gmail DRAFTS tail (operator directive 2026-08-18): after triage +
 * template generation, each VALIDATED email lands as a draft in the
 * operator's own Gmail — never sent.
 *
 * The invariant mirrors the Outlook tail: the ONLY controls this module
 * clicks are Compose, the To/Subject/Body fields, and "Save & close".
 * Gmail persists the draft on close. The Send control exists in the
 * selector registry solely as a named FORBIDDEN entry so tests can assert
 * it is never a click target — same pattern as insider triage's
 * "Start Email".
 */
export const GMAIL_DRAFT_SELECTOR_REGISTRY_VERSION = "gmail-drafts-v1";

export const gmailDraftSelectorsV1 = {
  validation: "UNVERIFIED" as const,
  url: "https://mail.google.com/",
  /** The Compose button ([gh=cm] is Gmail's stable hook; text fallback). */
  compose: '[gh="cm"], [role="button"][aria-label*="Compose" i]',
  composeText: /^compose$/i,
  /** Compose dialog fields. */
  to: 'input[aria-label*="To recipients" i], textarea[name="to"], input[peoplekit-id], div[aria-label*="Search Field" i] input',
  subject: 'input[name="subjectbox"]',
  body: 'div[aria-label*="Message Body" i][contenteditable="true"], div[role="textbox"][contenteditable="true"]',
  /** Closing the compose window saves the draft. */
  saveAndClose: '[aria-label*="Save & close" i], [alt="Close" i], img.Ha',
  /**
   * Compose's own (CSS-hidden) attachment input — the paperclip feeds it.
   * Setting files on it is the same upload the operator's click would do.
   */
  attachmentInput: 'input[type="file"][name="Filedata"]',
  /**
   * The chip Gmail renders once a file is attached. `name` is always a
   * sanitized [A-Za-z0-9_.-] filename (resumeAttachmentName), so it is
   * safe to interpolate.
   */
  attachmentChip: (name: string): string =>
    `[aria-label*="${name}"], div.vI:has-text("${name}"), [role="link"]:has-text("${name}")`,
  /** An upload still in flight inside the compose window. */
  uploadProgress: '[role="dialog"] [role="progressbar"], #composeWin [role="progressbar"]',
  /**
   * FORBIDDEN control — never a click target. Present so the guard is
   * data, not prose, and so a test can prove no send ever fires.
   */
  sendButton: '[aria-label*="Send" i][role="button"], [data-tooltip*="Send" i]',
  /** Drafts search that verification reads back. */
  draftsSearchUrl: (to: string): string =>
    `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`in:draft to:${to}`)}`,
} as const;

export type GmailDraftFields = {
  to: string;
  subject: string;
  body: string;
  /** Bounded wait for Gmail's Compose control (#210); tests pass a short one. */
  composeWaitMs?: number;
  /** The resume submitted for this application, attached to the draft. */
  attachment?: DraftAttachment;
  /** Bounded wait for the attachment chip / upload; tests pass a short one. */
  attachWaitMs?: number;
};

export type DraftAttachment = {
  /** Sanitized filename the recipient sees. */
  name: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
};

/** attached = chip shown and no upload in flight; not_confirmed = tried, unproven. */
export type AttachmentOutcome = "attached" | "not_confirmed" | "none";

/**
 * The filename a recipient sees: "First_Last_Resume.pdf" from the public
 * profile, never the sha-named artifact path. Sanitized to [A-Za-z0-9_-]
 * so it is also safe inside a selector.
 */
export function resumeAttachmentName(name: { first: string; last: string } | null): string {
  const parts = [name?.first, name?.last]
    .map((p) => (p ?? "").trim().replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter((p) => p.length > 0);
  return parts.length > 0 ? `${parts.join("_")}_Resume.pdf` : "Resume.pdf";
}

function candidateNameFromProfile(): { first: string; last: string } | null {
  try {
    const profile = loadPublicProfile();
    return { first: profile.legal_name.first, last: profile.legal_name.last };
  } catch {
    return null;
  }
}

/**
 * The resume this application actually submitted — its verified `materials`
 * row, byte-checked against the recorded sha256 — as a draft attachment.
 * Every miss is a named note, never a silent draft without the resume.
 */
export function resolveDraftAttachment(
  db: Db,
  applicationId: string,
  deps: { candidateName?: () => { first: string; last: string } | null } = {},
): { attachment: DraftAttachment | null; note: string } {
  const resume = getRegisteredResume(db, applicationId);
  if (!resume) {
    return { attachment: null, note: "no verified resume material on this application — draft has no resume attached" };
  }
  if (!fs.existsSync(resume.path)) {
    return { attachment: null, note: `resume material file missing on disk (${path.basename(resume.path)}) — draft has no resume attached` };
  }
  const buffer = fs.readFileSync(resume.path);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== resume.sha256) {
    return { attachment: null, note: "resume material changed on disk since it was registered (sha256 mismatch) — not attaching" };
  }
  const name = resumeAttachmentName((deps.candidateName ?? candidateNameFromProfile)());
  return {
    attachment: { name, mimeType: "application/pdf", buffer, sha256 },
    note: `attaching the submitted resume as ${name} (sha ${sha256.slice(0, 8)})`,
  };
}

/**
 * Attach one file through compose's hidden input and prove it landed: the
 * chip is visible AND no upload progress remains, both bounded. Closing
 * compose while an upload is in flight can drop the file, so this runs
 * before Save & close.
 */
async function attachFileOnGmailPage(
  page: Page,
  file: DraftAttachment,
  waitMs: number,
  notes: string[],
): Promise<AttachmentOutcome> {
  const s = gmailDraftSelectorsV1;
  const input = page.locator(s.attachmentInput).first();
  const present = await input
    .waitFor({ state: "attached", timeout: Math.min(5_000, waitMs) })
    .then(() => true)
    .catch(() => false);
  if (!present) {
    notes.push("attachment input not found in compose — resume NOT attached");
    return "not_confirmed";
  }
  await input.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  const chipShown = await page
    .locator(s.attachmentChip(file.name))
    .first()
    .waitFor({ state: "visible", timeout: waitMs })
    .then(() => true)
    .catch(() => false);
  if (!chipShown) {
    notes.push(`resume attachment ${file.name} not confirmed within ${Math.round(waitMs / 1000)}s — check the draft`);
    return "not_confirmed";
  }
  const deadline = Date.now() + waitMs;
  while ((await page.locator(s.uploadProgress).count().catch(() => 0)) > 0) {
    if (Date.now() >= deadline) {
      notes.push(`resume ${file.name} still uploading after ${Math.round(waitMs / 1000)}s — check the draft`);
      return "not_confirmed";
    }
    await page.waitForTimeout(500);
  }
  notes.push(`resume attached: ${file.name}`);
  return "attached";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isLinkedInUrlLine(line: string): boolean {
  const trimmed = line.trim().replace(/\/$/, "");
  const canonical = LINKEDIN_PROFILE_URL.replace(/\/$/, "");
  return (
    trimmed === canonical ||
    trimmed === canonical.replace(/^https:\/\//, "")
  );
}

/** Serializable compose tokens — Gmail blocks innerHTML (Trusted Types). */
export type GmailComposePart =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "link"; href: string; text: string };

type ComposeBodyEl = {
  focus: () => void;
  textContent: string;
  appendChild: (node: unknown) => unknown;
  ownerDocument: {
    createElement: (tag: string) => {
      setAttribute: (name: string, value: string) => void;
      textContent: string;
    };
    createTextNode: (text: string) => unknown;
  };
};

/**
 * Gmail compose is contenteditable HTML. body_text stays plain (validator
 * reads the LinkedIn URL as a line under the name); the draft wraps the
 * name as the hyperlink and drops the duplicate URL line.
 */
export function outreachBodyToComposeParts(plain: string): GmailComposePart[] {
  const parts: GmailComposePart[] = [];
  let emitted = false;
  for (const line of plain.split(/\r?\n/)) {
    if (isLinkedInUrlLine(line)) continue;
    if (emitted) parts.push({ kind: "br" });
    emitted = true;
    if (line.trim() === "Shubham Kale") {
      parts.push({
        kind: "link",
        href: LINKEDIN_PROFILE_URL,
        text: "Shubham Kale",
      });
    } else {
      parts.push({ kind: "text", text: line });
    }
  }
  return parts;
}

export function outreachBodyToGmailHtml(plain: string): string {
  return outreachBodyToComposeParts(plain)
    .map((part) => {
      if (part.kind === "br") return "<br>";
      if (part.kind === "link") {
        return `<a href="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`;
      }
      return escapeHtml(part.text);
    })
    .join("");
}

/** Build the body with DOM nodes — never innerHTML. */
function fillComposeBody(el: ComposeBodyEl, parts: GmailComposePart[]): void {
  el.focus();
  el.textContent = "";
  const doc = el.ownerDocument;
  for (const part of parts) {
    if (part.kind === "br") {
      el.appendChild(doc.createElement("br"));
      continue;
    }
    if (part.kind === "link") {
      const a = doc.createElement("a");
      a.setAttribute("href", part.href);
      a.textContent = part.text;
      el.appendChild(a);
      continue;
    }
    el.appendChild(doc.createTextNode(part.text));
  }
}

/**
 * Drive an already-open Gmail(-shaped) page to a saved draft. Pure page
 * choreography — no flags, no DB — so fixtures can prove the click
 * discipline. Returns what it actually did.
 */
export async function draftEmailOnGmailPage(
  page: Page,
  fields: GmailDraftFields,
): Promise<{ composed: boolean; attachment: AttachmentOutcome; notes: string[] }> {
  const notes: string[] = [];
  const s = gmailDraftSelectorsV1;
  // #210 (day28 19:05 UTC, Verkada Frontend: 1 of 4 drafts landed, the
  // other three "compose button not found"): Gmail's shell renders well
  // after domcontentloaded and a fixed 2s pause is a coin flip on a loaded
  // box. Wait for the control itself, bounded, before deciding it is
  // absent; the text fallback gets its own shorter wait.
  const composeWaitMs = fields.composeWaitMs ?? 20_000;
  let compose = page.locator(s.compose).first();
  const primaryVisible = await compose
    .waitFor({ state: "visible", timeout: composeWaitMs })
    .then(() => true)
    .catch(() => false);
  if (!primaryVisible) {
    compose = page
      .locator('button, [role="button"]')
      .filter({ hasText: s.composeText })
      .first();
    const fallbackVisible = await compose
      .waitFor({ state: "visible", timeout: Math.min(5_000, composeWaitMs) })
      .then(() => true)
      .catch(() => false);
    if (!fallbackVisible) {
      notes.push(`compose button not found (waited ${Math.round(composeWaitMs / 1000)}s)`);
      return { composed: false, attachment: "none", notes };
    }
  }
  // #257 (live night30, dedicated Chrome): the click LANDS ("click action
  // done"), then Playwright waits for the hash navigation Compose schedules
  // (#inbox?compose=new) and times out — one such timeout aborted a whole
  // job's six drafts. The compose window appearing is the real proof, and
  // the To-field wait below arbitrates it either way: a click that truly
  // missed still fails there.
  await compose.click({ timeout: 5_000 }).catch((err: unknown) => {
    notes.push(
      `compose click reported ${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 80) : String(err)} — deciding by the compose window`,
    );
  });

  const to = page.locator(s.to).first();
  await to.waitFor({ state: "visible", timeout: 10_000 });
  await to.fill(fields.to);
  // Commit the chip — Gmail turns the address into a token on Enter.
  await to.press("Enter").catch(() => undefined);

  await page.locator(s.subject).first().fill(fields.subject);
  const body = page.locator(s.body).first();
  await body.click({ timeout: 5_000 });
  await body.evaluate(fillComposeBody, outreachBodyToComposeParts(fields.body));

  // Operator directive 2026-09-13: every draft carries the resume that
  // was submitted for the application. Proven before closing.
  const attachment: AttachmentOutcome = fields.attachment
    ? await attachFileOnGmailPage(page, fields.attachment, fields.attachWaitMs ?? 45_000, notes)
    : "none";

  // Save & close persists the draft. NEVER the send button.
  await page.locator(s.saveAndClose).first().click({ timeout: 5_000 });
  notes.push("draft composed and closed (Gmail autosaves on close)");
  return { composed: true, attachment, notes };
}

/** Read-back: the draft exists iff Drafts search shows the subject. */
export async function verifyDraftOnGmailPage(
  page: Page,
  fields: { to: string; subject: string },
): Promise<boolean> {
  await page
    .goto(gmailDraftSelectorsV1.draftsSearchUrl(fields.to), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  const hit = page.getByText(fields.subject, { exact: false }).first();
  return (await hit.count().catch(() => 0)) > 0;
}

export type GmailDraftResult = {
  gmail_draft_id: string;
  recipient_email: string;
  subject: string;
  status: "DRAFTED" | "FAILED";
  verified: boolean;
  /** Whether the submitted resume rode along ("none" = nothing to attach). */
  attachment?: AttachmentOutcome;
  notes: string[];
};

/**
 * Live orchestrator: take the VALIDATED generated email for one contact,
 * open the operator's signed-in session (CDP debug Chrome preferred, the
 * saved jobright storage state otherwise — same preference as the Gmail
 * mailbox scanner), compose the draft, verify by read-back, record the
 * row. Gated by GMAIL_DRAFTS_ENABLED; refuses a contact without a
 * VALIDATED generation or an email address.
 */
export async function createGmailDraft(input: {
  db: Db;
  applicationId: string;
  contactId: string;
  headless?: boolean;
}): Promise<GmailDraftResult> {
  const cfg = getConfig();
  if (!cfg.gmailDraftsEnabled) {
    throw new Error(
      "GMAIL_DRAFTS_ENABLED=false — refusing Gmail draft creation (mailbox mutation).",
    );
  }
  const contact = getContact(input.db, input.contactId);
  if (!contact || contact.application_id !== input.applicationId) {
    throw new Error(`Contact ${input.contactId} not found on this application`);
  }
  if (!contact.email) {
    throw new Error(
      `Contact ${input.contactId} has no email — run contacts:insider first`,
    );
  }
  const generation = input.db
    .prepare(
      `SELECT subject, body_text FROM email_generations
       WHERE application_id = ? AND contact_id = ? AND validation_status = 'VALIDATED'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.applicationId, input.contactId) as
    | { subject: string; body_text: string }
    | undefined;
  if (!generation) {
    throw new Error(
      "no VALIDATED generated email for this contact — run email:generate first",
    );
  }

  const existing = input.db
    .prepare(
      `SELECT id, status, verified FROM gmail_drafts
       WHERE application_id = ? AND recipient_email = ?`,
    )
    .get(input.applicationId, contact.email) as
    | { id: string; status: string; verified: number }
    | undefined;
  if (existing && existing.status === "DRAFTED" && existing.verified === 1) {
    return {
      gmail_draft_id: existing.id,
      recipient_email: contact.email,
      subject: generation.subject,
      status: "DRAFTED",
      verified: true,
      notes: ["draft already exists and verified — not recreating"],
    };
  }

  // #233: prefer the Gmail tail's own debug Chrome when the operator
  // started one (OUTREACH_CDP_URL); falls back to the applier's browser,
  // which is the pre-#233 behaviour.
  const target = await resolveGmailCdpUrl();
  const useCdp = target.reachable;
  const session = new PlaywrightServiceSession({
    service: "jobright",
    ...(useCdp ? { mode: "CDP_ATTACH" as const, cdpUrl: target.url } : {}),
    headless: useCdp ? true : (input.headless ?? true),
  });
  const notes: string[] = [];
  if (target.dedicated) {
    notes.push(`gmail tail on its own debug Chrome (${target.url})`);
  }
  if (target.note) notes.push(target.note);
  const resume = resolveDraftAttachment(input.db, input.applicationId);
  notes.push(resume.note);
  let composed = false;
  let verified = false;
  let attachment: AttachmentOutcome = "none";
  await session.open();
  try {
    const page = await session.newPage({ purpose: "gmail_draft" });
    try {
      await page.goto(gmailDraftSelectorsV1.url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2_000);
      const result = await draftEmailOnGmailPage(page, {
        to: contact.email,
        subject: generation.subject,
        body: generation.body_text,
        ...(resume.attachment ? { attachment: resume.attachment } : {}),
      });
      composed = result.composed;
      attachment = result.attachment;
      notes.push(...result.notes);
      if (composed) {
        verified = await verifyDraftOnGmailPage(page, {
          to: contact.email,
          subject: generation.subject,
        });
        notes.push(
          verified
            ? "draft verified by Drafts read-back"
            : "draft NOT verifiable by read-back — check Gmail Drafts manually",
        );
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }

  const status: "DRAFTED" | "FAILED" = composed ? "DRAFTED" : "FAILED";
  const bodySha = createHash("sha256")
    .update(generation.body_text)
    .digest("hex");
  const id = existing?.id ?? randomUUID();
  const metadata = JSON.stringify({
    body_sha256: bodySha,
    attachment: resume.attachment
      ? { name: resume.attachment.name, sha256: resume.attachment.sha256, outcome: attachment }
      : null,
    notes,
  });
  if (existing) {
    input.db
      .prepare(
        `UPDATE gmail_drafts SET status = ?, verified = ?, subject = ?, metadata_json = ? WHERE id = ?`,
      )
      .run(
        status,
        verified ? 1 : 0,
        generation.subject,
        metadata,
        id,
      );
  } else {
    input.db
      .prepare(
        `INSERT INTO gmail_drafts (
          id, application_id, contact_id, recipient_email, subject, status,
          verified, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.applicationId,
        input.contactId,
        contact.email,
        generation.subject,
        status,
        verified ? 1 : 0,
        new Date().toISOString(),
        metadata,
      );
  }
  logger.info("gmail draft run finished", {
    service: "outreach",
    action: "gmail_draft",
    metadata: {
      application_id: input.applicationId,
      contact_id: input.contactId,
      status,
      verified,
      attachment,
    },
  });
  return {
    gmail_draft_id: id,
    recipient_email: contact.email,
    subject: generation.subject,
    status,
    verified,
    attachment,
    notes,
  };
}
