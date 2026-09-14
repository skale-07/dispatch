import { z } from "zod";
import { EMPLOYMENT_MAX_ROLES, EMPLOYMENT_SUMMARY_MAX } from "../contract.js";
import type { StepSlug } from "./steps.js";

/**
 * Per-step validation for the onboarding wizard. Two schemas per step:
 *
 * - `lenient` checks SHAPE only (a year is four digits, a link is a
 *   link). It gates autosave, so a half-finished step still saves and
 *   the user can resume later.
 * - `strict` adds what complete_my_onboarding() will demand — a headless
 *   engine has no "ask me" for a legal name or work authorization — and
 *   gates Next.
 *
 * Deliberately no default values and no catch-alls in these schemas: a
 * blank is the user's "not answered yet", and a schema that quietly fills
 * one in is an invented answer (tests/unit/onboarding-steps.test.ts greps
 * for both). Tri-states are "yes" | "no" | "" for the same reason.
 */

const text = (max: number) => z.string().max(max, `keep this under ${max} characters`);
const year = z.string().regex(/^\s*(\d{4})?\s*$/, "a 4-digit year, e.g. 2027");
const link = z
  .string()
  .max(300, "keep this under 300 characters")
  .regex(/^\s*(https?:\/\/\S+)?\s*$/i, "a full link starting with https://");
const emailOrBlank = z
  .string()
  .max(254, "keep this under 254 characters")
  .regex(/^\s*([^\s@]+@[^\s@]+\.[^\s@]+)?\s*$/, "an email address, e.g. you@school.edu");
const gpa = z.string().regex(/^\s*(\d{1,2}(\.\d{1,3})?)?\s*$/, "a number, e.g. 3.7");
const answers = z.record(z.string(), text(2000));

export const TRI_STATE = ["yes", "no", ""] as const;
const triState = z.enum(TRI_STATE);

/** WORK_AUTH_OPTIONS values plus "" (unanswered) — drift-tested. */
export const WORK_AUTH_VALUES = [
  "us_citizen",
  "permanent_resident",
  "visa_holder",
  "needs_sponsorship",
  "other",
  "",
] as const;

export const REMOTE_VALUES = ["remote", "hybrid", "onsite", "any", ""] as const;

function required(
  ctx: z.RefinementCtx,
  value: unknown,
  path: string,
  message: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  }
}

/* ── 1 identity ─────────────────────────────────────────────────────── */

export const identityLenient = z.object({
  full_name: text(200),
  legal_first_name: text(100),
  legal_middle_name: text(100),
  legal_last_name: text(100),
  preferred_name: text(100),
  contact_email: emailOrBlank,
  linkedin_url: link,
  github_url: link,
  portfolio_url: link,
});
export const identityStrict = identityLenient.superRefine((v, ctx) => {
  required(ctx, v.legal_first_name, "legal_first_name", "your legal first name — employer forms ask for it");
  required(ctx, v.legal_last_name, "legal_last_name", "your legal last name");
});

/* ── 2 contact ──────────────────────────────────────────────────────── */

export const contactLenient = z.object({
  phone: text(40),
  address_line1: text(200),
  address_line2: text(200),
  location_city: text(100),
  location_region: text(100),
  postal_code: text(20),
  location_country: text(100),
});
export const contactStrict = contactLenient.superRefine((v, ctx) => {
  required(ctx, v.phone, "phone", "a phone number — most forms require one");
  required(ctx, v.location_city, "location_city", "your city");
  required(ctx, v.location_country, "location_country", "your country");
});

/* ── 3 education ────────────────────────────────────────────────────── */

const educationEntry = z.object({
  school: text(200),
  degree: text(120),
  field: text(120),
  grad_year: year,
  grad_month: text(40),
  start_year: year,
  start_month: text(40),
  gpa,
  additional_fields: text(300),
});

