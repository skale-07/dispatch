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
  const variant = /\b(data\s+(?:scien(?:ce|tist)|analytics)|machine learning|artificial intelligence|deep learning|AI|ML)\b/i.test(input.role) ? "ds_ai" : "general";
  return { ...policy, evidence: evidence.slice(0, 600), variant, resume_path: path.resolve(policy.resumes[variant]) };
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
