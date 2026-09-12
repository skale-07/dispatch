import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Reveal, RevealItem } from "../../components/Animated";
import { Icon } from "../../components/Icon";
import { Display } from "../../components/public/Display";
import { Eyebrow } from "../../components/public/Eyebrow";
import { PanelState } from "../../components/public/PanelState";
import { EMPTY_PROFILE, REDEEM_ERRORS, type ProfileDraft } from "../contract";
import {
  getMyProfile,
  getMyScreenerAnswers,
  redeemPendingInvite,
  saveOnboardingProgress,
  type InviteRedemption,
} from "../data";
import { rowToDraft } from "../profileMapping";
import { usePageTitle } from "../usePageTitle";
import { DocumentsStep } from "./DocumentsStep";
import { IntegrationsStep } from "./IntegrationsStep";
import { PersonaStep } from "./PersonaStep";
import { SelfIdStep } from "./SelfIdStep";
import {
  AboutStep,
  CompensationStep,
  ContactStep,
  EducationStep,
  EligibilityStep,
  ExperienceStep,
  IdentityStep,
  PreferencesStep,
} from "./ProfileSteps";
import { ReviewStep } from "./ReviewStep";
import type { StepProps } from "./StepChrome";
import {
  ONBOARDING_STEPS,
  neighbours,
  resumeSlug,
  stepBySlug,
  stepNumber,
  type StepSlug,
} from "./steps";

/**
 * The onboarding wizard shell: /onboarding/:step. One route per step,
 * one <Reveal> per route. The shell loads the profile row and the
 * screener bank once, hands each step the current draft, and folds each
 * step's saved answers back in so Review always shows what is on file.
 *
 * Product rules carried into the UI:
 * - Every step saves as the user goes (per-step autosave + Next). No
 *   step, and no import, ever stamps onboarding_completed_at — only the
 *   Review step's complete_my_onboarding() call can, and the server
 *   decides.
 * - Work authorization and sponsorship are the user's OWN explicit
 *   answers; the resume import never fills them and nothing defaults.
 * - No demographic / EEO question lives on the profile draft. Self-
 *   identification is its own opt-in, encrypted step (selfId.ts).
 * - Every failure renders the real error. A slow service turns into the
 *   honest "starting blank" notice after 6 s instead of a skeleton
 *   forever; nothing retries in a loop.
 */

/**
 * What to do next, keyed on the server's verbatim redeem_invite error.
 * The reason itself is always shown as the server said it; this only
 * adds the advice that is TRUE for that reason.
 */
function redeemAdvice(reason: string): string {
  switch (reason) {
    case REDEEM_ERRORS.alreadyMember:
      return "Your account already has an invite, and quota comes from one invite only — the way to earn more is the invite-a-friend panel on your dashboard. Your account and profile are unaffected.";
    case REDEEM_ERRORS.ownInvite:
      return "That is one of your own referral codes — it only works for someone else. Send it to a friend; your account and profile are unaffected.";
    default:
      return "You can re-enter it on the sign-in page — your account and profile are unaffected.";
  }
}

const TOTAL = ONBOARDING_STEPS.length;

