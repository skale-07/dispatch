import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { type ApplicationRowPublic, type QuotaStatus } from "./contract";
import { getMyQuota, listMyApplications, receiptUrl } from "./data";

/**
 * The user's dashboard: what was submitted for them, the receipt for
 * each, and how much of their quota remains. Reads are RLS-scoped
 * Supabase queries through the contract seam (placeholder names until
 * the launcher schema lands).
 *
 * Honesty rules, same as everywhere: every number is a real row or
 * absent — quota unknown renders "unknown", never a guess; hours-back
 * is labeled as the derived 20–40min range it is; a failed read shows
 * the failure and a manual refresh, not a retry loop.
 */
export function DashboardPage(): JSX.Element {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const savedBanner =
    (location.state as { profileSaved?: boolean } | null)?.profileSaved === true;

  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [apps, setApps] = useState<ApplicationRowPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    void Promise.allSettled([getMyQuota(), listMyApplications()]).then(
      ([q, a]) => {
        if (q.status === "fulfilled") setQuota(q.value);
        if (a.status === "fulfilled") setApps(a.value);
        const reasons = [q, a]
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) =>
            r.reason instanceof Error ? r.reason.message : String(r.reason),
          );
        if (reasons.length > 0) setError([...new Set(reasons)].join(" · "));
        setLoading(false);
      },
    );
  }, []);

  useEffect(load, [load]);

  const submitted = apps?.filter((a) => a.submitted_at !== null).length ?? null;

  return (
    <>
      <div className="page-head">
        <h1>Your applications</h1>
        <div className="sub">
          {user?.email ?? "your account"} ·{" "}
          <button className="ghost" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </div>

      {savedBanner ? (
        <div className="banner ok">
          <Icon name="check" size={14} /> Profile saved. Dispatch applies
          only from what you wrote — edit it any time in{" "}
          <Link to="/onboarding">onboarding</Link>.
        </div>
      ) : null}

      {error ? (
        <div className="banner warn">
          Some of your data could not be loaded ({error}).{" "}
          <button className="ghost" onClick={load}>
            try again
          </button>
        </div>
      ) : null}

      <div className="stat-row">
        <div className="stat">
          <div className="label">applications submitted</div>
          <div className="value">{submitted ?? "—"}</div>
          <div className="hint">
            {submitted === null
              ? "not loaded"
              : "each with a screenshot receipt below"}
          </div>
        </div>
        <div className="stat">
          <div className="label">quota remaining</div>
          <div className="value">{quota ? quota.remaining : "—"}</div>
          <div className="hint">
            {quota
              ? `${quota.completed_applications} completed of ${quota.max_completed_applications} your invite covers`
              : "unknown until your invite is applied"}
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
        {loading && apps === null ? (
          <div className="skeleton-lines">
            <Skeleton width="70%" />
            <Skeleton width="50%" />
          </div>
        ) : null}
        {!loading && (apps === null || apps.length === 0) ? (
          <EmptyState
            icon="inbox"
            title="Nothing here yet"
            body={
              apps === null
                ? "Your application list could not be loaded — the numbers above are only what did load, never a guess."
                : "Once your profile is finished, applications submitted for you appear here with their receipts."
            }
            action={
              apps !== null ? (
                <Link to="/onboarding" className="btn">
                  finish your profile
                </Link>
              ) : undefined
            }
          />
        ) : null}
        {apps !== null && apps.length > 0 ? (
          <div className="table-wrap" style={{ border: "none" }}>
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
                      <span
                        className={`badge ${a.submitted_at ? "ok" : "neutral"}`}
                      >
                        {a.status.toLowerCase().replace(/_/g, " ")}
                      </span>
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
        ) : null}
      </div>
    </>
  );
}

function hours(count: number, minutesPer: number): string {
  const h = (count * minutesPer) / 60;
  return h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toString();
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
      <button className="ghost" onClick={() => void open()} disabled={busy}>
        <Icon name="file" size={13} /> {busy ? "opening…" : "view screenshot"}
      </button>
      {error ? <span className="faint"> {error}</span> : null}
    </>
  );
}