export const educationLenient = z.object({
  school: text(200),
  degree: text(120),
  field: text(120),
  start_month: text(40),
  start_year: year,
  grad_month: text(40),
  grad_year: year,
  gpa,
  additional_fields: text(300),
  more_education: z.array(educationEntry).max(5, "five other schools at most"),
});
export const educationStrict = educationLenient.superRefine((v, ctx) => {
  required(ctx, v.school, "school", "your school — nearly every form asks");
});

/* ── 4 experience ───────────────────────────────────────────────────── */

const employmentEntry = z.object({
  company: text(200),
  title: text(200),
  location: text(120),
  start_month: text(40),
  start_year: year,
  end_month: text(40),
  end_year: year,
  current: z.boolean(),
  remote: z.boolean(),
  summary: text(EMPLOYMENT_SUMMARY_MAX),
});

export const experienceLenient = z.object({
  current_company: text(200),
  skills: text(2000),
  employment_history: z
    .array(employmentEntry)
    .max(EMPLOYMENT_MAX_ROLES, `${EMPLOYMENT_MAX_ROLES} roles at most`),
});
/** Nothing on this step is required: a first-year student may have no jobs yet. */
export const experienceStrict = experienceLenient;

/* ── 6 eligibility ──────────────────────────────────────────────────── */

export const eligibilityLenient = z.object({
  work_authorization: z.enum(WORK_AUTH_VALUES),
  needs_sponsorship: triState,
  open_to_relocation: triState,
  restrictive_covenants: triState,
  screeners: answers,
});
export const eligibilityStrict = eligibilityLenient.superRefine((v, ctx) => {
  required(
    ctx,
    v.work_authorization,
    "work_authorization",
    "pick one — forms get exactly this, and Dispatch never guesses it",
  );
  required(
    ctx,
    v.needs_sponsorship,
    "needs_sponsorship",
    "pick yes or no — a form that asks cannot be submitted without it",
  );
});

/* ── 7 compensation & how-heard ─────────────────────────────────────── */

export const compensationLenient = z.object({
  how_heard: text(200),
  how_heard_fallbacks: text(500),
  screeners: answers,
});
export const compensationStrict = compensationLenient;

/* ── 8 about ────────────────────────────────────────────────────────── */

export const ABOUT_MIN = 80;
export const ABOUT_MAX = 8000;

export const aboutLenient = z.object({ about_me: text(ABOUT_MAX) });
export const aboutStrict = aboutLenient.superRefine((v, ctx) => {
  if (v.about_me.trim().length < ABOUT_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["about_me"],
      message: `at least ${ABOUT_MIN} characters — open-ended questions are answered from this`,
    });
  }
});

/* ── 12 preferences ─────────────────────────────────────────────────── */

export const preferencesLenient = z.object({
  titles: text(500),
  locations: text(500),
  remote: z.enum(REMOTE_VALUES),
  employment_types: z.array(z.string()),
  min_salary_usd: z.string().regex(/^\s*\$?[\d,]*\s*$/, "a number, e.g. 70000"),
});
export const preferencesStrict = preferencesLenient.superRefine((v, ctx) => {
  required(ctx, v.titles, "titles", "at least one role — discovery searches for these");
});

export type StepSchemas = { lenient: z.AnyZodObject; strict: z.ZodTypeAny };

/** Every step that has a form, keyed by slug (drift-tested against steps.ts). */
export const STEP_SCHEMAS: Partial<Record<StepSlug, StepSchemas>> = {
  identity: { lenient: identityLenient, strict: identityStrict },
  contact: { lenient: contactLenient, strict: contactStrict },
  education: { lenient: educationLenient, strict: educationStrict },
  experience: { lenient: experienceLenient, strict: experienceStrict },
  eligibility: { lenient: eligibilityLenient, strict: eligibilityStrict },
  compensation: { lenient: compensationLenient, strict: compensationStrict },
  about: { lenient: aboutLenient, strict: aboutStrict },
  preferences: { lenient: preferencesLenient, strict: preferencesStrict },
};
