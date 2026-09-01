import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import {
  buildInviteLink,
  DEFAULT_QUOTA,
  generateInviteCode,
  invitesToCsv,
  invitesToSupabaseSql,
  mintInvites,
  persistInvites,
} from "../../src/cloud/invites.js";

describe("cloud invites (UNIT_CONFIRMED)", () => {
  it("generates codes in the documented shape with no lookalike characters", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^JRA-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(code).not.toMatch(/[01OILU]/);
    }
  });

  it("builds redemption links and rejects non-absolute base URLs", () => {
    expect(buildInviteLink("https://example.com/", "JRA-AAAA-BBBB")).toBe(
      "https://example.com/redeem?code=JRA-AAAA-BBBB",
    );
    expect(() => buildInviteLink("example.com", "JRA-AAAA-BBBB")).toThrow(
      /absolute http/,
    );
  });

  it("mints unique codes with quota + issuer defaults and bounds", () => {
    const minted = mintInvites({ count: 25, baseUrl: "https://d.example" });
    expect(minted).toHaveLength(25);
    expect(new Set(minted.map((m) => m.code)).size).toBe(25);
    for (const inv of minted) {
      expect(inv.maxCompletedApplications).toBe(DEFAULT_QUOTA);
      expect(inv.issuer).toBe("operator");
      expect(inv.link).toContain(encodeURIComponent(inv.code));
    }
    expect(() => mintInvites({ count: 0, baseUrl: "https://d.example" })).toThrow(
      /--count/,
    );
    expect(() =>
      mintInvites({ count: 1, quota: 0, baseUrl: "https://d.example" }),
    ).toThrow(/--quota/);
    expect(() =>
      mintInvites({ count: 1, quota: 101, baseUrl: "https://d.example" }),
    ).toThrow(/--quota/);
  });

  it("emits Supabase SQL with escaping and idempotent conflict handling", () => {
    const minted = mintInvites({
      count: 1,
      quota: 10,
      baseUrl: "https://d.example",
      issuer: "o'brien",
      note: 'says "hi", twice',
    });
    const sql = invitesToSupabaseSql(minted);
    expect(sql).toContain("insert into public.invites");
    expect(sql).toContain("'o''brien'");
    expect(sql).toContain("on conflict (code) do nothing");
    expect(sql).toContain(`'${minted[0]!.code}'`);
    expect(sql).toContain(", 10,");
  });

  it("emits CSV with a header and quoted fields", () => {
    const minted = mintInvites({
      count: 2,
      baseUrl: "https://d.example",
      issuer: "a,b",
    });
    const csv = invitesToCsv(minted);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("code,issuer,max_completed_applications,link,created_at");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"a,b"');
  });

  describe("local ledger persistence", () => {
    let dbPath: string;
    let db: Db;

    beforeEach(() => {
      dbPath = path.join(os.tmpdir(), `jaa-invites-${randomUUID()}.sqlite`);
      db = openDatabase(dbPath);
      migrate(db);
    });

    afterEach(() => {
      closeDatabase(db);
      fs.rmSync(dbPath, { force: true });
    });

    it("persists minted invites and enforces code uniqueness", () => {
      const minted = mintInvites({ count: 3, baseUrl: "https://d.example" });
      persistInvites(db, minted);
      const rows = db
        .prepare(
          `SELECT code, issuer, max_completed_applications, link FROM cloud_invites ORDER BY code`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r["code"]).sort()).toEqual(
        minted.map((m) => m.code).sort(),
      );
      // Same codes again must violate UNIQUE — the ledger cannot fork.
      expect(() => persistInvites(db, minted)).toThrow(/UNIQUE/);
    });
  });
});