export function OnboardingPage(): JSX.Element {
  const { step: slugParam } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [screeners, setScreeners] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ step: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteRedemption>({ outcome: "none" });
  const [importVersion, setImportVersion] = useState(0);
  const redeemed = useRef(false);
  // The mounted form step's flush: navigation away runs it first and stays
  // put when it refuses (a shape-invalid edit is shown, never dropped).
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const setLeaveGuard = useCallback((guard: (() => Promise<boolean>) | null): void => {
    leaveGuard.current = guard;
  }, []);
  const goTo = useCallback(
    async (slug: StepSlug): Promise<void> => {
      if (leaveGuard.current && !(await leaveGuard.current())) return;
      navigate(`/onboarding/${slug}`);
    },
    [navigate],
  );

  const step = stepBySlug(slugParam);
  usePageTitle(step ? `Profile · ${step.title}` : "Profile");

  useEffect(() => {
    let alive = true;
    // One redemption attempt per page load, guarded again in data.ts by
    // clear-before-call — a flaky server can never loop.
    if (!redeemed.current) {
      redeemed.current = true;
      void redeemPendingInvite().then((r) => {
        if (alive) setInvite(r);
      });
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("profile service did not answer within 6s")), 6000),
    );
    void Promise.race([Promise.all([getMyProfile(), getMyScreenerAnswers()]), timeout])
      .then(([row, answers]) => {
        if (!alive) return;
        if (row) {
          setDraft(rowToDraft(row));
          setProgress(row.onboarding_progress);
        }
        setScreeners(Object.fromEntries(answers.map((a) => [a.key, a.answer])));
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Resume-later bookmark: remember the step being viewed. Best-effort
  // by design — it is a pointer, not an answer; the answers report their
  // own save state on every step.
  const slug = step?.slug;
  useEffect(() => {
    if (!slug || loading) return;
    saveOnboardingProgress(slug).catch(() => {
      /* bookmark only */
    });
  }, [slug, loading]);

  if (loading) {
    return <PanelState kind="loading" />;
  }
  if (!step) {
    return <Navigate to={`/onboarding/${resumeSlug(progress)}`} replace />;
  }

  const n = stepNumber(step.slug);
  const { prev, next } = neighbours(step.slug);
  const stepProps: StepProps = {
    step,
    draft,
    screeners,
    onSaved: (fields, answers) => {
      setDraft((d) => ({ ...d, ...fields }));
      if (answers) setScreeners((s) => ({ ...s, ...answers }));
    },
    onImported: (merged) => {
      setDraft(merged);
      setImportVersion((v) => v + 1);
    },
    // Next arrives from a step that has already flushed; Back and the
    // step links go through the guard.
    goNext: async () => {
      if (next) navigate(`/onboarding/${next}`);
    },
    goBack: prev ? () => void goTo(prev) : null,
    setLeaveGuard,
  };

  return (
    <div className="flex flex-col gap-6">
      {invite.outcome === "redeemed" ? (
        <Alert role="status">
          <Icon name="check" size={14} />
          <AlertDescription>
            <p className="m-0">
              Invite <code className="font-mono">{invite.code}</code> applied
              {invite.maxApplications !== null
                ? ` — it covers ${invite.maxApplications} completed applications`
                : ""}
              . Your dashboard tracks the quota.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {invite.outcome === "failed" ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              Your invite code <code className="font-mono">{invite.code}</code> could not be
              applied: {invite.reason}. {redeemAdvice(invite.reason)}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {loadError ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              Could not load a saved profile ({loadError}) — starting blank. If you had saved
              one before, continuing past a step replaces that step&apos;s answers with what
              you enter here; reload the page first to check.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <nav aria-label="Onboarding steps" className="flex flex-col gap-3">
        <ol className="m-0 flex max-w-full list-none gap-1 overflow-x-auto p-0 pb-1">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s.slug} className="shrink-0">
              <StepLink slug={s.slug} title={s.title} index={i + 1} current={s.slug === step.slug} done={i + 1 < n} onGo={goTo} />
            </li>
          ))}
        </ol>
        <Progress value={((n - 1) / (TOTAL - 1)) * 100} aria-label={`step ${n} of ${TOTAL}`} />
      </nav>

      <Reveal key={`${step.slug}-${importVersion}`} className="flex flex-col gap-6">
        <RevealItem className="flex flex-col gap-2">
          <Eyebrow>
            step {n} of {TOTAL}
          </Eyebrow>
          <Display as="h1" size="section">
            {step.title}
          </Display>
        </RevealItem>
        <RevealItem>
          <StepBody {...stepProps} />
        </RevealItem>
      </Reveal>
    </div>
  );
}

function StepLink({
  slug,
  title,
  index,
  current,
  done,
  onGo,
}: {
  slug: StepSlug;
  title: string;
  index: number;
  current: boolean;
  done: boolean;
  onGo: (slug: StepSlug) => Promise<void>;
}): JSX.Element {
  return (
    <Link
      to={`/onboarding/${slug}`}
      onClick={(e) => {
        // A real href for AT and middle-click; a plain click runs the
        // leave guard first.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        void onGo(slug);
      }}
      aria-current={current ? "step" : undefined}
      aria-label={`Step ${index} of ${TOTAL}: ${title}`}
      className={cn(
        "flex min-h-11 items-center gap-2 whitespace-nowrap rounded-md px-3 font-mono text-xs no-underline",
        current ? "bg-bg-inset font-heavy text-text" : "text-text-dim",
      )}
    >
      {done ? <Icon name="check" size={12} /> : <span aria-hidden>{index}</span>}
      {/* On a phone only the current title shows; the aria-label above
          carries every step's name. (Not sr-only: an absolutely positioned
          span keeps its static position inside the scrolling list and
          widened the document past the viewport — QA 2026-09-12 M9.) */}
      <span className={cn(!current && "hidden sm:inline")}>{title}</span>
    </Link>
  );
}

function StepBody(props: StepProps): JSX.Element {
  switch (props.step.slug) {
    case "identity":
      return <IdentityStep {...props} />;
    case "contact":
      return <ContactStep {...props} />;
    case "education":
      return <EducationStep {...props} />;
    case "experience":
      return <ExperienceStep {...props} />;
    case "documents":
      return <DocumentsStep {...props} />;
    case "eligibility":
      return <EligibilityStep {...props} />;
    case "compensation":
      return <CompensationStep {...props} />;
    case "about":
      return <AboutStep {...props} />;
    case "preferences":
      return <PreferencesStep {...props} />;
    case "review":
      return <ReviewStep {...props} />;
    case "self-id":
      return <SelfIdStep {...props} />;
    case "persona":
      return <PersonaStep {...props} />;
    case "integrations":
      return <IntegrationsStep {...props} />;
  }
}
