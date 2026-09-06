import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
  SUPABASE_URL,
} from "../lib/appConfig";
import { supabase } from "../lib/supabaseClient";
import { stashInviteCode } from "./data";
import { GoogleMark } from "./GoogleMark";
import { usePageTitle } from "./usePageTitle";

/**
 * One page for sign-up and sign-in — both are the same flow either way,
 * so pretending they differ would only add a fork for users to take
 * wrongly. An invite code is optional (existing accounts sign in without
 * one) and is stashed locally before the hop, because both routes leave
 * the page: the magic link may land in a fresh tab, and Google bounces
 * through accounts.google.com. The first signed-in page redeems it.
 *
 * Two routes in, one account out. Supabase links a Google identity to an
 * existing email account when the Google address matches and is verified,
 * so a user who signed up by magic link and later clicks Google does not
 * get a second account. Google is offered first because it is one click
 * and skips the inbox round-trip.
 *
 * Honesty rules: the sent-state names the address so a typo is visible;
 * errors from the auth service render verbatim; an unconfigured build
 * shows the reason instead of a form that could only pretend.
 */
/**
 * Is Google actually turned on for this Supabase project?
 *
 * Whether a provider is enabled is a dashboard setting, not a build-time
 * one, so the frontend cannot know it from env. `/auth/v1/settings` is a
 * public endpoint that answers exactly this. We ask, because the
 * alternative is rendering a button whose only possible outcome is
 * "Unsupported provider" — the same reason an unconfigured build shows a
 * reason instead of a form. Fail closed: unknown or unreachable ⇒ hidden,
 * and the email route (always enabled) carries the page.
 */
function useGoogleEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const url = SUPABASE_URL;
    const key = SUPABASE_ANON_KEY;
    if (!url || !key) return;
    let alive = true;
    void fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => (r.ok ? (r.json() as Promise<AuthSettings>) : null))
      .then((s) => {
        if (alive) setEnabled(s?.external?.google === true);
      })
      .catch(() => {
        /* fail closed — the button stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

type AuthSettings = { external?: Record<string, boolean> };

export function SignupPage(): JSX.Element {
  const { code: codeParam } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const { session, signOut } = useAuth();
  const googleEnabled = useGoogleEnabled();

  const [email, setEmail] = useState("");
  // Minted invite links are /redeem?code=JRA-XXXX-XXXX (contract);
  // ?invite= and /invite/:code stay as aliases.
  const [invite, setInvite] = useState(
    codeParam ?? search.get("code") ?? search.get("invite") ?? "",
  );
  const [sending, setSending] = useState(false);
  const [google, setGoogle] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const arrivedWithInvite = invite.trim().length > 0 && !sentTo;
  usePageTitle(
    session
      ? "Signed in"
      : sentTo
        ? "Check your email"
        : arrivedWithInvite
          ? "Redeem your invite"
          : "Sign up or sign in",
  );

  // Captured once past the guard so the async submit closure keeps the
  // non-null narrowing.
  const sb = supabase;
  if (!SUPABASE_CONFIGURED || !sb) {
    return (
      <div className="card">
        <h1 className="hero-title">Sign in</h1>
        <div className="banner warn" role="alert">
          {SUPABASE_UNCONFIGURED_REASON}
        </div>
        <p className="muted flush-bottom">
          If you run this deployment: set <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> at build time. Until then the
          rest of the site works read-only.
        </p>
      </div>
    );
  }

  if (session) {
    return (
      <div className="card" style={{ maxWidth: "30rem" }}>
        <h1 className="hero-title">You&apos;re signed in</h1>
        <p className="muted">
          Signed in as <strong>{session.user.email ?? "your account"}</strong>.
        </p>
        <div className="toolbar stack-actions" style={{ margin: "0.6rem 0" }}>
          <Link to="/dashboard" className="btn">
            <Icon name="arrow-right" size={13} /> open your dashboard
          </Link>
          <Link to="/onboarding" className="btn">
            edit your profile
          </Link>
          <button className="ghost" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </div>
    );
  }

  if (sentTo) {
    return (
      <div className="card" style={{ maxWidth: "30rem" }}>
        <h1 className="hero-title">Check your email</h1>
        <div className="banner ok" role="status" aria-live="polite">
          <Icon name="mail" size={14} /> A sign-in link is on its way to{" "}
          <strong>{sentTo}</strong>.
        </div>
        <p className="muted">
          Open it on this device and you&apos;ll land in onboarding. Nothing
          within a couple of minutes? Check spam, or{" "}
          <button className="link-btn" onClick={() => setSentTo(null)}>
            try a different address
          </button>
          .
        </p>
        {invite.trim() ? (
          <p className="faint flush-bottom">
            Your invite code <code>{invite.trim()}</code> is saved on this
            device and will be applied when you&apos;re signed in.
          </p>
        ) : null}
      </div>
    );
  }

  /** Where to land after either route: back where they were headed. */
  const destination = (): string =>
    (location.state as { from?: string } | null)?.from ?? "/onboarding";

  const withGoogle = async (): Promise<void> => {
    setGoogle(true);
    setError(null);
    try {
      // Stash before the redirect — this tab is about to leave for
      // accounts.google.com, exactly like the magic-link hop.
      if (invite.trim()) stashInviteCode(invite);
      const { error: err } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}${destination()}` },
      });
      // Success navigates away; only a refused start returns here.
      if (err) throw new Error(err.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGoogle(false);
    }
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setSending(true);
    setError(null);
    try {
      if (invite.trim()) stashInviteCode(invite);
      const from = destination();
      const { error: err } = await sb.auth.signInWithOtp({
        email: addr,
        options: {
          emailRedirectTo: `${window.location.origin}${from}`,
        },
      });
      if (err) throw new Error(err.message);
      setSentTo(addr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: "30rem" }}>
      <h1 className="hero-title">
        {arrivedWithInvite ? "You're invited" : "Sign up or sign in"}
      </h1>
      <p className="muted flush-top">
        {arrivedWithInvite ? (
          <>
            Your invite code is filled in below.{" "}
            {googleEnabled ? "Continue with Google, or add" : "Add"} your
            email and we send a one-time sign-in link — no password, ever.
            The invite sets how many applications your account starts with;
            the number is on the invite itself.
          </>
        ) : (
          <>
            No password.{" "}
            {googleEnabled
              ? "Continue with Google, or enter your email"
              : "Enter your email"}{" "}
            and we send a one-time sign-in link. Have an invite code? It
            sets how many applications your account starts with — the
            number is on the invite itself.
          </>
        )}
      </p>
      {error ? (
        <div className="banner danger" role="alert">
          {error}
        </div>
      ) : null}
      {googleEnabled ? (
        <>
          <div className="toolbar stack-actions" style={{ margin: "0 0 0.35rem" }}>
            <button
              className="btn"
              type="button"
              onClick={() => void withGoogle()}
              disabled={google || sending}
            >
              <GoogleMark size={14} />{" "}
              {google ? "opening Google…" : "continue with Google"}
            </button>
          </div>
          <p className="faint" style={{ margin: "0 0 0.6rem" }}>
            Google tells us your name and email address — nothing else, and
            no access to your mail.
          </p>
          <div
            className="faint"
            role="separator"
            style={{ margin: "0 0 0.5rem" }}
          >
            or use your email
          </div>
        </>
      ) : null}
      <form onSubmit={(e) => void submit(e)} className="signup-form">
        <label className="field">
          email
          <input
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@school.edu"
          />
        </label>
        <label className="field">
          invite code{" "}
          <span className="faint">(optional if you already have an account)</span>
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="JRA-XXXX-XXXX"
          />
        </label>
        <div className="toolbar stack-actions" style={{ margin: "0.35rem 0 0" }}>
          <button className="primary" type="submit" disabled={sending || google}>
            <Icon name="mail" size={14} />{" "}
            {sending ? "sending…" : "email me a sign-in link"}
          </button>
        </div>
      </form>
      <p className="faint flush-bottom" style={{ marginTop: "0.75rem" }}>
        We use your email for sign-in and application receipts — nothing
        else. Dispatch never sends mail in your name.
      </p>
    </div>
  );
}
