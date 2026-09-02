import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import {
  type ApplicationRowPublic,
  type ProfileRow,
  type QuotaStatus,
  type ReferralBonusRow,
} from "./contract";
import {
  getMyProfile,
  getMyQuota,
  listMyApplications,
  receiptUrl,
} from "./data";
import {
  classifyEngine,
  getEngineStatus,
  SYNC_INTERVAL_MS,
  type EngineIndicator,
} from "./engineStatus";
import { InvitePanel } from "./InvitePanel";
import { listMyReferralBonuses } from "./referral";
import { usePageTitle } from "./usePageTitle";

/**
 * The user's dashboard: what was submitted for them, the receipt for
 * each, and how much of their quota remains. Reads are RLS-scoped
 * Supabase queries through the contract seam.
 *
 * Honesty rules, same as everywhere: every number is a real row or
 * absent — quota unknown renders "unknown", never a guess; hours-back
 * is labeled as the derived 20–40min range it is; a failed read shows
 * the failure and a manual refresh, not a retry loop. The empty state
 * distinguishes "nothing yet" from "could not load" (they used to share
 * one headline — QA 2026-09-02, D-15) and tailors its advice to whether
 * the profile is actually finished (D-16).
 */

/** Below this many remaining, the quota stat starts talking (D-14). */
const LOW_QUOTA = 3;

