/**
 * Canonical failure signature: the dedup key for triage decisions. Built
 * ONLY from deterministic evidence — no LLM anywhere in it — because the
 * retry-differently rule ("never emit the same action for the same
 * signature twice") is enforced by exact string equality on this value.
 *
 * Shape: `${end_state}|${wall ?? "-"}|${reason_class}|${host ?? "-"}`
 */

export type ReasonClass =
  | "login_wall"
  | "captcha"
  | "duplicate_url"
  | "closed"
  | "config_stale"
  | "upload_failed"
  | "verify_mismatch"
  | "budget"
  | "cdp"
  | "unknown";

/**
 * Ordered bucket table — first match wins. Patterns come from the real
 * stop_reason strings observed in night sessions (see
 * artifacts/overnight-issues-*.md); keep them aligned with the strings
 * runPipeline/runNavigation actually emit.
 */
const REASON_BUCKETS: Array<[ReasonClass, RegExp]> = [
  ["duplicate_url", /duplicate employer url|duplicate posting|already targets this url/i],
  ["closed", /posting closed|job has closed|no apply path/i],
  ["login_wall", /untrusted_final_host|login|sign.?in|auth wall|identity wall|auth_required/i],
  ["captcha", /captcha/i],
  [
    "config_stale",
    /no default resume|default resume|no verified resume material|file missing/i,
  ],
  // verify_mismatch before upload_failed: the submit gate's generic
  // "field verification or upload did not pass" is a verify refusal;
  // upload_failed keeps the specific no-file-input evidence strings.
  [
    "verify_mismatch",
    /verification failed|field verification|verify.*not pass|did not pass/i,
  ],
  ["upload_failed", /no file input|file chooser|upload_failed|upload failed/i],
  ["cdp", /cdp|connectovercdp|debug chrome|browser.*unreachable/i],
  [
    "budget",
    /budget|deadline|wallclock|attempt cap|retry cap|agent_unavailable|navigation unresolved/i,
  ],
];

export function classifyReason(reason: string | null | undefined): ReasonClass {
  const text = (reason ?? "").trim();
  if (text.length === 0) return "unknown";
  for (const [cls, pattern] of REASON_BUCKETS) {
    if (pattern.test(text)) return cls;
  }
  return "unknown";
}

/** Registrable-ish host from a URL; null when unparseable. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type SignatureInput = {
  endState: string;
  wall?: string | null;
  stopReason?: string | null;
  host?: string | null;
};

export function buildFailureSignature(input: SignatureInput): string {
  const reasonClass = classifyReason(input.stopReason);
  return [
    input.endState,
    input.wall && input.wall.length > 0 ? input.wall : "-",
    reasonClass,
    input.host && input.host.length > 0 ? input.host : "-",
  ].join("|");
}

/**
 * Wall-class signatures are host-scoped for forbidden-action lookups: a
 * login wall on jobs.example.com teaches the whole host, not just one
 * application (the hostPolicy.ts philosophy).
 */
export function isHostScopedSignature(signature: string): boolean {
  const reasonClass = signature.split("|")[2] as ReasonClass | undefined;
  return (
    reasonClass === "login_wall" ||
    reasonClass === "captcha" ||
    reasonClass === "cdp"
  );
}
