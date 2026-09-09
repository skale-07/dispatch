import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { handleAuthExpiry } from "../auth/authExpiry.js";
import { getConfig } from "../config/index.js";
import {
  getOrCreateApplicationForJob,
  jobHasVerifiedSubmission,
  newDiscoveryRunId,
} from "../jobs/applicationDedupe.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { hashJobDescription } from "../jobs/fingerprint.js";
import { logger } from "../logging/logger.js";
import { closeDatabase, migrate, openDatabase, type Db } from "../storage/db/client.js";
import {
  ensureApplicationArtifactDirs,
  writeJsonAtomic,
} from "../storage/atomicJson.js";
import { transitionApplication } from "../queue/stateMachine.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import {
  buildIdempotencyKey,
  claimIdempotencyKey,
  completeIdempotencyKey,
} from "../queue/idempotency.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { defaultJobRightStartUrl } from "../recorder/workflows.js";
import { evaluateEligibility } from "./eligibility.js";
import { parseJobCardsFromFeedHtml, type ParsedJobCard } from "./jobFeed.js";
import { readJobDetailSnapshot } from "./jobDetails.js";
import { probeApplyLauncher } from "./applyLauncher.js";
import { probeCoverLetterUi, probeResumeUi } from "./materials.js";
import {
  JOBRIGHT_SELECTOR_REGISTRY_VERSION,
  jobrightSelectorsV1,
} from "./selectors/v1.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { loadApplicationEducationPolicy, selectEducationPolicy } from "../candidate/applicationEducation.js";

export type DiscoveryOptions = {
  feedHtmlPath?: string;
  maxJobs?: number;
  /** Count fresh eligible jobs, scanning past known/ineligible cards in feed order. */
  freshOnly?: boolean;
  scanLimit?: number;
  openJobDetails?: boolean;
  headless?: boolean;
  /** Synthetic detail seam; callers using fixture HTML never access the network. */
  detailReader?: (card: ParsedJobCard) => Promise<string>;
};

export type DiscoveryReport = {
  selector_registry_version: number;
  feed_url: string;
  jobs_inspected: number;
  jobs_eligible: number;
  jobs_filtered_out: number;
  jobs_reused: number;
  jobs_skipped_submitted: number;
  /** Non-fatal per-card problems (fresh-mode detail reads, etc.). */
  notes?: string[];
  applications: Array<{
    application_id: string;
    jobright_job_id: string;
    company: string;
    role: string;
    eligible: boolean;
    state: string;
    dedupe_kind: string;
  }>;
};

/**
 * JobRight feed discovery + eligibility. Idempotent per job for active applications.
 * Does not open employer forms or submit.
 */
