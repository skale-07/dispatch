import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import {
  EMPLOYMENT_TYPE_OPTIONS,
  EMPTY_PROFILE,
  WORK_AUTH_OPTIONS,
  type ProfileDraft,
} from "./contract";
import {
  getMyProfile,
  redeemPendingInvite,
  rowToDraft,
  saveMyProfile,
  uploadResume,
  type InviteRedemption,
} from "./data";

/**
 * The consumer onboarding wizard — the profile Dispatch will answer
 * employer forms from, written by the user in their own words, stored
 * in the launcher-owned user_profiles row (own-row RLS).
 *
 * Product rules carried into the UI:
 * - Work authorization is the user's OWN explicit answer, chosen from
 *   the schema's labeled options; there is no default, no inference,
 *   and "ask me per-application" (null in the row) is a legal state
 *   that simply makes those questions to-dos later.
 * - Saving is one explicit action on the review step, and that final
 *   save stamps onboarding_completed_at — per the contract, the engine
 *   ignores profiles until it is non-null, so nothing acts on a
 *   half-finished profile.
 * - Every failure (load, upload, save, invite redemption) renders the
 *   real error. Nothing pretends.
 * - NO demographic/EEO questions (gender, race, veteran status,
 *   disability, pronouns) — queen directive 2026-09-01, mirroring the
 *   engine's house rule that such fields only ever fill from an
 *   operator-encrypted sensitive profile. v0 does not collect this data
 *   in the cloud at all; do not add such steps here.
 */

const STEPS = [
  "About you",
  "Education",
  "Work authorization",
  "Resume",
  "Preferences",
  "Review",
] as const;

