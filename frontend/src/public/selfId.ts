import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  EMPTY_SENSITIVE,
  SENSITIVE_FIELDS,
  type SensitiveDraft,
  type SensitiveField,
  type SensitivePlain,
} from "./contract";

/**
 * ── Self-identification (EEO), opt-in and encrypted ──────────────────
 *
 * Decision 2026-09-11 (reverses 2026-09-01): a hosted user who WANTS
 * their self-identification answers placed on forms keeps them here —
 * encrypted at rest (migration 20260911000500), reachable only through
 * three RPCs, never on the profile row, never on ProfileDraft (the
 * coverage gate asserts that), never aggregated.
 *
 * Per field the user chooses:
 *   - "answer"     a verbatim value the engine places on the form
 *   - "prefer_not" an ANSWER: the engine picks the form's own
 *                  "decline to self-identify" option
 *   - "skip"       blank; the question becomes a per-application to-do
 * Default is "skip" everywhere and consent is off; the server refuses a
 * save without consent. Nothing here ever infers a value.
 */

function client() {
  if (!supabase) {
    throw new Error("account service not configured in this build — nothing was saved");
  }
  return supabase;
}

/** RPC plaintext → wizard draft (unknown keys are ignored). */
export function plainToDraft(plain: SensitivePlain | null): SensitiveDraft {
  if (!plain) return EMPTY_SENSITIVE;
  const draft: SensitiveDraft = {
    ...EMPTY_SENSITIVE,
    consent: plain.consent === true,
    fields: { ...EMPTY_SENSITIVE.fields },
  };
  for (const f of SENSITIVE_FIELDS) {
    const entry = plain.fields?.[f.key];
    if (!entry) continue;
    if (entry.choice === "answer") {
      draft.fields[f.key] = {
        choice: "answer",
        value: f.multi
          ? Array.isArray(entry.value)
            ? entry.value.map(String)
            : []
          : typeof entry.value === "string"
            ? entry.value
            : "",
      };
    } else if (entry.choice === "prefer_not") {
      draft.fields[f.key] = { choice: "prefer_not", value: f.multi ? [] : "" };
    }
  }
  return draft;
}

/** Wizard draft → RPC plaintext. Blank answers are demoted to "skip", never sent empty. */
export function draftToPlain(draft: SensitiveDraft): SensitivePlain {
  const fields: SensitivePlain["fields"] = {};
  for (const f of SENSITIVE_FIELDS) {
    const entry = draft.fields[f.key];
    if (entry.choice === "answer") {
      const value = f.multi
        ? (entry.value as string[]).map((v) => v.trim()).filter(Boolean)
        : (entry.value as string).trim();
      const empty = Array.isArray(value) ? value.length === 0 : value === "";
      fields[f.key] = empty ? { choice: "skip", value: null } : { choice: "answer", value };
    } else if (entry.choice === "prefer_not") {
      fields[f.key] = { choice: "prefer_not", value: null };
    } else {
      fields[f.key] = { choice: "skip", value: null };
    }
  }
  return { consent: draft.consent, fields };
}

export async function getMySelfId(): Promise<SensitiveDraft> {
  const { data, error } = await client().rpc(CONTRACT.getSensitiveRpc);
  if (error) throw new Error(error.message);
  return plainToDraft((data as SensitivePlain | null) ?? null);
}

/** Refused server-side without consent; that error is shown verbatim. */
export async function saveMySelfId(draft: SensitiveDraft): Promise<{ answeredKeys: SensitiveField[] }> {
  const { data, error } = await client().rpc(CONTRACT.saveSensitiveRpc, {
    p_profile: draftToPlain(draft),
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { answered_keys?: string[] } | null;
  return { answeredKeys: (row?.answered_keys ?? []) as SensitiveField[] };
}

export async function clearMySelfId(): Promise<void> {
  const { error } = await client().rpc(CONTRACT.clearSensitiveRpc);
  if (error) throw new Error(error.message);
}
