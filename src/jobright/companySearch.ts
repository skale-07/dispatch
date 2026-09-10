import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { findCompanyTwinJob } from "./storedJobTarget.js";

/**
 * #242 — a contact source for board-discovered applications.
 *
 * Outreach reaches real people through JobRight's insider panel, which is
 * keyed to a JobRight JOB. A board-discovered application has no JobRight
 * posting of its own, so #207 taught the resolver to borrow any STORED
 * JobRight job of the same employer (the panel is per-company, not per
 * posting). That only helps when the company happens to have appeared in
 * the feed before.
 *
 * Night29 made the gap total: under the 24h posting policy the JobRight
 * feed contributes almost nothing, so every submission of the night was
 * board-sourced, none had a stored twin, and the Gmail tail produced ZERO
 * drafts against twelve verified submits — while the operator's standing
 * directive is to run the Gmail pipeline after every submission.
 *
 * JobRight's own search resolves any employer: `/jobs/search?value=<company>`
 * returns that company's postings (live: 373 results for "Rocket Lab",
 * including the very intern postings we had just applied to through the
 * board). One search yields a JobRight job id for the company, which is
 * all the insider panel needs.
 *
 * Read-only against JobRight — a search navigation and a DOM read, no
 * clicks on cards, nothing applied to. The only write is a local `jobs`
 * row, so the next lookup is the deterministic stored-twin path again.
 */

export type CompanySearchHit = {
  jobright_job_id: string;
  url: string;
  role: string;
  card_text: string;
};

export function jobRightCompanySearchUrl(company: string): string {
  const value = encodeURIComponent(company.trim());
  return `https://jobright.ai/jobs/search?value=${value}&searchType=job_title&country=US`;
}

/**
 * Does this result card actually belong to `company`?
 *
 * A card renders as "<age><badges><role><Company>/<industry>…", so the
 * company name is the token immediately before the industry slash. Testing
 * for that shape — rather than "the text mentions the company" — is what
 * stops a card whose DESCRIPTION happens to name the employer (every
 * "…competitor to Rocket Lab…" posting) from being accepted.
 */
/**
 * Generic corporate words a catalogue appends to the same employer.
 * JobRight indexes "Saronic Technologies" where the board says "Saronic".
 * Stripped only from the END of the card's company slot, never from the
 * middle, so "Rocket Lab" keeps its "Lab".
 */
const GENERIC_TAIL = new Set([
  "technologies", "technology", "tech", "labs", "lab", "systems", "solutions",
  "group", "holdings", "partners", "industries", "international", "global",
  "company", "corporation", "corp", "inc", "llc", "ltd", "limited", "plc",
  "usa", "us", "co",
]);

/**
 * The company slot of a result card: the run of text immediately before
 * the industry separator. Cards render as
 *   "<age><badges><role><Company> / <industry> · <stage><location>…"
 * and the separator carries spaces on some cards ("Saronic Technologies /
 * Artificial Intelligence") and none on others ("Rocket Lab/Aerospace"),
 * which is why this reads the slot instead of testing for `name + "/"`.
 */
export function cardCompanySlot(cardText: string): string {
  const text = cardText.replace(/\s+/g, " ");
  const slash = text.indexOf("/");
  return slash < 0 ? "" : text.slice(0, slash).trim();
}

/** The slot with trailing generic corporate words removed. */
function strippedSlot(slot: string): string {
  const tokens = slot.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let end = tokens.length;
  while (end > 1 && GENERIC_TAIL.has(tokens[end - 1]!)) end -= 1;
  return tokens.slice(0, end).join(" ");
}

export type CardMatch = "exact" | "generic_tail" | "none";

/**
 * How well a card's company slot matches the company we applied to.
 *
 * "exact"        the slot IS the name (modulo legal/country qualifiers)
 * "generic_tail" the slot is the name plus a generic corporate word —
 *                "Saronic Technologies" for "Saronic"
 * "none"         a different employer
 *
 * The caller prefers an exact card and only falls back to a generic-tail
 * one, because the fallback is genuinely ambiguous: it cannot tell
 * "Saronic Technologies" (the same company) from "Verkada Partners" (a
 * different one). Preferring exact means the ambiguity only decides when
 * there is nothing better on the page.
 */