export async function runJobRightDiscovery(
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const maxJobs = options.maxJobs ?? 10;
  const scanLimit = options.freshOnly
    ? Math.min(100, Math.max(1, options.scanLimit ?? 40))
    : maxJobs;
  const feedUrl = defaultJobRightStartUrl();
  const runId = newDiscoveryRunId();

  const cards = options.feedHtmlPath
    ? parseJobCardsFromFeedHtml(
        fs.readFileSync(options.feedHtmlPath, "utf8"),
      ).slice(0, scanLimit)
    : await scrapeFeedCardsLive({
        feedUrl,
        maxJobs: scanLimit,
        headless: options.headless ?? false,
        runId,
      });

  const db = openDatabase();
  migrate(db);

  const report: DiscoveryReport = {
    selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
    feed_url: feedUrl,
    jobs_inspected: 0,
    jobs_eligible: 0,
    jobs_filtered_out: 0,
    jobs_reused: 0,
    jobs_skipped_submitted: 0,
    notes: [],
    applications: [],
  };

  try {
    for (const card of cards) {
      if (options.freshOnly && report.jobs_eligible >= maxJobs) break;
      report.jobs_inspected += 1;
      if (options.freshOnly) {
        const known = db.prepare(
          `SELECT a.id, a.state FROM jobs j JOIN applications a ON a.job_id = j.id
           WHERE j.jobright_job_id = ? ORDER BY a.created_at DESC LIMIT 1`,
        ).get(card.jobright_job_id) as { id: string; state: string } | undefined;
        if (known) {
          report.jobs_reused += 1;
          continue;
        }
        if (!/intern|co-?op/i.test(`${card.role} ${card.employment_type ?? ""}`)) {
          report.jobs_filtered_out += 1;
          continue;
        }
      }
      let description: string;
      if (options.detailReader) {
        description = await options.detailReader(card);
      } else if (options.freshOnly && !options.feedHtmlPath) {
        // A flaky detail page (timeout, auth blip, id mismatch) must cost
        // one CARD, not the whole discovery run — in fresh mode an aborted
        // discovery ends the entire cycle as no_fresh_candidate.
        try {
          description = await readDiscoveryDescription(card, options.headless ?? false);
        } catch (err) {
          const detail = err instanceof Error ? err.message.slice(0, 160) : String(err);
          (report.notes ??= []).push(
            `detail read failed for ${card.jobright_job_id} — card skipped: ${detail}`,
          );
          // Night26: 12 of 12 cards were "filtered" with no visible reason —
          // the worker only logs counts, so the note above never surfaced.
          logger.warn("jobright discovery: detail read failed — card skipped", {
            service: "jobright",
            action: "discovery_detail",
            metadata: { jobright_job_id: card.jobright_job_id, role: card.role.slice(0, 80), error: detail },
          });
          report.jobs_filtered_out += 1;
          continue;
        }
      } else {
        description = card.role;
      }
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: card.jobright_job_id,
        applicationUrl: card.job_url,
        company: card.company,
        role: card.role,
        location: card.location,
        employmentType: card.employment_type,
        descriptionText: description,
        descriptionHash: hashJobDescription(description),
        raw: card,
      });

      const leaseKey = job.job_fingerprint;
      try {
        acquireLease(db, {
          resourceType: "job",
          resourceId: `${leaseKey}:discovery`,
          holderRunId: runId,
          ttlMs: 120_000,
        });
      } catch {
        report.applications.push({
          application_id: "",
          jobright_job_id: card.jobright_job_id,
          company: card.company,
          role: card.role,
          eligible: false,
          state: "LEASE_HELD",
          dedupe_kind: "LEASE_BLOCKED",
        });
        continue;
      }

      try {
        const idemKey = buildIdempotencyKey("discovery_enqueue", {
          job_fingerprint: job.job_fingerprint,
          generation: "active",
        });
        const claim = claimIdempotencyKey(db, idemKey, {
          holderRunId: runId,
          resourceType: "job",
          resourceId: job.id,
        });

        const dedupe = getOrCreateApplicationForJob(db, {
          jobId: job.id,
          versions: {
            selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
            adapter: "jobright",
            adapter_version: 1,
          },
        });

        if (
          dedupe.kind === "ALREADY_VERIFIED_SUBMITTED" ||
          dedupe.kind === "UNCERTAIN_SUBMISSION" ||
          // #209: abandoned by operator/policy — stays abandoned.
          dedupe.kind === "POLICY_ABANDONED"
        ) {
          report.jobs_skipped_submitted += 1;
          if (claim.action === "execute") {
            completeIdempotencyKey(db, idemKey, dedupe.applicationId);
          }
          report.applications.push({
            application_id: dedupe.applicationId,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: false,
            state: dedupe.application.state,
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        if (dedupe.kind === "EXISTING_ACTIVE") {
          report.jobs_reused += 1;
          if (claim.action === "execute") {
            completeIdempotencyKey(db, idemKey, dedupe.applicationId);
          }
          const eligible = !["FILTERED_OUT"].includes(dedupe.application.state);
          if (eligible && dedupe.application.state === "QUEUED") {
            report.jobs_eligible += 1;
          }
          report.applications.push({
            application_id: dedupe.applicationId,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: dedupe.application.state === "QUEUED",
            state: dedupe.application.state,
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        // CREATED — run eligibility pipeline once
        const app = dedupe.application;
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "DUPLICATE_CHECK",
          reason: "phase55_discovery_dedupe_pass",
        });

        const alreadySubmitted = jobHasVerifiedSubmission(db, job.id);

        transitionApplication(db, {
          applicationId: app.id,
          nextState: "ELIGIBILITY_CHECK",
          reason: "phase55_discovery",
        });

        const eligibility = evaluateEligibility({
          role: card.role,
          employmentType: card.employment_type,
          description,
          alreadySubmitted,
          location: card.location,
          education: selectEducationPolicy(loadApplicationEducationPolicy(), { role: card.role, description }),
        });

        const dirs = ensureApplicationArtifactDirs(app.id);
        writeJsonAtomic(path.join(dirs.root, "job.json"), {
          ...card,
          description_text: description,
          job_db_id: job.id,
        });
        writeJsonAtomic(path.join(dirs.root, "eligibility.json"), eligibility);

        if (!eligibility.eligible) {
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "FILTERED_OUT",
            reason: "ineligible",
            route: "INELIGIBLE",
          });
          report.jobs_filtered_out += 1;
          completeIdempotencyKey(db, idemKey, app.id);
          report.applications.push({
            application_id: app.id,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: false,
            state: "FILTERED_OUT",
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        transitionApplication(db, {
          applicationId: app.id,
          nextState: "QUEUED",
          reason: "eligible",
        });
        completeIdempotencyKey(db, idemKey, app.id);
        report.jobs_eligible += 1;
        report.applications.push({
          application_id: app.id,
          jobright_job_id: card.jobright_job_id,
          company: card.company,
          role: card.role,
          eligible: true,
          state: "QUEUED",
          dedupe_kind: dedupe.kind,
        });
      } finally {
        releaseLease(db, {
          resourceType: "job",
          resourceId: `${leaseKey}:discovery`,
          holderRunId: runId,
        });
      }
    }

    if (options.openJobDetails && !options.feedHtmlPath && cards[0]) {
      await probeFirstJobDetail(cards[0].job_url, options.headless ?? false);
    }
  } finally {
    closeDatabase(db);
  }

  logger.info("jobright discovery complete", {
    service: "jobright",
    action: "discovery",
    metadata: {
      inspected: report.jobs_inspected,
      eligible: report.jobs_eligible,
      filtered: report.jobs_filtered_out,
      reused: report.jobs_reused,
      skipped_submitted: report.jobs_skipped_submitted,
    },
  });

  return report;
}

async function readDiscoveryDescription(card: ParsedJobCard, headless: boolean): Promise<string> {
  const session = new PlaywrightServiceSession({ service: "jobright", headless, slowMoMs: 40 });
  try {
    await session.open();
    const page = await session.newPage({ purpose: "discovery_requirements" });
    try {
      await page.goto(card.job_url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.locator(jobrightSelectorsV1.feed.jobTitle).first().waitFor({ timeout: 15_000 });
      if (await detectAuthLossOnPage(page, "jobright")) throw new Error("AUTH_REQUIRED: JobRight detail session expired");
      const snapshot = await readJobDetailSnapshot(page);
      if (snapshot.jobright_job_id !== card.jobright_job_id || !snapshot.description_text?.trim()) {
        throw new Error(`JobRight requirements unavailable for ${card.jobright_job_id}`);
      }
      return snapshot.description_text;
    } finally { await page.close().catch(() => undefined); }
  } finally { await session.close(); }
}

/** Attempt cap on feed scrolling (#179): each scroll costs ~1.2 s. */
const MAX_FEED_SCROLLS = 6;

async function scrapeFeedCardsLive(options: {
  feedUrl: string;
  maxJobs: number;
  headless: boolean;
  runId: string;
}): Promise<ParsedJobCard[]> {
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: options.headless,
    slowMoMs: 40,
  });
  const db = openDatabase();
  migrate(db);
  try {
    await session.open();
    const page = await session.newPage({ purpose: "jobright_feed" });
    try {
      await page.goto(options.feedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // Recommend feed is client-rendered. Prefer waiting for cards over a fixed sleep.
      // Timeout alone is not enough: parser can still return [] if href patterns drift.
      const cardsAttached = await page
        .waitForSelector(jobrightSelectorsV1.feed.jobInfoLinks, {
          timeout: 30_000,
          state: "attached",
        })
        .then(() => true)
        .catch(() => false);
      // No networkidle wait: this feed keeps connections open, so it never
      // settles and only costs the full timeout before being swallowed.
      await page.waitForTimeout(500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        handleAuthExpiry(db, {
          service: "jobright",
          detail: "Login wall during JobRight feed scrape",
        });
        throw new Error("AUTH_REQUIRED: JobRight session expired during discovery");
      }
      // #179 (night26): the recommend feed renders ~8 cards and lazy-loads
      // the rest on scroll; a single content() read starved fresh
      // discovery for 30h+ (same 8 cards every cycle). Scroll, bounded,
      // until the parsed card count reaches maxJobs or stops growing.
      let html = await page.content();
      let parsed = parseJobCardsFromFeedHtml(html);
      for (let i = 0; i < MAX_FEED_SCROLLS && cardsAttached && parsed.length < options.maxJobs; i++) {
        // The feed lives in an overflow container, not the window: a
        // read-only probe (2026-09-08) showed window scroll and mouse
        // wheel load nothing, while scrolling the tallest scrollable
        // element to its bottom loaded more cards (7 → 11).
        await page
          .evaluate(() => {
            type El = { scrollHeight: number; clientHeight: number; scrollTop: number };
            const g = globalThis as unknown as {
              document: { querySelectorAll(sel: string): ArrayLike<El>; documentElement: El };
              getComputedStyle(el: El): { overflowY: string };
              scrollTo(x: number, y: number): void;
            };
            const scrollers = Array.from(g.document.querySelectorAll("*")).filter((el) => {
              const s = g.getComputedStyle(el);
              return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50;
            });
            scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
            const target = scrollers[0];
            if (target) target.scrollTop = target.scrollHeight;
            else g.scrollTo(0, g.document.documentElement.scrollHeight);
          })
          .catch(() => undefined);
        await page.waitForTimeout(1500);
        const next = parseJobCardsFromFeedHtml(await page.content());
        if (next.length <= parsed.length) {
          html = await page.content();
          parsed = next.length > parsed.length ? next : parsed;
          break;
        }
        html = await page.content();
        parsed = next;
      }
      const cards = parsed.slice(0, options.maxJobs);
      if (cards.length === 0) {
        await failLoudEmptyFeed(page, db, {
          feedUrl: options.feedUrl,
          cardsAttached,
          html,
          runId: options.runId,
        });
      }
      return cards;
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
    closeDatabase(db);
  }
}

export type EmptyFeedMeta = {
  feed_url: string;
  final_url: string;
  title: string;
  cards_selector_attached: boolean;
  html_bytes: number;
  html_path: string;
  screenshot_path: string;
  likely_cause: string;
  note: string;
};

/**
 * Pure evidence summary for an empty live feed.
 * `cards_selector_attached` is the discriminator: cards present but unparsed
 * means the parser drifted; cards absent means auth or render never happened.
 */
export function buildEmptyFeedMeta(input: {
  feedUrl: string;
  finalUrl: string;
  title: string;
  cardsAttached: boolean;
  htmlBytes: number;
  htmlPath: string;
  screenshotPath: string;
}): EmptyFeedMeta {
  return {
    feed_url: input.feedUrl,
    final_url: input.finalUrl,
    title: input.title,
    cards_selector_attached: input.cardsAttached,
    html_bytes: input.htmlBytes,
    html_path: input.htmlPath,
    screenshot_path: input.screenshotPath,
    likely_cause: input.cardsAttached
      ? "job card links rendered but parser matched none — selector/parser drift"
      : "no job card links ever rendered — session auth or feed render",
    note: "Live discovery parsed zero job cards — inspect artifacts before changing selectors",
  };
}

/**
 * Empty live feed must never look like success. Persist evidence and open a review item.
 */
async function failLoudEmptyFeed(
  page: Page,
  db: Db,
  input: {
    feedUrl: string;
    cardsAttached: boolean;
    html: string;
    runId: string;
  },
): Promise<never> {
  const dir = path.join(
    getConfig().artifactsDir,
    "discovery",
    `empty-feed-${input.runId}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "page.html");
  const shotPath = path.join(dir, "page.png");
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(htmlPath, input.html, "utf8");
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
  const meta = buildEmptyFeedMeta({
    feedUrl: input.feedUrl,
    finalUrl: page.url(),
    title: await page.title().catch(() => ""),
    cardsAttached: input.cardsAttached,
    htmlBytes: input.html.length,
    htmlPath,
    screenshotPath: shotPath,
  });
  writeJsonAtomic(metaPath, meta);

  const { item } = upsertOpenReviewItem(db, {
    kind: "MANUAL",
    title: "JobRight feed discovery returned zero cards",
    payload: meta,
  });

  logger.error("jobright live discovery empty feed", {
    service: "jobright",
    action: "discovery",
    metadata: { ...meta, review_item_id: item.id },
  });

  throw new Error(
    `EMPTY_FEED: JobRight live discovery found 0 job cards (selector_attached=${input.cardsAttached}). ` +
      `Artifacts: ${dir}. Review item: ${item.id}`,
  );
}

async function probeFirstJobDetail(
  jobUrl: string,
  headless: boolean,
): Promise<void> {
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless,
    slowMoMs: 40,
  });
  const db = openDatabase();
  migrate(db);
  try {
    await session.open();
    const page = await session.newPage({ purpose: "job_detail_probe" });
    try {
      await page.goto(jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        handleAuthExpiry(db, {
          service: "jobright",
          detail: "Login wall during JobRight job detail probe",
        });
        throw new Error("AUTH_REQUIRED: JobRight session expired during detail probe");
      }
      const detail = await readJobDetailSnapshot(page);
      const apply = await probeApplyLauncher(page);
      const resume = await probeResumeUi(page);
      const cover = await probeCoverLetterUi(page);
      const out = path.join(
        getConfig().artifactsDir,
        "discovery",
        `job-detail-probe-${randomUUID()}.json`,
      );
      fs.mkdirSync(path.dirname(out), { recursive: true });
      writeJsonAtomic(out, {
        detail,
        apply,
        resume,
        cover,
        selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
        selectors_note: jobrightSelectorsV1.contacts.note,
      });
      console.log(`Wrote job detail probe: ${out}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
    closeDatabase(db);
  }
}

export async function inspectJobById(options: {
  jobId: string;
  feedHtmlPath?: string;
}): Promise<ParsedJobCard | null> {
  if (options.feedHtmlPath) {
    const cards = parseJobCardsFromFeedHtml(
      fs.readFileSync(options.feedHtmlPath, "utf8"),
    );
    return cards.find((c) => c.jobright_job_id === options.jobId) ?? null;
  }
  const cards = await scrapeFeedCardsLive({
    feedUrl: defaultJobRightStartUrl(),
    maxJobs: 40,
    headless: false,
    runId: newDiscoveryRunId(),
  });
  return cards.find((c) => c.jobright_job_id === options.jobId) ?? null;
}
