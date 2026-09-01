import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { DOTENV_PATH } from "../config/env.js";
import { probeCdpTargetsForExtension } from "../automation/extensionPreflight.js";
import { getServiceAuthConfig } from "../auth/serviceRegistry.js";
import { describeSessionReadiness } from "../auth/serviceSession.js";
import type { ServiceName } from "../auth/types.js";
import { publicProfilePaths } from "../candidate/publicProfileIO.js";
import { parsePublicProfile } from "../candidate/publicProfile.js";
import { loadAnswerAliases } from "../candidate/answerAliases.js";
import { screenerBankPaths, tryLoadScreenerBank } from "../candidate/screenersIO.js";
import { sensitiveProfileStatus } from "../candidate/sensitiveProfileIO.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { listMigrationFiles, type Db } from "../storage/db/client.js";

/**
 * Onboarding readiness for the console's /welcome flow. Every check here is
 * READ-ONLY — the onboarding surface never writes credentials or profiles;
 * it tells the operator which documented CLI command to run and then
 * verifies the result on disk with the same code the pipeline uses.
 *
 * Fail-closed honesty: a check that cannot run (probe threw, file
 * unreadable) reports "unknown", never "ok". Readiness requires every
 * REQUIRED check to be literally "ok" — unknowns do not count.
 */

export type OnboardingCheckStatus = "ok" | "todo" | "unknown";

export type OnboardingStepId = "prerequisites" | "profile" | "sessions";

export type OnboardingCheck = {
  id: string;
  step: OnboardingStepId;
  label: string;
  status: OnboardingCheckStatus;
  /** Required for "ready"; optional checks inform but never block. */
  required: boolean;
  detail: string;
  /** The documented CLI command (or doc pointer) that fixes a "todo". */
  fix: string | null;
};

export type OnboardingStepSummary = {
  id: OnboardingStepId;
  status: OnboardingCheckStatus;
  checks: OnboardingCheck[];
};

export type OnboardingSummary = {
  ready: boolean;
  steps: OnboardingStepSummary[];
  generated_at: string;
};

const STEP_ORDER: OnboardingStepId[] = ["prerequisites", "profile", "sessions"];

/**
 * Pure aggregation: per-step status and the overall ready bit.
 * A step is "todo" if any required check is todo, else "unknown" if any
 * required check is unknown, else "ok". Ready means every required check
 * across all steps is "ok" — "unknown" never promotes.
 */
export function summarizeOnboarding(checks: OnboardingCheck[]): OnboardingSummary {
  const steps = STEP_ORDER.map((id) => {
    const own = checks.filter((c) => c.step === id);
    const required = own.filter((c) => c.required);
    const status: OnboardingCheckStatus = required.some((c) => c.status === "todo")
      ? "todo"
      : required.some((c) => c.status === "unknown")
        ? "unknown"
        : "ok";
    return { id, status, checks: own };
  });
  const ready = checks
    .filter((c) => c.required)
    .every((c) => c.status === "ok");
  return { ready, steps, generated_at: new Date().toISOString() };
}

export type OnboardingSeams = {
  /** Test seam: replaces the bounded CDP /json probe. */
  probeCdp?: (cdpUrl: string) => Promise<{ cdp_reachable: boolean }>;
  /** Test seam: where the operator `.env` is expected. */
  envFilePath?: string;
};

type CheckInput = {
  id: string;
  step: OnboardingStepId;
  label: string;
  required: boolean;
  fix: string | null;
  run: () => { status: OnboardingCheckStatus; detail: string };
};