export function classifyCardCompany(cardText: string, company: string): CardMatch {
  const slot = cardCompanySlot(cardText);
  if (!slot) return "none";
  const flatSlot = slot.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const bareSlot = strippedSlot(slot);
  const variants = companyNameVariants(company).filter((v) => v.length >= 2);
  // The role runs straight into the company on some cards
  // ("…InternRocket Lab"), so the slot ENDS WITH the name.
  for (const candidate of variants) {
    if (flatSlot.endsWith(candidate)) return "exact";
  }
  for (const candidate of variants) {
    if (bareSlot.endsWith(candidate)) return "generic_tail";
  }
  return "none";
}

export function cardMatchesCompany(cardText: string, company: string): boolean {
  return classifyCardCompany(cardText, company) !== "none";
}

/**
 * Legal-entity and country qualifiers that two catalogues routinely
 * disagree about for the SAME employer — the board says "Rocket Lab USA",
 * JobRight says "Rocket Lab"; one says "Acme, Inc.", the other "Acme".
 *
 * Deliberately only these. "Partners", "Technologies", "Labs", "Group"
 * and friends DISTINGUISH employers ("Verkada" is not "Verkada Partners"),
 * so they are never stripped, and the stored-twin lookup's exact match is
 * untouched — this widening applies solely to verifying a search result.
 */
const ENTITY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "corp",
  "corporation", "co", "company", "plc", "gmbh", "ag", "nv", "bv", "sa",
  "usa", "us",
]);

