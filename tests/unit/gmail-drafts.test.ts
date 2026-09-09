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
} from "../../src/outreach/gmailDrafts.js";
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
