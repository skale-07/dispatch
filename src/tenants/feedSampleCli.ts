#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { parseJobCardsFromFeedHtml } from "../jobright/jobFeed.js";
import { jobrightSelectorsV1 } from "../jobright/selectors/v1.js";

/**
 * Feed sample, child side (plan v0.5, M20). Runs in a TENANT child env
 * (PRIVATE_DIR is the tenant's workspace, the parent unsealed
 * private/auth/jobright.storage.json for exactly this run): open the
 * user's own Recommended feed headless through the ordinary session seam,
 * parse the first cards, write `{ ok, jobs: [{title, company, location}] }`
 * to --out. Nothing is stored — no jobs table, no application — and no
 * description is read: the sample is proof that the user's own filters
 * produce a feed, never a discovery run.
 *
 *   node tsx/cli src/tenants/feedSampleCli.ts --out <file> [--max 10]
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export type FeedSampleFile = {
  ok: boolean;
  reason: "auth_required" | "empty_feed" | "error" | null;
  jobs: Array<{ title: string; company: string; location: string | null }>;
  cards_attached: boolean;
  sampled_at: string;
};

async function main(): Promise<void> {
  const out = arg("--out");
  if (!out) throw new Error("--out <file> is required");
  const max = Math.max(1, Math.min(Number(arg("--max") ?? 10) || 10, 25));
  const result: FeedSampleFile = { ok: false, reason: null, jobs: [], cards_attached: false, sampled_at: new Date().toISOString() };

  const session = new PlaywrightServiceSession({ service: "jobright", headless: true, slowMoMs: 0, skipAuthValidation: true });
  try {
    await session.open();
    const page = await session.newPage({ purpose: "tenant_feed_sample" });
    try {
      await page.goto(jobrightSelectorsV1.urls.recommendFeed, { waitUntil: "domcontentloaded", timeout: 60_000 });
      result.cards_attached = await page
        .waitForSelector(jobrightSelectorsV1.feed.jobInfoLinks, { timeout: 30_000, state: "attached" })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        result.reason = "auth_required";
      } else {
        const cards = parseJobCardsFromFeedHtml(await page.content()).slice(0, max);
        result.jobs = cards.map((c) => ({ title: c.role, company: c.company, location: c.location }));
        result.ok = result.jobs.length > 0;
        result.reason = result.ok ? null : "empty_feed";
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (err) {
    result.reason = /AUTH_REQUIRED/i.test(err instanceof Error ? err.message : String(err)) ? "auth_required" : "error";
  } finally {
    await session.close().catch(() => undefined);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