function normalizeCompanyName(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The company name, plus the same name with trailing entity/country
 * qualifiers removed. Longest first, so an exact catalogue match always
 * wins over the stripped form.
 */
export function companyNameVariants(company: string): string[] {
  const full = normalizeCompanyName(company);
  if (!full) return [];
  const variants = [full];
  const tokens = full.split(" ");
  let end = tokens.length;
  while (end > 1 && ENTITY_SUFFIXES.has(tokens[end - 1]!)) end -= 1;
  const stripped = tokens.slice(0, end).join(" ");
  if (stripped && stripped !== full) variants.push(stripped);
  // "Acme.io" / "Acme.ai" also appear without the TLD-looking tail. Read
  // it off the ORIGINAL string — normalization has already turned the dot
  // into a space by this point.
  const bare = normalizeCompanyName(
    company.trim().replace(/\.(io|ai|com|co|dev|xyz)$/i, ""),
  );
  if (bare && !variants.includes(bare)) variants.push(bare);
  return variants;
}

const JOB_ID_RE = /\/jobs\/info\/([0-9a-f]{8,})/i;

export function parseJobRightJobId(url: string): string | null {
  const m = JOB_ID_RE.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * First search result that really belongs to `company`. Bounded: one
 * navigation, one settle, one DOM read — no scrolling, no pagination, no
 * retry loop. Null means "JobRight does not list this employer", which is
 * a truthful outcome, not an error.
 */
export async function searchJobRightForCompany(
  page: Page,
  company: string,
  options: { settleMs?: number } = {},
): Promise<CompanySearchHit | null> {
  // Search under the catalogue-neutral name: JobRight indexes "Rocket
  // Lab", the board said "Rocket Lab USA", and the full string returns
  // nothing. Verification below still requires a real company-slot match.
  const queryName = companyNameVariants(company).slice(-1)[0] ?? company;
  await page.goto(jobRightCompanySearchUrl(queryName), {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(options.settleMs ?? 7_000);
  const cards = await page.evaluate(() => {
    type El = { href?: string; textContent: string | null; parentElement: El | null };
    const g = globalThis as unknown as {
      document: { querySelectorAll(sel: string): ArrayLike<El> };
    };
    const out: Array<{ href: string; text: string }> = [];
    const seen = new Set<string>();
    for (const a of Array.from(g.document.querySelectorAll("a[href*='/jobs/info/']"))) {
      const href = a.href ?? "";
      if (!href || seen.has(href)) continue;
      seen.add(href);
      // Climb to the card container: the company name and role live on
      // the card, not on the anchor.
      let node: El | null = a;
      for (let i = 0; i < 6 && node?.parentElement; i += 1) {
        node = node.parentElement;
        if ((node.textContent ?? "").length > 120) break;
      }
      out.push({
        href,
        text: (node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      });
      if (out.length >= 12) break;
    }
    return out;
  });
  // Exact cards first: a page that lists the employer itself must never be
  // decided by an ambiguous generic-tail match elsewhere on the same page.
  for (const strictness of ["exact", "generic_tail"] as const) {
    for (const card of cards) {
      if (classifyCardCompany(card.text, company) !== strictness) continue;
      const id = parseJobRightJobId(card.href);
      if (!id) continue;
      return {
        jobright_job_id: id,
        url: card.href,
        role: roleFromCardText(card.text, company),
        card_text: card.text,
      };
    }
  }
  return null;
}

/**
 * The role is the run of text just before "<Company>/". Best-effort: it
 * only labels the stored twin row, and nothing downstream reads it.
 */
export function roleFromCardText(cardText: string, company: string): string {
  const text = cardText.replace(/\s+/g, " ").trim();
  const idx = text.toLowerCase().indexOf(`${company.trim().toLowerCase()}/`);
  if (idx <= 0) return "role unknown";
  const before = text.slice(0, idx);
  // Strip the leading badge run ("5 hours ago3 school alumniEarly applicant").
  const cleaned = before.replace(/^.*?(?:applicant|ago|alumni)/i, "").trim();
  return (cleaned || before).slice(-90).trim() || "role unknown";
}

export type TwinBackfillResult = {
  company: string;
  found: boolean;
  source: "stored" | "search" | "none";
  jobright_job_id: string | null;
  note: string;
};

/**
 * Make sure `company` has a stored JobRight job the insider panel can be
 * read through, searching JobRight once when it does not. Fail-open: any
 * problem returns `found:false` with the reason, never a throw — outreach
 * having no contact source must not break a submitted application.
 */
export async function ensureCompanyTwinJob(input: {
  db: Db;
  company: string | null;
  /** Opens a JobRight page; caller owns the session. */
  openPage: () => Promise<Page>;
  closePage?: (page: Page) => Promise<void>;
}): Promise<TwinBackfillResult> {
  const company = (input.company ?? "").trim();
  const base = { company, found: false, jobright_job_id: null } as const;
  if (!company) {
    return { ...base, source: "none", note: "application has no company name" };
  }
  const stored = findCompanyTwinJob(input.db, company);
  if (stored) {
    return {
      company,
      found: true,
      source: "stored",
      jobright_job_id: stored.jobright_job_id,
      note: `stored JobRight job already exists for ${company}`,
    };
  }
  let page: Page | null = null;
  try {
    page = await input.openPage();
    const hit = await searchJobRightForCompany(page, company);
    if (!hit) {
      return {
        ...base,
        source: "none",
        note: `JobRight search returned no posting for "${company}"`,
      };
    }
    upsertJobByFingerprint(input.db, {
      jobrightJobId: hit.jobright_job_id,
      applicationUrl: hit.url,
      company,
      role: hit.role,
      raw: { source: "company_search", card_text: hit.card_text },
    });
    logger.info("company twin backfilled from JobRight search", {
      service: "outreach",
      action: "company_twin_search",
      metadata: { company, jobright_job_id: hit.jobright_job_id, role: hit.role },
    });
    return {
      company,
      found: true,
      source: "search",
      jobright_job_id: hit.jobright_job_id,
      note: `JobRight search resolved ${company} → ${hit.jobright_job_id}`,
    };
  } catch (err) {
    return {
      ...base,
      source: "none",
      note: `JobRight company search failed: ${
        err instanceof Error ? err.message.slice(0, 140) : String(err)
      }`,
    };
  } finally {
    if (page) {
      await (input.closePage?.(page) ?? page.close()).catch(() => undefined);
    }
  }
}
