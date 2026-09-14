import path from "node:path";
import {
  composeChildEnv,
  GATED_FLAG_KEYS,
  readCeiling,
  type FlagOptIns,
  type GatedFlagKey,
} from "../console/flagCeiling.js";
import type { TenantPaths } from "./paths.js";

/**
 * The environment of a tenant child process (plan v0.5, M15).
 *
 * Starts from the console's flag ceiling (`composeChildEnv`): a child can
 * never hold a gated flag the operator's own `.env` lacks. On top of that,
 * a tenant child is narrowed further and repointed at its workspace:
 *
 *   forced OFF   things that only make sense for the operator's own box —
 *                artifact autopush (would commit a stranger's artifacts),
 *                the agent leg + CDP autolaunch + JobRight-extension fill
 *                (they attach to the operator's debug Chrome), Outlook,
 *                triage acting, board discovery, Gmail drafting and
 *                verification (today's transports drive the OPERATOR's
 *                mailbox over CDP; a tenant's own Gmail arrives with the
 *                drafts-only API transport, plan M19).
 *   stripped     the operator's standing secrets and the tenancy switches
 *                themselves (a child never spawns children).
 *   repointed    PRIVATE_DIR / DATABASE_PATH / ARTIFACTS_DIR /
 *                DEFAULT_RESUME_PATH at the workspace; the candidate crypto
 *                seam at the tenant key; SUPABASE_SYNC_USER_ID at the
 *                tenant (sync itself stays off in the child — the parent
 *                syncs after the run); PORTAL_LOGIN_EMAIL at the tenant.
 *   armed        unattended submits bounded by the quota budget the
 *                parent computed (auto:cycle's arm row is the authority;
 *                the env cap mirrors it).
 */

export const TENANT_FORCED_OFF: readonly GatedFlagKey[] = [
  "ARTIFACT_AUTOPUSH_ENABLED",
  "AGENT_FALLBACK_ENABLED",
  "CDP_AUTOLAUNCH_ENABLED",
  "JOBRIGHT_AUTOFILL_ENABLED",
  "OUTLOOK_DRAFTS_ENABLED",
  "OUTLOOK_VERIFICATION_ENABLED",
  "TRIAGE_ACT_ENABLED",
  "ATS_DISCOVERY_ENABLED",
  "LINKEDIN_ENRICHMENT_ENABLED",
  "AGENT_AUTHORING_ENABLED",
  // Until M19 (per-user Gmail over the drafts-only API): the web transports
  // would open the OPERATOR's mailbox for a stranger's application.
  "GMAIL_DRAFTS_ENABLED",
  "EMAIL_GENERATION_ENABLED",
  "GMAIL_VERIFICATION_ENABLED",
];

/** Keys a tenant child must never see. */
export const TENANT_STRIPPED_KEYS: readonly string[] = [
  "PORTAL_LOGIN_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SYNC_USER_ID",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "TENANT_ENGINE_ENABLED",
  "REMOTE_BROWSER_ENABLED",
  "TENANT_MAX_CONCURRENT",
  "ALLOW_INSECURE_CANDIDATE_KEY",
  "CANDIDATE_DATA_KEY",
  "CONSOLE_HOSTED_MODE_ENABLED",
  // Session mode overrides: a tenant always runs headless STORAGE_STATE.
  "SESSION_MODE_JOBRIGHT",
  "SESSION_MODE_LINKEDIN",
  "SESSION_MODE_OUTLOOK",
  "OUTREACH_CDP_URL",
];

/** What an apply run asks the ceiling for (granted only where the operator's .env has it). */
export const TENANT_APPLY_OPT_INS: readonly GatedFlagKey[] = [
  "AUTOMATION_ENABLED",
  "FORM_FILL_ENABLED",
  "SUBMIT_ENABLED",
  "NAVIGATION_ENABLED",
  "MATERIALS_DOWNLOAD_ENABLED",
  "NATIVE_AUTOFILL_ENABLED",
  "SCREENER_LLM_MATCH_ENABLED",
  "SCREENER_PREDICT_LLM_ENABLED",
  "ESSAY_DRAFT_ENABLED",
  "ESSAY_AUTOFILL_ENABLED",
  "ESSAY_REQUIRED_GATE_ENABLED",
  "TRIAGE_LLM_ENABLED",
  "NAV_LLM_ASSIST_ENABLED",
];

export type TenantChildEnvInput = {
  paths: TenantPaths;
  /** The tenant's account email (PORTAL_LOGIN_EMAIL for ATS accounts). */
  email: string;
  /** Submissions the run may make — the quota budget. 0 is legal (a dry sweep). */
  maxSubmits: number;
  kind: "apply" | "outreach";
  /** Where the tenant master lives (child derives its key from it). */
  tenantsRoot: string;
  /** The parent's env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
};

export function composeTenantChildEnv(input: TenantChildEnvInput): NodeJS.ProcessEnv {
  const parent = input.env ?? process.env;
  const ceiling = readCeiling(parent);
  const optIns: FlagOptIns = {
    flags: Object.fromEntries(TENANT_APPLY_OPT_INS.map((k) => [k, true])),
    live_mode: true,
  };
  const child = composeChildEnv(parent, ceiling, optIns, {
    unattended: { maxSubmits: Math.max(0, Math.floor(input.maxSubmits)) },
  });

  for (const key of TENANT_FORCED_OFF) child[key] = "false";
  for (const key of TENANT_STRIPPED_KEYS) delete child[key];

  // Belt and braces: every gated key is present and explicit on the child.
  for (const key of GATED_FLAG_KEYS) {
    if (child[key] !== "true") child[key] = "false";
  }

  const p = input.paths;
  child["PRIVATE_DIR"] = p.privateDir;
  child["DATABASE_PATH"] = p.dbPath;
  child["ARTIFACTS_DIR"] = p.artifactsDir;
  child["DEFAULT_RESUME_PATH"] = path.join(p.candidateDir, "resumes", "default.pdf");
  child["CANDIDATE_KEY_PROVIDER"] = "tenant";
  child["TENANT_USER_ID"] = p.userId;
  child["TENANTS_ROOT"] = input.tenantsRoot;
  child["SUPABASE_SYNC_ENABLED"] = "false";
  child["SUPABASE_SYNC_USER_ID"] = p.userId;
  child["PORTAL_LOGIN_EMAIL"] = input.email;
  return child;
}

/**
 * The invariant the tests pin: the child's gated flags are a subset of the
 * parent's. Returns the offending keys (empty when the ceiling holds).
 */
export function flagsAboveCeiling(parent: NodeJS.ProcessEnv, child: NodeJS.ProcessEnv): string[] {
  const ceiling = readCeiling(parent);
  return GATED_FLAG_KEYS.filter((k) => child[k] === "true" && !ceiling.flags[k]);
}
