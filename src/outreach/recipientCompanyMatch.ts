/**
 * #248 — an outreach recipient must actually work at the company we applied
 * to.
 *
 * Found 2026-09-10 while checking a subagent's report on a Zipline submit.
 * JobRight's insider panel is not one list: alongside people at the target
 * employer it shows "From Your School" and "From Your Previous Company" —
 * people the CANDIDATE has an affinity with, who often work somewhere else
 * entirely. The extractor treated every person in the panel as an insider,
 * so drafts were written to strangers about a job at a company they do not
 * work for. Already in the operator's Drafts folder when this was found:
 *
 *   Zipline app         -> ghao@zoox.com, aweinstein@zoox.com  (both DRAFTED)
 *   Coinbase app        -> vincent@usage.ai
 *   American Equity app -> nathans@pdhi.com
 *
 * The panel a person came from is not recorded on the contact row
 * (`jobright_context_json` only says `insider_triage`), so it cannot be
 * used retroactively. The email domain can: a corporate address names the
 * employer directly, and that is exactly the fact the draft asserts.
 *
 * Deliberately permissive, because the cost of a false NEGATIVE (a real
 * insider silently dropped) is a lost introduction, while the cost of a
 * false positive is an email to a stranger:
 *
 *   - a free-mail address (gmail, outlook …) is UNKNOWN, never a mismatch —
 *     plenty of real insiders hand out a personal address;
 *   - a placeholder company name is UNKNOWN — we cannot assert a mismatch
 *     against an employer we never resolved;
 *   - a domain that shares a meaningful token with the company matches, so
 *     rocketlabusa.com / drwholdings.com / american-equity.com all pass;
 *   - only a corporate domain with NO overlap is a mismatch, and even then
 *     the caller reports it by name rather than dropping it silently.
 */

export type RecipientMatch = {
  verdict: "match" | "unknown" | "mismatch";
  reason: string;
};

/** Consumer mailboxes say nothing about an employer either way. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "gmx.com", "mail.com", "zoho.com", "fastmail.com",
  "hey.com", "msn.com", "comcast.net", "verizon.net",
]);

/** Legal/rank noise that must not count as the overlap on its own. */
const WEAK_TOKENS = new Set([
  "inc", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation", "co",
  "company", "plc", "gmbh", "ag", "nv", "bv", "sa", "usa", "us", "the",
  "group", "holdings", "technologies", "technology", "tech", "labs", "lab",
  "systems", "solutions", "global", "international", "partners", "capital",
  "ventures", "trading", "management", "services", "software", "digital",
  "and", "of",
]);

/** Second-level registry labels that are not the company ("example.co.uk"). */
const REGISTRY_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** Stripped when joining the whole name; never a match on its own. */
const LEGAL_SUFFIX = new Set([
  "inc", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation", "co",
  "company", "plc", "gmbh", "ag", "nv", "bv", "sa", "usa", "us", "the",
]);

function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !WEAK_TOKENS.has(t));
}

/**
 * The registrable label: "mail.rocketlabusa.com" -> "rocketlabusa",
 * "example.co.uk" -> "example".
 *
 * Read positionally rather than by stripping a list of known TLDs — the
 * list approach returned the TLD itself for anything unlisted (".test",
 * ".de", ".ventures"), which would have mismatched, and dropped, perfectly
 * good recipients.
 */
export function domainLabel(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).trim().toLowerCase();
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const candidate = parts[parts.length - 2]!;
  if (REGISTRY_LABELS.has(candidate) && parts.length >= 3) {
    return parts[parts.length - 3]!;
  }
  return candidate;
}

export function isFreeMail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return FREE_MAIL.has(email.slice(at + 1).trim().toLowerCase());
}

/**
 * The contraction corporate domains use for multi-word names: the initials
 * of the leading words plus the head of the last one — "bsci" for Boston
 * Scientific (live 2026-09-13: the one insider email on that posting was
 * dropped as working "somewhere else"). Exact whole-label match only, at
 * least 4 characters and a 3+ character head, so a short label can never
 * ride on a coincidental letter or two ("bs", "bsc" do not match).
 */
function isInitialsPlusHead(label: string, words: string[]): boolean {
  if (words.length < 2 || label.length < 4) return false;
  const initials = words.slice(0, -1).map((w) => w[0]).join("");
  const last = words[words.length - 1]!;
  if (!label.startsWith(initials)) return false;
  const head = label.slice(initials.length);
  return head.length >= 3 && last.startsWith(head);
}

/** A company name we never actually resolved. */
function isPlaceholderCompany(company: string): boolean {
  const lowered = company.toLowerCase();
  return (
    lowered === "unknown" ||
    lowered.startsWith("unknown ") ||
    lowered.includes("unknown company")
  );
}

export function recipientMatchesCompany(
  email: string | null | undefined,
  company: string | null | undefined,
): RecipientMatch {
  const addr = (email ?? "").trim().toLowerCase();
  const co = (company ?? "").trim();
  if (!addr || !addr.includes("@")) {
    return { verdict: "unknown", reason: "no email address" };
  }
  if (!co) return { verdict: "unknown", reason: "application has no company name" };
  // `enqueueJobRightJobs` stores "Unknown company (manual enqueue)" when the
  // name was never resolved, and a board-discovered row can carry the same
  // shape. Treating that as a real name would mismatch EVERY corporate
  // address and silently drop every recipient on those applications.
  if (isPlaceholderCompany(co)) {
    return { verdict: "unknown", reason: `company name is a placeholder ("${co}")` };
  }
  if (isFreeMail(addr)) {
    return { verdict: "unknown", reason: "personal mailbox — says nothing about the employer" };
  }
  const label = domainLabel(addr);
  if (!label) return { verdict: "unknown", reason: "unparseable email domain" };

  const bareLabel = label.replace(/[^a-z0-9]/g, "");
  // The whole name minus legal suffixes: "DV Trading LLC" -> "dvtrading",
  // "Kensho Technologies" -> "kenshotechnologies". Weak tokens are noise on
  // their OWN but are part of the name when joined, which is what makes
  // dvtrading.co and american-equity.com resolve.
  const words = co
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !LEGAL_SUFFIX.has(t));
  const flatAll = words.join("");
  if (flatAll.length >= 3) {
    if (bareLabel.includes(flatAll)) {
      return { verdict: "match", reason: `domain "${label}" contains the company name` };
    }
    // "kensho" for "Kensho Technologies" — the domain is the distinctive
    // head of the name. Require a real prefix, not any substring.
    if (bareLabel.length >= 4 && flatAll.startsWith(bareLabel)) {
      return { verdict: "match", reason: `domain "${label}" is the head of the company name` };
    }
  }
  if (isInitialsPlusHead(bareLabel, words)) {
    return { verdict: "match", reason: `domain "${label}" abbreviates "${co}" (initials + head of the last word)` };
  }

  const tokens = companyTokens(co);
  if (tokens.length === 0) {
    return {
      verdict: "unknown",
      reason: `no distinctive token in company name "${co}" to compare against "${label}"`,
    };
  }
  for (const token of tokens) {
    // "rocketlabusa" contains "rocket"; "drwholdings" contains "drw".
    if (bareLabel.includes(token) || token.includes(bareLabel)) {
      return { verdict: "match", reason: `domain "${label}" carries company token "${token}"` };
    }
  }
  return {
    verdict: "mismatch",
    reason: `corporate domain "${label}" shares nothing with "${co}" — this person appears to work somewhere else`,
  };
}
