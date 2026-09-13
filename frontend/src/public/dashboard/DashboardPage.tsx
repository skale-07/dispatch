import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "../../auth/AuthContext";
import { Icon } from "../../components/Icon";
import { Display, Heavy } from "../../components/public/Display";
import { Eyebrow } from "../../components/public/Eyebrow";
import { QuotaMeter } from "../../components/public/QuotaMeter";
import { StatTile } from "../../components/public/StatTile";
import type { ApplicationRowPublic, ProfileRow, QuotaStatus, ReferralBonusRow } from "../contract";
import { getMyEngineControls, getMyProfile, getMyQuota, listMyApplications } from "../data";
import { classifyEngine, getEngineStatus, type EngineIndicator } from "../engineStatus";
import { InvitePanel } from "../InvitePanel";
import { listMyReferralBonuses } from "../referral";
import { usePageTitle } from "../usePageTitle";
import { ApplicationSheet } from "./ApplicationSheet";
import { ApplicationsPanel } from "./ApplicationsPanel";
import { EngineLine } from "./EngineLine";
import { NeedsYouPanel } from "./NeedsYouPanel";
import { ReferralDrafterPanel } from "./ReferralDrafterPanel";
import { SuggestedPanel } from "./SuggestedPanel";

/**
 * The dashboard (plan M11): what needs the user, how much quota is left,
 * every application with its receipt, what to answer once, and the
 * referral drafter — in that order on a phone. Every number is a real row
 * or absent; a failed read shows the failure and a manual refresh, never
 * a retry loop, never a guess.
 */

/** Below this many remaining, the quota copy starts talking. */
const LOW_QUOTA = 3;

export function DashboardPage(): JSX.Element {
  usePageTitle("Your applications");
  const { user, signOut, membership } = useAuth();
  const location = useLocation();
  const { id: detailId } = useParams();
  const savedBanner = (location.state as { profileSaved?: boolean } | null)?.profileSaved === true;

  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [apps, setApps] = useState<ApplicationRowPublic[] | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null | "unknown">("unknown");
  const [engine, setEngine] = useState<EngineIndicator | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [bonuses, setBonuses] = useState<ReferralBonusRow[] | null>(null);
  // null until the tasks read has answered — a 0 before that would be a fact we do not have.
  const [needsYou, setNeedsYou] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      getMyQuota(),
      listMyApplications(),
      getMyProfile(),
      getEngineStatus(),
      listMyReferralBonuses(),
      getMyEngineControls(),
    ]).then(([q, a, p, e, b, c]) => {
      if (q.status === "fulfilled") {
        setQuota(q.value);
        setQuotaLoaded(true);
      }
      if (a.status === "fulfilled") setApps(a.value);
      if (p.status === "fulfilled") setProfile(p.value);
      setBonuses(b.status === "fulfilled" ? b.value : null);
      setPaused(c.status === "fulfilled" ? (c.value?.paused ?? false) : null);
      setEngine(
        e.status === "fulfilled"
          ? classifyEngine(e.value)
          : { state: "unknown", reason: e.reason instanceof Error ? e.reason.message : String(e.reason) },
      );
      const reasons = [q, a]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      if (reasons.length > 0) setError([...new Set(reasons)].join(" · "));
      setLoading(false);
    });
  }, []);
  useEffect(load, [load]);

  const submitted = apps?.filter((a) => a.submitted_at !== null).length ?? null;
  const exhausted = quota !== null && quota.remaining <= 0;
  const lowQuota = quota !== null && !exhausted && quota.remaining <= LOW_QUOTA;
  const onboardingDone = profile !== "unknown" && profile !== null && profile.onboarding_completed_at !== null;
  const member: boolean | null = quota !== null ? true : quotaLoaded ? false : null;
  const detail = detailId ? (apps?.find((a) => a.id === detailId) ?? null) : null;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Eyebrow>receipts, not promises</Eyebrow>
        <Display as="h1" size="section">
          Your <Heavy>applications</Heavy>
        </Display>
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-dim">
          <span>{user?.email ?? "your account"}</span>
          <span aria-hidden>·</span>
          <Link to="/settings" className="text-accent-brand">
            settings
          </Link>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-accent-brand underline-offset-4 hover:underline"
            onClick={() => void signOut()}
          >
            sign out
          </button>
        </p>
        <EngineLine indicator={engine} loading={loading} paused={paused} />
      </header>

      {savedBanner ? (
        <Alert role="status">
          <Icon name="check" size={14} />
          <AlertDescription>
            <p className="m-0">
              Profile saved. Dispatch applies only from what you wrote — edit it any time in{" "}
              <Link to="/onboarding">your profile</Link>.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              Some of your data could not be loaded ({error}).{" "}
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-heavy underline-offset-4 hover:underline" onClick={load}>
                try again
              </button>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {membership.status === "failed" ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              Your account row could not be created ({membership.reason}). Reload to try again;
              nothing else on this page is affected.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {exhausted ? (
        <Alert role="status">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              <span className="font-heavy">Your quota is used up</span> — {quota.completed_applications} of{" "}
              {quota.max_completed_applications} completed applications. Dispatch has stopped applying for
              you; everything already submitted stays here with its receipt.{" "}
              {quota.has_invite ? (
                "Quota grows when a friend you invited activates (see below)."
              ) : (
                <>
                  An invite code adds its own quota — redeem one on the{" "}
                  <Link to="/signup">sign-in page</Link>.
                </>
              )}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <NeedsYouPanel applications={apps} onCount={setNeedsYou} />

      <section aria-label="your numbers" className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-5">
          {quota ? (
            <QuotaMeter used={quota.completed_applications} max={quota.max_completed_applications} />
          ) : (
            <StatTile
              label="applications"
              value={null}
              empty={
                loading
                  ? "loading"
                  : error
                    ? "could not load"
                    : membership.status === "failed"
                      ? `account setup failed: ${membership.reason}`
                      : "unknown until your account is set up"
              }
            />
          )}
          {quota && quota.bonus_completed_applications > 0 ? (
            <p className="m-0 mt-2 text-xs text-text-dim">
              +{quota.bonus_completed_applications} from{" "}
              {bonuses === null ? "friends" : bonuses.length === 1 ? "a friend" : `${bonuses.length} friends`} who
              activated{lowQuota ? " — almost there" : ""}
            </p>
          ) : null}
        </div>
        <StatTile
          label="submitted"
          value={submitted}
          empty={loading ? "loading" : "could not load"}
          hint={submitted === 0 ? "none yet — receipts appear here as they land" : "each with a screenshot receipt below"}
        />
        <StatTile
          label="needs you"
          value={needsYou}
          empty="could not count — see above"
          hint={needsYou === null ? undefined : needsYou === 0 ? "nothing waiting on you" : "open items above"}
        />
      </section>

      <ApplicationsPanel
        applications={apps}
        loading={loading}
        error={error}
        onRetry={load}
        onboardingDone={onboardingDone}
      />

      <Separator />
      <SuggestedPanel applications={apps} />
      <Separator />
      <ReferralDrafterPanel />
      <Separator />
      <InvitePanel headline={savedBanner ? "You're set — now invite a friend" : "Invite a friend"} member={member} bonuses={bonuses} />

      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/onboarding">
            <Icon name="arrow-right" size={14} />
            edit your profile
          </Link>
        </Button>
      </div>

      <ApplicationSheet row={detail} />
    </div>
  );
}
