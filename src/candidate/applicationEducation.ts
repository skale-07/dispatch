import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import type { PublicProfile } from "./publicProfile.js";
import type { ScreenerAnswerBank } from "./screeners.js";

const policySchema = z.object({
  version: z.literal(1),
  graduation_year: z.number().int(),
  graduation_month: z.string().min(1),
  academic_standing: z.string().min(1),
  statement: z.string().min(1),
  resumes: z.object({ general: z.string().min(1), ds_ai: z.string().min(1) }),
  /**
   * #228: resumes for the BASELINE graduation year (no early-graduation
   * requirement in the posting). Same role split as `resumes`. Optional —
   * without it the ds_ai side falls back to a sibling of
   * DEFAULT_RESUME_PATH, and the general side to DEFAULT_RESUME_PATH.
   */
  baseline_resumes: z
    .object({ general: z.string().min(1), ds_ai: z.string().min(1) })
    .optional(),
});
export type ApplicationEducationPolicy = z.infer<typeof policySchema>;
export type EducationSelection = ApplicationEducationPolicy & { evidence: string; resume_path: string; variant: "general" | "ds_ai" };

export function loadApplicationEducationPolicy(): ApplicationEducationPolicy | null {
  const file = path.join(getConfig().privateDir, "candidate", "application-education-policy.json");
  return fs.existsSync(file) ? policySchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : null;
}

/** A posting year alone is not a graduation requirement; a range including the baseline year needs no override. */
export function selectEducationPolicy(policy: ApplicationEducationPolicy | null, input: { role: string; description: string; baselineYear?: number }): EducationSelection | null {
  if (!policy) return null;
  const text = `${input.role}\n${input.description}`.replace(/<[^>]*>/g, " ");
  const clauses = text.split(/[.!?\n;]+/).map(s => s.trim()).filter(Boolean);
  const evidence = clauses.find(clause => {
    if (!/\b(graduat(?:e|es|ing|ion)|class of)\b/i.test(clause)) return false;
    const years: string[] = clause.match(/\b20\d{2}\b/g) ?? [];
    if (!years.includes(String(policy.graduation_year)) || years.includes(String(input.baselineYear ?? 2029))) return false;
    if (/\b(prefer(?:red|ably)?|optional)\b/i.test(clause) && !/\b(must|required|requirement)\b/i.test(clause)) return false;
    return /\b(must|required|requirements?|expected|anticipated|graduat(?:e|ing)\s+(?:in|by|between)|graduation\s+(?:date|year)|class of)\b/i.test(clause);
  });
  if (!evidence) return null;
  const variant = resumeVariantForRole(input.role);
  return { ...policy, evidence: evidence.slice(0, 600), variant, resume_path: path.resolve(policy.resumes[variant]) };
}

/**
 * Which resume family a role wants (#228). Single definition — the
 * early-graduation selection and the baseline default both read it, so a
 * data-science posting can never get the SWE resume through one path and
 * the DS resume through the other.
 */
export function resumeVariantForRole(role: string): "general" | "ds_ai" {
  return /\b(data\s+(?:scien(?:ce|tist|tists)|analytics|analyst|engineer(?:ing)?)|machine\s+learning|artificial\s+intelligence|deep\s+learning|applied\s+scien(?:ce|tist)|research\s+scien(?:ce|tist)|AI|ML|MLE|NLP|computer\s+vision|LLM|GenAI)\b/i.test(
    role,
  )
    ? "ds_ai"
    : "general";
}

/**
 * Resume for a role at the BASELINE graduation year (#228). The early-
 * graduation policy already picks a 2028 variant by role; without it the
 * pipeline used one configured default for everything, so a DS/ML/AI
 * posting was sent the SWE resume. Returns null when nothing better than
 * the configured default exists, leaving the caller's fallback intact.
 */
export function baselineResumeForRole(
  role: string,
  policy: ApplicationEducationPolicy | null = loadApplicationEducationPolicy(),
): string | null {
  const variant = resumeVariantForRole(role);
  const configured = policy?.baseline_resumes?.[variant];
  if (configured) {
    const resolved = path.resolve(configured);
    return fs.existsSync(resolved) ? resolved : null;
  }
  if (variant === "general") return null;
  // No baseline map: look for the ds_ai resume beside the configured
  // default (the operator keeps them in one folder).
  const sibling = path.join(path.dirname(getConfig().defaultResumePath), "ds_ai.pdf");
  return fs.existsSync(sibling) ? sibling : null;
}

/** Resume path for an application: early-graduation pick, else role default (#228). */
export function resumeForApplication(
  db: Db,
  applicationId: string,
): { path: string; label: string } | null {
  const job = db
    .prepare(
      `SELECT j.role, j.description_text FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { role: string; description_text: string | null } | undefined;
  if (!job) return null;
  const policy = loadApplicationEducationPolicy();
  const selection = selectEducationPolicy(policy, {
    role: job.role,
    description: job.description_text ?? "",
  });
  if (selection) {
    return {
      path: selection.resume_path,
      label: `approved early graduation ${selection.graduation_year}: ${selection.variant}`,
    };
  }
  const baseline = baselineResumeForRole(job.role, policy);
  return baseline
    ? { path: baseline, label: `role default: ${resumeVariantForRole(job.role)}` }
    : null;
}

export function educationForApplication(db: Db, applicationId: string): EducationSelection | null {
  const job = db.prepare(`SELECT j.role, j.description_text FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`).get(applicationId) as { role: string; description_text: string | null } | undefined;
  return job ? selectEducationPolicy(loadApplicationEducationPolicy(), { role: job.role, description: job.description_text ?? "" }) : null;
}

export function educationProfile(profile: PublicProfile, selection: EducationSelection | null): PublicProfile {
  return selection ? { ...profile, graduation_year: selection.graduation_year, graduation_month: selection.graduation_month } : profile;
}

export function educationAnswer(label: string, selection: EducationSelection): string | null {
  if (/\b(academic standing|class standing|year (?:of|in) (?:study|college|school)|current (?:academic|class) year)\b/i.test(label)) return selection.academic_standing;
  if (/\bgraduation year\b/i.test(label)) return String(selection.graduation_year);
  if (/\bgraduation month\b/i.test(label)) return selection.graduation_month;
  if (/\b(graduation date|when (?:do you|will you|are you expected to) graduate|date.*complete.*degree)\b/i.test(label)) return `${selection.graduation_month} ${selection.graduation_year}`;
  return null;
}

/** Per-application copy: never teach conditional education facts to the global bank. */
export function educationBank(bank: ScreenerAnswerBank | null, selection: EducationSelection | null): ScreenerAnswerBank | null {
  if (!selection || !bank) return bank;
  const copy = structuredClone(bank);
  for (const entry of Object.values(copy.custom)) {
    const answer = entry.labels.map(label => educationAnswer(label, selection)).find(a => a !== null);
    if (answer) entry.answer = answer;
  }
  copy.custom["approved_academic_standing"] = { answer: selection.academic_standing, labels: ["Academic standing", "Current academic year", "What year of study are you in?", "What is your class standing?"], promoted_at: "operator-approved application policy" };
  return copy;
}

export function educationInstruction(selection: EducationSelection | null): string | undefined {
  return selection ? `Operator-approved facts for THIS application take precedence over general profile/about-me/learned answers: ${selection.statement} Graduation: ${selection.graduation_month} ${selection.graduation_year}. Current academic standing: ${selection.academic_standing}. Do not describe the candidate as a junior or senior merely because graduation is earlier. Requirement evidence: ${selection.evidence}` : undefined;
}