export function DashboardPage(): JSX.Element {
  usePageTitle("Your applications");
  const { user, signOut } = useAuth();
  const location = useLocation();
  const savedBanner =
    (location.state as { profileSaved?: boolean } | null)?.profileSaved === true;

  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [apps, setApps] = useState<ApplicationRowPublic[] | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null | "unknown">(
    "unknown",
  );
  const [engine, setEngine] = useState<EngineIndicator | null>(null);
  const [bonuses, setBonuses] = useState<ReferralBonusRow[] | null>(null);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
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
    ]).then(([q, a, p, e, b]) => {
      if (q.status === "fulfilled") {
        setQuota(q.value);
        setQuotaLoaded(true);
      }
      if (a.status === "fulfilled") setApps(a.value);
      if (p.status === "fulfilled") setProfile(p.value);
      // The ledger only decorates the bonus copy; unreadable = "friends".
      setBonuses(b.status === "fulfilled" ? b.value : null);
      // The heartbeat read failing is shown on the indicator itself, not
      // as a page banner: it is a status line, not user data.
      setEngine(
        e.status === "fulfilled"
          ? classifyEngine(e.value)
          : {
              state: "unknown",
              reason: e.reason instanceof Error ? e.reason.message : String(e.reason),
            },
      );
      // The profile is advice-only; its failure never blocks the page and
      // is not worth a banner of its own.
      const reasons = [q, a]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) =>
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      if (reasons.length > 0) setError([...new Set(reasons)].join(" · "));
      setLoading(false);
    });
  }, []);

  useEffect(load, [load]);

  const submitted = apps?.filter((a) => a.submitted_at !== null).length ?? null;
  const exhausted = quota !== null && quota.remaining <= 0;
  const lowQuota = quota !== null && !exhausted && quota.remaining <= LOW_QUOTA;
  const onboardingDone =
    profile !== "unknown" && profile !== null && profile.onboarding_completed_at !== null;
  // Membership = an app_users row, which is exactly when the quota view
  // has a row. Unknown until the read succeeds (mint stays enabled and
  // the server decides).
  const member: boolean | null = quota !== null ? true : quotaLoaded ? false : null;
  const bonus = quota?.bonus_completed_applications ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Your applications</h1>
        <div className="sub">
          {user?.email ?? "your account"} ·{" "}
          <button className="link-btn" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </div>

      {savedBanner ? (
        <div className="banner ok" role="status">
          <Icon name="check" size={14} /> Profile saved. Dispatch applies
          only from what you wrote — edit it any time in{" "}
          <Link to="/onboarding">your profile</Link>.
        </div>
      ) : null}

      {error ? (
        <div className="banner warn" role="alert">
          Some of your data could not be loaded ({error}).{" "}
          <button className="link-btn" onClick={load}>
            try again
          </button>
        </div>
      ) : null}

      {exhausted ? (
        <div className="banner warn quota-banner" role="status">
          <Icon name="alert" size={14} />
          <span>
            <strong>Your invite&apos;s quota is used up</strong> —{" "}
            {quota.completed_applications} of {quota.max_completed_applications}{" "}
            completed applications. Dispatch has stopped applying for you;
            everything already submitted stays here with its receipt. A new
            invite code extends the quota — redeem one on the{" "}
            <Link to="/signup">sign-in page</Link>.
          </span>
        </div>
      ) : null}

      <div className="stat-row">
        <div className="stat">
          <div className="label">applications submitted</div>
          <div className="value">{submitted ?? "—"}</div>
          <div className="hint">
            {submitted === null
              ? loading
                ? "loading"
                : "could not load"
              : submitted === 0
                ? "none yet — receipts appear here as they land"
                : "each with a screenshot receipt below"}
          </div>
        </div>
        <div className="stat">
          <div className="label">quota remaining</div>
          <div className="value">{quota ? quota.remaining : "—"}</div>
          <div className="hint">
            {quota
              ? `${quota.completed_applications} of ${quota.max_completed_applications} completed${lowQuota ? " — almost there" : ""}`
              : loading
                ? "loading"
                : error
                  ? "could not load"
                  : "unknown until an invite is applied"}
            {quota && bonus > 0 ? (
              <span className="quota-bonus">
                <Icon name="sparkle" size={11} /> +{bonus} from{" "}
                {bonuses === null
                  ? "friends"
                  : bonuses.length === 1
                    ? "a friend"
                    : `${bonuses.length} friends`}{" "}
                who activated
              </span>
            ) : null}
          </div>
        </div>
        <div className="stat">
          <div className="label">hours you didn&apos;t spend</div>
          <div className="value">
            {submitted ? `${hours(submitted, 20)}–${hours(submitted, 40)}` : "—"}
          </div>
          <div className="hint">at 20–40 min per manual application</div>
        </div>
      </div>

      <div className="card">
        <h2>Every application, accounted for</h2>
        <EngineLine indicator={engine} loading={loading} />
        {loading && apps === null ? (
          <div className="skeleton-lines" role="status" aria-live="polite">
            <Skeleton width="70%" />
            <Skeleton width="50%" />
            <p className="faint">loading your applications…</p>
          </div>
        ) : null}
        {!loading && apps === null ? (
          <EmptyState
            icon="alert"
            title="Couldn't load your applications"
            body="The numbers above show only what did load — never a guess. Try again in a moment; if it keeps failing, the account service is the thing to check, not your profile."
            action={
              <button className="btn" onClick={load}>
                try again
              </button>
            }
          />
        ) : null}
        {!loading && apps !== null && apps.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="Nothing here yet"
            body={
              onboardingDone
                ? "Your profile is finished. Dispatch's next run picks it up and each application it submits lands here with a screenshot receipt — nothing is counted until it really happened."
                : "Applications appear here — each with a screenshot receipt — once your profile is finished. Dispatch does not apply from a half-finished profile."
            }
            action={
              onboardingDone ? undefined : (
                <Link to="/onboarding" className="btn">
                  finish your profile
                </Link>
              )
            }
          />
        ) : null}
        {apps !== null && apps.length > 0 ? (
          <>
            <ul className="app-list">
              {apps.map((a) => (
                <li key={a.id}>
                  <span className="app-company">{a.company ?? "—"}</span>
                  <span className="app-role">{a.role ?? "—"}</span>
                  <StatusBadge row={a} />
                  <span className="app-meta">
                    {a.source_ats ?? "—"}
                    {a.submitted_at
                      ? ` · submitted ${new Date(a.submitted_at).toLocaleDateString()}`
                      : ""}
                  </span>
                  <span className="app-receipt">
                    {a.receipt_path ? (
                      <ReceiptLink path={a.receipt_path} />
                    ) : (
                      <span className="faint">no receipt stored</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="table-wrap app-table" style={{ border: "none" }}>
              <table>
                <thead>
                  <tr>
                    <th>company</th>
                    <th>role</th>
                    <th>status</th>
                    <th>via</th>
                    <th>submitted</th>
                    <th>receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id}>
                      <td>{a.company ?? "—"}</td>
                      <td>{a.role ?? "—"}</td>
                      <td>
                        <StatusBadge row={a} />
                      </td>
                      <td className="mono">{a.source_ats ?? "—"}</td>
                      <td className="mono">
                        {a.submitted_at
                          ? new Date(a.submitted_at).toLocaleDateString()
                          : "—"}
                      </td>
                      <td>
                        {a.receipt_path ? (
                          <ReceiptLink path={a.receipt_path} />
                        ) : (
                          <span className="faint">none stored</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      <InvitePanel
        headline={savedBanner ? "You're set — now invite a friend" : "Invite a friend"}
        member={member}
        bonuses={bonuses}
      />
    </>
  );
}

/**
 * The engine indicator: a real heartbeat row (engine_status), classified
 * against the sync cadence — never inferred from application rows.
 * Four honest states plus "the read failed", each with its evidence.
 */
function EngineLine({
  indicator,
  loading,
}: {
  indicator: EngineIndicator | null;
  loading: boolean;
}): JSX.Element {
  const minutes = Math.round(SYNC_INTERVAL_MS / 60000);
  let tone: "neutral" | "ok" | "warn" | "danger" = "neutral";
  let body: JSX.Element;
  if (indicator === null) {
    body = <>{loading ? "checking whether your engine is running…" : "engine status unknown"}</>;
  } else {
    switch (indicator.state) {
      case "not-connected":
        body = (
          <>
            engine not connected — no heartbeat has been recorded for your
            account yet. Applications land here once an engine picks up your
            profile.
          </>
        );
        break;
      case "running":
        tone = "ok";
        body = (
          <>
            engine running · last sync{" "}
            <time dateTime={indicator.row.last_seen_at}>
              {relativeTime(indicator.row.last_seen_at)}
            </time>
            {indicator.row.engine_version ? (
              <>
                {" "}
                · <span className="mono">{indicator.row.engine_version}</span>
              </>
            ) : null}
          </>
        );
        break;
      case "running-push-failed":
        tone = "warn";
        body = (
          <>
            engine running, last push failed{" "}
            <time dateTime={indicator.row.last_seen_at}>
              {relativeTime(indicator.row.last_seen_at)}
            </time>
            : <span className="mono">{indicator.row.last_error}</span>. Rows
            here may lag until the next sync succeeds.
          </>
        );
        break;
      case "offline":
        tone = "danger";
        body = (
          <>
            engine offline since{" "}
            <time dateTime={indicator.row.last_seen_at}>
              {relativeTime(indicator.row.last_seen_at)}
            </time>{" "}
            (no heartbeat in {2 * minutes} min). Nothing is being applied for
            you right now; everything below stays with its receipt.
          </>
        );
        break;
      case "unknown":
        body = <>engine status could not be read ({indicator.reason})</>;
        break;
    }
  }
  return (
    <p className="faint flush-top engine-line" role="status">
      <span className={`engine-dot ${tone}`} aria-hidden />
      <span>{body}</span>
    </p>
  );
}

function StatusBadge({ row }: { row: ApplicationRowPublic }): JSX.Element {
  return (
    <span className={`badge app-status ${row.submitted_at ? "ok" : "neutral"}`}>
      {row.status.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}

function hours(count: number, minutesPer: number): string {
  const h = (count * minutesPer) / 60;
  return h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toString();
}

/** "3 hours ago" from an ISO timestamp the server wrote. */
function relativeTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

/**
 * Receipts live in a private bucket; the link is minted on demand as a
 * short-lived signed URL — one attempt per click, real error inline.
 */
function ReceiptLink({ path }: { path: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const url = await receiptUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="ghost receipt-btn"
        onClick={() => void open()}
        disabled={busy}
      >
        <Icon name="file" size={13} /> {busy ? "opening…" : "view screenshot"}
      </button>
      {error ? (
        <span className="faint" role="alert">
          {" "}
          {error}
        </span>
      ) : null}
    </>
  );
}
