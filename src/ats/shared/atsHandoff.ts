import { detectAtsFromUrl } from "./urlValidationDispatch.js";

/**
 * Apply on a company careers site (Phenom / Jibe / custom) usually lands on
 * the employer's REAL ATS — live 2026-08-30 (night19 #52): Leidos'
 * careers.leidos.com "APPLY NOW" landed on
 * leidos.wd5.myworkdayjobs.com/External/job/…/apply, and the generic
 * adapter kept reading that Workday page as "a posting with an Apply CTA"
 * and refused FORM_NOT_REACHED. The landed page belongs to a different
 * adapter; the right move is to hand the application to it, not to keep
 * classifying with the wrong one.
 *
 * Pure: returns the handoff target when the landed URL is a recognised,
 * NON-generic ATS that differs from the current binding; null otherwise
 * (same ATS, generic host, or unparseable URL) — so a same-vendor hop
 * (greenhouse posting → greenhouse embed) is never a "handoff".
 */
export function detectAtsHandoff(
  currentAts: string,
  landedUrl: string,
): { ats: string; url: string } | null {
  const detected = detectAtsFromUrl(landedUrl);
  if (detected.ats === null || detected.ats === "generic") return null;
  if (detected.ats === currentAts) return null;
  return { ats: detected.ats, url: detected.normalizedUrl || landedUrl };
}
