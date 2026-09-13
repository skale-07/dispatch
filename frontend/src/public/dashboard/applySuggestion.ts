import { SCREENER_QUESTIONS, type ProfileRow } from "../contract.js";
import { humanize, type SuggestionTarget } from "../fieldSuggestions.js";

/**
 * What a suggestion card DOES when answered (plan M11). Pure: the card
 * decides between an inline mini-form and a deep link, and the answer is
 * dispatched to the right store through injected savers, so the routing
 * is unit-tested without Supabase.
 *
 * Inline answers exist only for stores whose write is a single value the
 * user can see whole: a plain profile text column, or a screener answer.
 * Anything with structure or consequence — work authorization and the
 * other tri-states, education, employment, documents, integrations, and
 * self-identification — goes to its own onboarding step, where the full
 * question and its rules are on screen. Self-ID is NEVER answered inline
 * (opt-in, encrypted, its own consent).
 */

export type SuggestionAction =
  | { mode: "inline"; kind: "text" | "number" | "boolean"; suggestions?: string[] }
  | { mode: "navigate"; to: string; label: string }
  | { mode: "unsupported"; reason: string };

/** Profile columns a card may write directly: one text value, no rules. */
export const INLINE_PROFILE_COLUMNS = [
  "legal_first_name",
  "legal_middle_name",
  "legal_last_name",
  "preferred_name",
  "contact_email",
  "phone",
  "address_line1",
  "address_line2",
  "location_city",
  "location_region",
  "postal_code",
  "location_country",
  "linkedin_url",
  "github_url",
  "portfolio_url",
  "how_heard",
] as const;
export type InlineProfileColumn = (typeof INLINE_PROFILE_COLUMNS)[number];

const STEP_FOR_PROFILE: Record<string, string> = {
  work_authorization: "eligibility",
  needs_sponsorship: "eligibility",
  restrictive_covenants: "eligibility",
  open_to_relocation: "eligibility",
  job_preferences: "preferences",
  about_me: "about",
  current_company: "experience",
  skills: "experience",
  employment_history: "experience",
  education: "education",
};

const REGISTRY = new Map(SCREENER_QUESTIONS.map((q) => [q.key, q] as const));

export function suggestionAction(target: SuggestionTarget): SuggestionAction {
  const key = target.key ?? "";
  switch (target.store) {
    case "profile": {
      if ((INLINE_PROFILE_COLUMNS as readonly string[]).includes(key)) {
        return { mode: "inline", kind: "text" };
      }
      const step = STEP_FOR_PROFILE[key.split(".")[0] ?? key];
      return step
        ? { mode: "navigate", to: `/onboarding/${step}`, label: `answer on the ${step} step` }
        : { mode: "unsupported", reason: `no step asks for ${key}` };
    }
    case "screener": {
      const q = REGISTRY.get(key);
      if (q) {
        if (q.kind === "yes_no") return { mode: "inline", kind: "boolean" };
        return { mode: "inline", kind: "text", ...(q.suggestions ? { suggestions: q.suggestions } : {}) };
      }
      // A custom question (label:<fp> signal) is a verbatim text answer.
      return { mode: "inline", kind: target.kind === "boolean" ? "boolean" : target.kind === "number" ? "number" : "text" };
    }
    case "education":
      return { mode: "navigate", to: "/onboarding/education", label: "edit your education" };
    case "employment":
      return { mode: "navigate", to: "/onboarding/experience", label: "edit your experience" };
    case "documents":
      return {
        mode: "navigate",
        to: "/onboarding/documents",
        label: key === "transcript" ? "upload a transcript" : target.variant ? `add a ${target.variant} resume` : "manage documents",
      };
    case "integrations":
      return { mode: "navigate", to: "/onboarding/integrations", label: key === "gmail" ? "connect Gmail" : "connect JobRight" };
    case "self_id":
      return { mode: "navigate", to: "/onboarding/self-id", label: "decide on self-identification" };
  }
}

/** The title a card shows: the registry prompt when it is one, else the label/key. */
export function suggestionTitle(target: SuggestionTarget): string | undefined {
  if (target.store === "screener" && target.key) {
    const q = REGISTRY.get(target.key);
    if (q) return q.prompt;
    if (target.labels?.[0]) return target.labels[0];
  }
  return undefined;
}

export type SuggestionSavers = {
  saveProfile: (patch: Partial<Omit<ProfileRow, "user_id" | "created_at" | "updated_at">>) => Promise<void>;
  saveScreener: (
    rows: Array<{ key: string; kind: "registry" | "custom"; answer: string; labels?: string[]; source?: "wizard" | "suggestion" | "engine_promote" }>,
  ) => Promise<void>;
};

/**
 * Write one inline answer. Blank text is a refusal to answer, not a write:
 * it returns false and touches nothing (a suggestion never clears data).
 */
export async function applySuggestionAnswer(
  target: SuggestionTarget,
  value: string,
  savers: SuggestionSavers,
): Promise<boolean> {
  const v = value.trim();
  if (!v) return false;
  const action = suggestionAction(target);
  if (action.mode !== "inline") throw new Error(`${target.store}:${target.key ?? ""} is not answered inline`);
  const key = target.key ?? "";
  if (target.store === "profile") {
    const patch: Record<string, string> = { [key]: key === "contact_email" ? v.toLowerCase() : v };
    await savers.saveProfile(patch as Partial<ProfileRow>);
    return true;
  }
  if (REGISTRY.has(key)) {
    await savers.saveScreener([{ key, kind: "registry", answer: v, source: "suggestion" }]);
    return true;
  }
  const labels = target.labels && target.labels.length > 0 ? target.labels : [humanize(key)];
  await savers.saveScreener([{ key, kind: "custom", answer: v, labels, source: "suggestion" }]);
  return true;
}
