import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  createGmailDraft,
  draftEmailOnGmailPage,
  outreachBodyToGmailHtml,
  resolveDraftAttachment,
  resumeAttachmentName,
} from "../../src/outreach/gmailDrafts.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createHash } from "node:crypto";
import { LINKEDIN_PROFILE_URL } from "../../src/contacts/emailGenerate.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Gmail drafts tail (operator directive 2026-08-18). The mock compose page
 * records every draft save AND whether Send was ever clicked, so the two
 * invariants — drafts persist, nothing sends — are both assertions.
 */
const MOCK = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "gmail", "compose-mock.html"),
  "utf8",
);

describe("gmail draft composition (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("wraps the signature name as a LinkedIn hyperlink and drops the duplicate URL line", () => {
    const html = outreachBodyToGmailHtml(
      [
        "Hi there,",
        "",
        "Best,",
        "Shubham Kale",
        LINKEDIN_PROFILE_URL,
        "Johns Hopkins University",
      ].join("\n"),
    );
    expect(html).toContain(
      `<a href="${LINKEDIN_PROFILE_URL}">Shubham Kale</a>`,
    );
    expect(html).not.toMatch(/<br>https:\/\/www\.linkedin\.com/);
    expect(html).toContain("Hi there,");
    expect(html).toContain("Johns Hopkins University");
  });

  it("composes, saves via Save & close, and NEVER clicks Send", async () => {
    await withFixtureHtmlPage(MOCK, async (page) => {
      const result = await draftEmailOnGmailPage(page, {
        to: "ayang@jumptrading.com",
        subject: "Hopkins sophomore interested in Jump Trading Campus UI SWE",
        body: [
          "Hi there,",
          "",
          "Hope you're doing well...",
          "",
          "Best,",
          "Shubham Kale",
          LINKEDIN_PROFILE_URL,
          "Hodson Trust Scholar",
        ].join("\n"),
      });
      expect(result.composed).toBe(true);
      expect(result.attachment).toBe("none");

      const state = await page.evaluate<{
        sendClicked: boolean;
        drafts: Array<{
          to: string;
          subject: string;
          body: string;
          bodyHtml: string;
        }>;
      }>(`({ sendClicked: window.__sendClicked, drafts: window.__drafts })`);
      expect(state.sendClicked).toBe(false);
      expect(state.drafts).toHaveLength(1);
      expect(state.drafts[0]).toMatchObject({
        to: "ayang@jumptrading.com",
        subject: "Hopkins sophomore interested in Jump Trading Campus UI SWE",
      });
      expect(state.drafts[0]!.body).toContain("Shubham Kale");
      expect(state.drafts[0]!.bodyHtml).toContain(
        `href="${LINKEDIN_PROFILE_URL}"`,
      );
    });
  }, 60_000);

  // Operator directive 2026-09-13: the submitted resume rides on every draft.
  const RESUME = Buffer.from("%PDF-1.4\n% gmail attachment fixture\n%%EOF\n");
  const attachment = {
    name: "Shubham_Kale_Resume.pdf",
    mimeType: "application/pdf",
    buffer: RESUME,
    sha256: createHash("sha256").update(RESUME).digest("hex"),
  };
  type AttachState = {
    sendClicked: boolean;
    drafts: Array<{ to: string; attachments: Array<{ name: string; size: number }> }>;
  };

  it("attaches the resume, proves the chip before Save & close, and still NEVER clicks Send", async () => {
    await withFixtureHtmlPage(MOCK, async (page) => {
      const result = await draftEmailOnGmailPage(page, {
        to: "pat@bsci.test",
        subject: "Hopkins student interested in Boston Scientific SWE",
        body: "Hi Pat,\n\nbody",
        attachment,
        attachWaitMs: 5_000,
      });
      expect(result.composed).toBe(true);
      expect(result.attachment).toBe("attached");
      expect(result.notes).toContain("resume attached: Shubham_Kale_Resume.pdf");
      const state = await page.evaluate<AttachState>(
        `({ sendClicked: window.__sendClicked, drafts: window.__drafts })`,
      );
      expect(state.sendClicked).toBe(false);
      expect(state.drafts).toHaveLength(1);
      expect(state.drafts[0]!.attachments).toEqual([
        { name: "Shubham_Kale_Resume.pdf", size: RESUME.length },
      ]);
    });
  }, 60_000);

  it("an upload Gmail never confirms is reported not_confirmed, never as attached", async () => {
    await withFixtureHtmlPage(MOCK, async (page) => {
      await page.evaluate("window.__suppressChip = true");
      const result = await draftEmailOnGmailPage(page, {
        to: "pat@bsci.test",
        subject: "s",
        body: "b",
        attachment,
        attachWaitMs: 1_000,
      });
      expect(result.composed).toBe(true);
      expect(result.attachment).toBe("not_confirmed");
      expect(result.notes.join(" ")).toMatch(/Shubham_Kale_Resume\.pdf not confirmed within 1s/);
      const state = await page.evaluate<AttachState>(
        `({ sendClicked: window.__sendClicked, drafts: window.__drafts })`,
      );
      expect(state.sendClicked).toBe(false);
      expect(state.drafts[0]!.attachments).toEqual([]);
    });
  }, 60_000);

  it("reports honestly when no compose control exists", async () => {
    await withFixtureHtmlPage(
      "<html><body><p>not gmail</p></body></html>",
      async (page) => {
        const result = await draftEmailOnGmailPage(page, {
          to: "x@example.com",
          subject: "s",
          body: "b",
          // #210: production waits up to 20s for Gmail's shell; a fixture
          // that will never render Compose should fail fast.
          composeWaitMs: 1_000,
        });
        expect(result.composed).toBe(false);
        expect(result.notes.join(" ")).toMatch(/compose button not found \(waited 1s\)/);
      },
    );
  }, 45_000);
});