/** Run one check; anything thrown becomes "unknown" with the real error. */
function runCheck(input: CheckInput): OnboardingCheck {
  const { run, ...meta } = input;
  try {
    const { status, detail } = run();
    return { ...meta, status, detail };
  } catch (err) {
    return {
      ...meta,
      status: "unknown",
      detail: `check could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Collect every onboarding check. Read-only; never opens a browser. */
export async function collectOnboardingChecks(
  db: Db,
  seams: OnboardingSeams = {},
): Promise<OnboardingCheck[]> {
  const cfg = getConfig();
  const checks: OnboardingCheck[] = [];

  // --- prerequisites -------------------------------------------------
  const envPath = seams.envFilePath ?? DOTENV_PATH;
  checks.push(
    runCheck({
      id: "env_file",
      step: "prerequisites",
      label: "Operator .env exists",
      required: true,
      fix: "copy .env.example .env  (every flag stays fail-closed until you flip it there)",
      run: () =>
        fs.existsSync(envPath)
          ? { status: "ok", detail: `.env present at ${envPath}` }
          : { status: "todo", detail: `no .env at ${envPath}` },
    }),
  );

  checks.push(
    runCheck({
      id: "database_migrated",
      step: "prerequisites",
      label: "Database migrated",
      required: true,
      fix: "npm run migrate",
      run: () => {
        const files = listMigrationFiles();
        let applied: Set<string>;
        try {
          applied = new Set(
            (db.prepare("SELECT version FROM schema_migrations").all() as Array<{
              version: string;
            }>).map((r) => r.version),
          );
        } catch {
          // No schema_migrations table = never migrated. The query failing
          // is itself the answer here, not an inability to check.
          return { status: "todo", detail: "schema_migrations table missing" };
        }
        const pending = files.filter((f) => !applied.has(f));
        return pending.length === 0
          ? { status: "ok", detail: `${applied.size} migration(s) applied, none pending` }
          : { status: "todo", detail: `pending migrations: ${pending.join(", ")}` };
      },
    }),
  );

  // Async check runs outside runCheck's sync body; same unknown-on-throw rule.
  let cdpCheck: OnboardingCheck;
  try {
    const probe = await (seams.probeCdp ??
      ((url: string) => probeCdpTargetsForExtension(url)))(cfg.agentCdpUrl);
    cdpCheck = {
      id: "debug_chrome",
      step: "prerequisites",
      label: "Debug Chrome reachable (CDP)",
      required: false,
      fix: "npm run chrome:debug:jobright",
      status: probe.cdp_reachable ? "ok" : "todo",
      detail: probe.cdp_reachable
        ? `CDP answering at ${cfg.agentCdpUrl}`
        : `nothing answering at ${cfg.agentCdpUrl} — needed for JobRight login and live fills`,
    };
  } catch (err) {
    cdpCheck = {
      id: "debug_chrome",
      step: "prerequisites",
      label: "Debug Chrome reachable (CDP)",
      required: false,
      fix: "npm run chrome:debug:jobright",
      status: "unknown",
      detail: `probe could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  checks.push(cdpCheck);

  // --- candidate profile ---------------------------------------------
  checks.push(
    runCheck({
      id: "public_profile",
      step: "profile",
      label: "Public profile parses",
      required: true,
      fix: "copy private\\candidate\\public-profile.example.json private\\candidate\\public-profile.json, then edit with your real values",
      run: () => {
        const { profilePath } = publicProfilePaths();
        if (!fs.existsSync(profilePath)) {
          return { status: "todo", detail: `no file at ${profilePath}` };
        }
        // Same parser the fill plan uses — a profile that fails here would
        // fail identically at plan time. A parse failure is a definite
        // finding (fix the file), not an inability to check.
        try {
          parsePublicProfile(JSON.parse(fs.readFileSync(profilePath, "utf8")));
        } catch (err) {
          return {
            status: "todo",
            detail: `profile does not parse: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          };
        }
        return { status: "ok", detail: `parses at ${profilePath}` };
      },
    }),
  );

  checks.push(
    runCheck({
      id: "answer_aliases",
      step: "profile",
      label: "Answer aliases",
      required: false,
      fix: "copy private\\candidate\\answer-aliases.example.json private\\candidate\\answer-aliases.json",
      run: () => {
        const aliasPath = path.join(cfg.privateDir, "candidate", "answer-aliases.json");
        if (!fs.existsSync(aliasPath)) {
          return {
            status: "todo",
            detail: "no answer-aliases.json — screener matching loses your custom phrasings",
          };
        }
        const aliases = loadAnswerAliases(aliasPath);
        return {
          status: "ok",
          detail: `${Object.keys(aliases).length} alias key(s) parse`,
        };
      },
    }),
  );

  checks.push(
    runCheck({
      id: "screener_bank",
      step: "profile",
      label: "Screener answer bank",
      required: false,
      fix: "npm run screeners:init  (then edit private\\candidate\\screeners.json)",
      run: () => {
        const bank = tryLoadScreenerBank();
        if (bank === null) {
          const { bankPath } = screenerBankPaths();
          return {
            status: "todo",
            detail: `no bank at ${bankPath} — screener questions will park for you`,
          };
        }
        return { status: "ok", detail: "screeners.json parses" };
      },
    }),
  );

  checks.push(
    runCheck({
      id: "sensitive_profile",
      step: "profile",
      label: "Sensitive (EEO) profile encrypted",
      required: false,
      fix: "npm run candidate:encrypt-sensitive",
      run: () => {
        const s = sensitiveProfileStatus();
        if (s.encExists) {
          return { status: "ok", detail: "sensitive-profile.enc present" };
        }
        if (s.draftExists) {
          return {
            status: "todo",
            detail: "draft exists but is not encrypted yet — run the encrypt command",
          };
        }
        return {
          status: "todo",
          detail:
            "none on file — optional; demographic fields are simply skipped (never inferred)",
        };
      },
    }),
  );

  // --- sessions ------------------------------------------------------
  const services: Array<{ service: ServiceName; required: boolean; fix: string }> = [
    {
      service: "jobright",
      required: true,
      fix: "npm run chrome:debug:jobright  (sign in with Google there), then npm run login:jobright:cdp",
    },
    { service: "linkedin", required: false, fix: "npm run login:linkedin" },
    { service: "outlook", required: false, fix: "npm run login:outlook" },
  ];
  for (const { service, required, fix } of services) {
    checks.push(
      runCheck({
        id: `${service}_session`,
        step: "sessions",
        label: `${service} session on disk`,
        required,
        fix,
        run: () => {
          const authCfg = getServiceAuthConfig(service);
          const readiness = describeSessionReadiness(service, authCfg.defaultMode);
          return {
            status: readiness.ready ? "ok" : "todo",
            detail: readiness.detail,
          };
        },
      }),
    );
  }

  checks.push(
    runCheck({
      id: "gmail_token",
      step: "sessions",
      label: "Gmail readonly token",
      required: false,
      fix: "npm run gmail:auth -- --email <mailbox> --client-id <id> --client-secret <secret>  (or Settings → Gmail)",
      run: () => {
        const token = readGmailToken();
        return token
          ? { status: "ok", detail: "readonly token stored" }
          : {
              status: "todo",
              detail:
                "no token — verification-code recovery stays off (browser mailbox scan still works when enabled)",
            };
      },
    }),
  );

  return checks;
}
