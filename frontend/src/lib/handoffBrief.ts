import type { ReviewItemView } from "../api/types";

/**
 * C1: a parked wall is sometimes best finished by the operator driving
 * their own browser-embedded agent (Claude in Chrome) on the real page —
 * signed in as themselves, on their own cookies. Dispatch's job is to
 * hand that agent everything it needs in one paste: the page, what is
 * already done, what remains, and the rules of the house.
 *
 * Deliberately NOT offered for CAPTCHA_REQUIRED: a challenge exists to be
 * answered by the person, and pointing any agent at it would be
 * automating the check — the one line this product never crosses.
 */

const HANDOFF_KINDS = new Set(["AUTH_REQUIRED", "UNSUPPORTED_ATS", "MANUAL"]);

export function isHandoffBriefKind(kind: string): boolean {
  return HANDOFF_KINDS.has(kind);
}

function payloadUrl(item: ReviewItemView): string | null {
  for (const key of ["url", "employer_url"]) {
    const v = item.payload?.[key];
    if (typeof v === "string" && v.startsWith("https://")) return v;
  }
  return null;
}

function unansweredLines(item: ReviewItemView): string[] {
  const raw = item.payload?.["unanswered"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => u as { label?: unknown; control?: unknown })
    .filter((u) => typeof u.label === "string")
    .slice(0, 20)
    .map(
      (u) =>
        `- ${u.label as string}${typeof u.control === "string" ? ` (${u.control})` : ""}`,
    );
}

/**
 * Plain text, values-free by construction: it names questions and pages,
 * never answers — the operator supplies those in their own chat.
 */
export function buildHandoffBrief(item: ReviewItemView): string {
  const url = payloadUrl(item);
  const remaining = unansweredLines(item);
  const lines: string[] = [
    "You are helping me finish a job application I started with my own tooling. Work only in this tab, on this application.",
    "",
    `Application: ${item.company ?? "unknown company"} — ${item.role ?? "unknown role"}`,
    url ? `Page: ${url}` : "Page: (I will open the application page for you)",
    `Blocked on: ${item.title}`,
  ];
  if (remaining.length > 0) {
    lines.push("", "Questions still unanswered:", ...remaining);
  }
  lines.push(
    "",
    "Rules:",
    "- Ask me for any answer you don't have. Never invent or guess personal information.",
    "- Leave every demographic / self-identification / EEO question untouched — I answer those myself or not at all.",
    "- If a CAPTCHA or verification challenge appears, stop and tell me — never attempt to get past it.",
    "- Fill and review only. STOP before clicking Submit and show me what you entered.",
  );
  return lines.join("\n");
}