describe("createGmailDraft gating (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-gmaildraft-${randomUUID()}.sqlite`);
    db = openDatabase(dbPath);
    migrate(db);
  });
  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("refuses without GMAIL_DRAFTS_ENABLED — fail closed, no browser opens", async () => {
    await expect(
      createGmailDraft({
        db,
        applicationId: randomUUID(),
        contactId: randomUUID(),
      }),
    ).rejects.toThrow(/GMAIL_DRAFTS_ENABLED=false/);
  });

  it("resumeAttachmentName: First_Last_Resume.pdf, sanitized, with a plain fallback", () => {
    expect(resumeAttachmentName({ first: "Shubham", last: "Kale" })).toBe("Shubham_Kale_Resume.pdf");
    expect(resumeAttachmentName({ first: " Ana María", last: "O'Neil\"" })).toBe("Ana_Mar_a_O_Neil_Resume.pdf");
    expect(resumeAttachmentName({ first: "", last: "" })).toBe("Resume.pdf");
    expect(resumeAttachmentName(null)).toBe("Resume.pdf");
  });

  describe("resolveDraftAttachment", () => {
    let dir: string;
    let appId: string;
    const name = () => ({ first: "Shubham", last: "Kale" });
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-draft-resume-"));
      const job = upsertJobByFingerprint(db, { company: "Boston Scientific", role: "SWE Intern", applicationUrl: "https://example.test/jobs/1" });
      appId = createApplication(db, { jobId: job.id }).id;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function registerRow(file: string, sha256: string): void {
      db.prepare(
        `INSERT INTO materials (id, application_id, kind, path, sha256, size_bytes, verified, metadata_json, created_at)
         VALUES (?, ?, 'resume', ?, ?, ?, 1, '{}', ?)`,
      ).run(randomUUID(), appId, file, sha256, 1, new Date().toISOString());
    }

    it("no resume material ⇒ no attachment, with the reason named", () => {
      const r = resolveDraftAttachment(db, appId, { candidateName: name });
      expect(r.attachment).toBeNull();
      expect(r.note).toMatch(/no verified resume material/);
    });

    it("attaches the exact submitted bytes under the candidate's name", () => {
      const bytes = Buffer.from("%PDF-1.7\nsubmitted resume\n%%EOF\n");
      const file = path.join(dir, "resume-abcd1234.pdf");
      fs.writeFileSync(file, bytes);
      registerRow(file, createHash("sha256").update(bytes).digest("hex"));
      const r = resolveDraftAttachment(db, appId, { candidateName: name });
      expect(r.attachment?.name).toBe("Shubham_Kale_Resume.pdf");
      expect(r.attachment?.mimeType).toBe("application/pdf");
      expect(r.attachment?.buffer.equals(bytes)).toBe(true);
      expect(r.note).toMatch(/attaching the submitted resume as Shubham_Kale_Resume\.pdf/);
    });

    it("refuses a file that changed since it was registered, and a file that is gone", () => {
      const file = path.join(dir, "resume-changed.pdf");
      fs.writeFileSync(file, Buffer.from("%PDF-1.7\nedited later\n%%EOF\n"));
      registerRow(file, "0".repeat(64));
      const changed = resolveDraftAttachment(db, appId, { candidateName: name });
      expect(changed.attachment).toBeNull();
      expect(changed.note).toMatch(/sha256 mismatch/);
      fs.rmSync(file);
      const gone = resolveDraftAttachment(db, appId, { candidateName: name });
      expect(gone.attachment).toBeNull();
      expect(gone.note).toMatch(/missing on disk/);
    });
  });

  it("the migration created the gmail_drafts table with its idempotency key", () => {
    const cols = db
      .prepare(`PRAGMA table_info(gmail_drafts)`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "application_id",
        "contact_id",
        "recipient_email",
        "subject",
        "status",
        "verified",
      ]),
    );
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'gmail_drafts'`)
      .get() as { sql: string };
    expect(idx.sql).toContain("UNIQUE(application_id, recipient_email)");
  });
});
