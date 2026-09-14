import { loadPublicProfile } from "./publicProfileIO.js";
import type { PublicProfile } from "./publicProfile.js";

/**
 * Who the emails are from (plan v0.5, M19 "de-operator-ize"): the name and
 * LinkedIn URL come from the LOADED public profile — the operator's own in
 * the operator's process, the tenant's in a tenant child — never from a
 * literal. Falls back to blanks, never to someone else's identity.
 */
export type CandidateIdentity = {
  fullName: string;
  firstName: string;
  linkedinUrl: string | null;
  email: string | null;
};

export function identityFromProfile(profile: PublicProfile): CandidateIdentity {
  const first = (profile.legal_name?.first ?? "").trim();
  const last = (profile.legal_name?.last ?? "").trim();
  const preferred = (profile.preferred_name ?? "").trim();
  const fullName = [first, last].filter(Boolean).join(" ");
  const linkedin = (profile.linkedin_url ?? "").trim();
  return {
    fullName,
    firstName: preferred || first,
    linkedinUrl: linkedin ? linkedin.replace(/\/$/, "") : null,
    email: (profile.email ?? "").trim() || null,
  };
}

let cached: CandidateIdentity | null = null;

export const BLANK_IDENTITY: CandidateIdentity = { fullName: "", firstName: "", linkedinUrl: null, email: null };

/**
 * The current process's candidate. Cached per process once a profile
 * loads; a tenant child has its own. No profile on disk ⇒ the blank
 * identity (not cached, never a throw) — callers fall back to their own
 * defaults rather than failing a run over a signature check.
 */
export function candidateIdentity(): CandidateIdentity {
  if (cached) return cached;
  try {
    cached = identityFromProfile(loadPublicProfile());
    return cached;
  } catch {
    return BLANK_IDENTITY;
  }
}

/** Tests only. */
export function resetCandidateIdentityCache(): void {
  cached = null;
}