export function ProfileWizardPage(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invite, setInvite] = useState<InviteRedemption>({ outcome: "none" });
  const redeemed = useRef(false);

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
    // One load attempt with a hard cap: a slow or unreachable service
    // turns into the honest "starting blank" banner after 6s instead of
    // a skeleton forever. (No retry loop — house rule.)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("profile service did not answer within 6s")),
        6000,
      ),
    );
    void Promise.race([getMyProfile(), timeout])
      .then((row) => {
        if (!alive) return;
        if (row) setDraft(rowToDraft(row));
      })
      .catch((err: unknown) => {
        if (alive) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const set = <K extends keyof ProfileDraft>(
    key: K,
    value: ProfileDraft[K],
  ): void => setDraft((d) => ({ ...d, [key]: value }));

  const validateStep = (n: number): string | null => {
    if (n === 0) {
      if (!draft.full_name.trim()) return "Your name is how forms get signed — it can't be blank.";
    }
    if (n === 1) {
      if (!draft.school.trim()) return "School is on nearly every form — fill it in.";
      if (draft.grad_year && !/^\d{4}$/.test(draft.grad_year.trim())) {
        return "Graduation year should be a 4-digit year (e.g. 2027).";
      }
    }
    // Steps 2–4 have no hard requirements: unanswered means "ask me
    // per-application", which is a legal, honest state.
    return null;
  };

  const next = (): void => {
    const err = validateStep(step);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = (): void => {
    setStepError(null);
    setStep((s) => Math.max(s - 1, 0));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setStepError(null);
    try {
      await saveMyProfile(draft);
      navigate("/dashboard", { state: { profileSaved: true } });
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="skeleton-lines">
        <Skeleton width="40%" />
        <Skeleton width="70%" />
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Your profile</h1>
        <div className="sub">
          the only place Dispatch's answers come from — your words, saved
          once, used on every form
        </div>
      </div>

      {invite.outcome === "redeemed" ? (
        <div className="banner ok">
          <Icon name="check" size={14} /> Invite <code>{invite.code}</code>{" "}
          applied
          {invite.maxApplications !== null
            ? ` — it covers ${invite.maxApplications} completed applications`
            : ""}
          . Your dashboard tracks the quota.
        </div>
      ) : null}
      {invite.outcome === "failed" ? (
        <div className="banner warn">
          Your invite code <code>{invite.code}</code> could not be applied:{" "}
          {invite.reason}. You can re-enter it on the sign-in page — your
          account and profile are unaffected.
        </div>
      ) : null}
      {loadError ? (
        <div className="banner warn">
          Could not load a saved profile ({loadError}) — starting blank.
          Saving still works if the service is reachable.
        </div>
      ) : null}

      <nav className="wizard-steps" aria-label="Onboarding steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            className={`wizard-step ${i === step ? "current" : ""} ${i < step ? "done" : ""}`}
            onClick={() => {
              // Backward jumps are free; forward jumps still validate the
              // current step so a required blank can't be skipped past.
              if (i <= step) {
                setStepError(null);
                setStep(i);
              } else {
                next();
              }
            }}
            aria-current={i === step ? "step" : undefined}
          >
            <span className="wizard-step-n">{i + 1}</span> {label}
          </button>
        ))}
      </nav>

      <div className="card">
        {stepError ? <div className="banner warn">{stepError}</div> : null}

        {step === 0 ? (
          <div className="wizard-fields">
            <label className="field">
              full name
              <input
                value={draft.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="field">
              phone <span className="faint">(many forms require one)</span>
              <input
                value={draft.phone}
                onChange={(e) => set("phone", e.target.value)}
                autoComplete="tel"
                placeholder="+1 555 555 5555"
              />
            </label>
            <label className="field">
              city
              <input
                value={draft.location_city}
                onChange={(e) => set("location_city", e.target.value)}
                placeholder="Pittsburgh"
              />
            </label>
            <label className="field">
              state / region
              <input
                value={draft.location_region}
                onChange={(e) => set("location_region", e.target.value)}
                placeholder="PA"
              />
            </label>
            <label className="field">
              country
              <input
                value={draft.location_country}
                onChange={(e) => set("location_country", e.target.value)}
                placeholder="USA"
              />
            </label>
            <label className="field">
              LinkedIn URL <span className="faint">(optional)</span>
              <input
                value={draft.linkedin_url}
                onChange={(e) => set("linkedin_url", e.target.value)}
                placeholder="https://linkedin.com/in/…"
              />
            </label>
            <label className="field">
              GitHub URL <span className="faint">(optional)</span>
              <input
                value={draft.github_url}
                onChange={(e) => set("github_url", e.target.value)}
                placeholder="https://github.com/…"
              />
            </label>
            <label className="field">
              portfolio URL <span className="faint">(optional)</span>
              <input
                value={draft.portfolio_url}
                onChange={(e) => set("portfolio_url", e.target.value)}
                placeholder="https://…"
              />
            </label>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="wizard-fields">
            <label className="field">
              school
              <input
                value={draft.school}
                onChange={(e) => set("school", e.target.value)}
                placeholder="University of …"
              />
            </label>
            <label className="field">
              degree
              <input
                value={draft.degree}
                onChange={(e) => set("degree", e.target.value)}
                placeholder="B.S."
              />
            </label>
            <label className="field">
              field of study
              <input
                value={draft.field}
                onChange={(e) => set("field", e.target.value)}
                placeholder="Computer Science"
              />
            </label>
            <label className="field">
              graduation year
              <input
                value={draft.grad_year}
                onChange={(e) => set("grad_year", e.target.value)}
                inputMode="numeric"
                placeholder="2027"
              />
            </label>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="wizard-fields">
            <p className="muted flush-top">
              Your answers here go onto forms <em>exactly</em> as you set
              them — Dispatch never guesses either question. Leave one
              unanswered and applications that ask it become a quick to-do
              for you instead.
            </p>
            <span className="field">
              Your work authorization in the United States
              <span className="wizard-options wizard-options-stack" role="radiogroup" aria-label="Work authorization">
                {WORK_AUTH_OPTIONS.map((opt) => (
                  <label key={opt.value} className="wizard-option">
                    <input
                      type="radio"
                      name="work_authorization"
                      checked={draft.work_authorization === opt.value}
                      onChange={() => set("work_authorization", opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
                <label className="wizard-option">
                  <input
                    type="radio"
                    name="work_authorization"
                    checked={draft.work_authorization === ""}
                    onChange={() => set("work_authorization", "")}
                  />
                  ask me per-application
                </label>
              </span>
            </span>
            <span className="field">
              Will you now or in the future require sponsorship?
              <span className="wizard-options" role="radiogroup" aria-label="Sponsorship">
                {(["yes", "no", ""] as const).map((v) => (
                  <label key={`spon-${v || "unset"}`} className="wizard-option">
                    <input
                      type="radio"
                      name="needs_sponsorship"
                      checked={draft.needs_sponsorship === v}
                      onChange={() => set("needs_sponsorship", v)}
                    />
                    {v === "yes" ? "Yes" : v === "no" ? "No" : "ask me per-application"}
                  </label>
                ))}
              </span>
            </span>
          </div>
        ) : null}

        {step === 3 ? (
          <ResumeStep
            path={draft.resume_object_path}
            filename={draft.resume_filename}
            onUploaded={(path, filename) =>
              setDraft((d) => ({
                ...d,
                resume_object_path: path,
                resume_filename: filename,
              }))
            }
          />
        ) : null}

        {step === 4 ? (
          <div className="wizard-fields">
            <label className="field">
              roles you want <span className="faint">(comma-separated)</span>
              <input
                value={draft.titles}
                onChange={(e) => set("titles", e.target.value)}
                placeholder="Software Engineer Intern, Data Analyst"
              />
            </label>
            <label className="field">
              locations <span className="faint">(comma-separated, or &quot;anywhere&quot;)</span>
              <input
                value={draft.locations}
                onChange={(e) => set("locations", e.target.value)}
                placeholder="NYC, remote"
              />
            </label>
            <label className="field">
              work style
              <select
                value={draft.remote}
                onChange={(e) =>
                  set("remote", e.target.value as ProfileDraft["remote"])
                }
              >
                <option value="">no preference</option>
                <option value="remote">remote</option>
                <option value="hybrid">hybrid</option>
                <option value="onsite">on-site</option>
                <option value="any">any</option>
              </select>
            </label>
            <span className="field">
              employment types
              <span className="wizard-options">
                {EMPLOYMENT_TYPE_OPTIONS.map((t) => (
                  <label key={t} className="wizard-option">
                    <input
                      type="checkbox"
                      checked={draft.employment_types.includes(t)}
                      onChange={(e) =>
                        set(
                          "employment_types",
                          e.target.checked
                            ? [...draft.employment_types, t]
                            : draft.employment_types.filter((x) => x !== t),
                        )
                      }
                    />
                    {t.replace("_", "-")}
                  </label>
                ))}
              </span>
            </span>
            <label className="field">
              minimum salary, USD/year{" "}
              <span className="faint">(optional — leave blank to skip)</span>
              <input
                value={draft.min_salary_usd}
                onChange={(e) => set("min_salary_usd", e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 70000"
              />
            </label>
          </div>
        ) : null}

        {step === 5 ? (
          <>
            <p className="muted flush-top">
              This is everything Dispatch may put on a form for you.
              Anything blank stays blank on forms and becomes a to-do when
              required. Saving marks your onboarding complete — that is
              what tells Dispatch this profile is ready to apply from.
            </p>
            <dl className="kv">
              <dt>name</dt><dd>{draft.full_name || "—"}</dd>
              <dt>phone</dt><dd>{draft.phone || "—"}</dd>
              <dt>location</dt>
              <dd>
                {[draft.location_city, draft.location_region, draft.location_country]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </dd>
              <dt>links</dt>
              <dd>
                {[draft.linkedin_url, draft.github_url, draft.portfolio_url]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
              <dt>education</dt>
              <dd>
                {[
                  [draft.degree, draft.field].filter(Boolean).join(" "),
                  draft.school,
                  draft.grad_year,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
              <dt>work authorization</dt>
              <dd>
                {WORK_AUTH_OPTIONS.find((o) => o.value === draft.work_authorization)
                  ?.label ?? "ask me per-application"}
              </dd>
              <dt>needs sponsorship</dt>
              <dd>{draft.needs_sponsorship || "ask me per-application"}</dd>
              <dt>resume</dt>
              <dd>{draft.resume_filename ?? "none uploaded"}</dd>
              <dt>roles</dt><dd>{draft.titles || "—"}</dd>
              <dt>locations</dt><dd>{draft.locations || "—"}</dd>
              <dt>work style</dt><dd>{draft.remote || "no preference"}</dd>
              <dt>employment types</dt>
              <dd>
                {draft.employment_types.length > 0
                  ? draft.employment_types.map((t) => t.replace("_", "-")).join(", ")
                  : "—"}
              </dd>
              <dt>minimum salary</dt>
              <dd>{draft.min_salary_usd ? `$${draft.min_salary_usd}/yr` : "—"}</dd>
            </dl>
          </>
        ) : null}

        <div className="toolbar" style={{ marginTop: "1rem", marginBottom: 0 }}>
          {step > 0 ? (
            <button onClick={back}>
              <Icon name="arrow-left" size={13} /> back
            </button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button className="primary" onClick={next}>
              next <Icon name="arrow-right" size={13} />
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => void save()}
              disabled={saving}
            >
              <Icon name="check" size={14} />{" "}
              {saving ? "saving…" : "save — I'm ready to apply"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function ResumeStep(props: {
  path: string | null;
  filename: string | null;
  onUploaded: (path: string, filename: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { path, filename } = await uploadResume(file);
      props.onUploaded(path, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-fields">
      <p className="muted flush-top">
        One PDF, up to 5&nbsp;MB. It is stored privately for your account
        and recorded on your profile the moment the upload succeeds;
        uploading a file with the same name replaces it.
      </p>
      {error ? <div className="banner warn">{error}</div> : null}
      {props.path ? (
        <p>
          <span className="badge ok">on file</span>{" "}
          <span className="mono">{props.filename ?? props.path}</span>
        </p>
      ) : (
        <p className="faint">No resume uploaded yet — that&apos;s fine; you can add it later.</p>
      )}
      <label className="field">
        {props.path ? "replace resume (PDF)" : "upload resume (PDF)"}
        <input
          type="file"
          accept="application/pdf"
          disabled={busy}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </label>
      {busy ? <p className="faint">uploading…</p> : null}
    </div>
  );
}
