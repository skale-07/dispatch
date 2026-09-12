import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Display, Heavy } from "../components/public/Display";
import { Eyebrow } from "../components/public/Eyebrow";
import { FieldHint } from "../components/public/FieldHint";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
  SUPABASE_URL,
} from "../lib/appConfig";
import { supabase } from "../lib/supabaseClient";
import { stashInviteCode } from "./data";
import { GoogleMark } from "./GoogleMark";
import { getReferralSettings } from "./referral";
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

/**
 * The free allowance from referral_settings() (open signup,
 * 20260911000100). null until loaded or when the read fails — the copy
 * then says "free" without a number rather than inventing one.
 */
function useFreeSignupQuota(): number | null {
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let alive = true;
    void getReferralSettings()
      .then((s) => {
        // Missing field (open-signup migration not applied) ⇒ no number.
        if (alive) setFree(typeof s.free_signup_quota === "number" ? s.free_signup_quota : null);
      })
      .catch(() => {
        // Unavailable is a legal state; the number is decoration here.
      });
    return () => {
      alive = false;
    };
  }, []);
  return free;
}

/** The narrow column every state of this page sits in. */
function Frame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Card className="mx-auto w-full max-w-lg gap-5 py-7">
      <CardContent className="flex flex-col gap-5 px-6 sm:px-8">{children}</CardContent>
    </Card>
  );
}

export function SignupPage(): JSX.Element {
  const { code: codeParam } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const { session, signOut } = useAuth();
  const googleEnabled = useGoogleEnabled();
  const freeQuota = useFreeSignupQuota();

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
      <Frame>
        <Display as="h1" size="section">
          Sign in
        </Display>
        <Alert variant="destructive" role="alert">
          <AlertDescription>{SUPABASE_UNCONFIGURED_REASON}</AlertDescription>
        </Alert>
        <p className="m-0 text-sm text-text-dim">
          If you run this deployment: set{" "}
          <code className="font-mono">VITE_SUPABASE_URL</code> and{" "}
          <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> at build
          time. Until then the rest of the site works read-only.
        </p>
      </Frame>
    );
  }

  if (session) {
    return (
      <Frame>
        <Display as="h1" size="section">
          You&apos;re <Heavy>signed in</Heavy>
        </Display>
        <p className="m-0 text-base text-text-dim">
          Signed in as{" "}
          <span className="font-heavy text-text">{session.user.email ?? "your account"}</span>.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button asChild>
            <Link to="/dashboard">
              <Icon name="arrow-right" size={13} />
              open your dashboard
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/onboarding">edit your profile</Link>
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            sign out
          </Button>
        </div>
      </Frame>
    );
  }

  if (sentTo) {
    return (
      <Frame>
        <Display as="h1" size="section">
          Check your <Heavy>email</Heavy>
        </Display>
        <Alert role="status" aria-live="polite" className="border-ok/40 bg-ok-dim text-text">
          <Icon name="mail" size={14} />
          <AlertDescription className="text-text">
            {/* One <p>: AlertDescription is a grid, and three inline nodes
                would become three rows. */}
            <p className="m-0">
              A sign-in link is on its way to <span className="font-heavy">{sentTo}</span>.
            </p>
          </AlertDescription>
        </Alert>
        <p className="m-0 text-base text-text-dim">
          Open it on this device and you&apos;ll land in onboarding. Nothing
          within a couple of minutes? Check spam, or{" "}
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 font-heavy text-accent-brand underline-offset-4 hover:underline"
            onClick={() => setSentTo(null)}
          >
            try a different address
          </button>
          .
        </p>
        {invite.trim() ? (
          <FieldHint>
            Your invite code <code className="font-mono">{invite.trim()}</code> is saved on this
            device and will be applied when you&apos;re signed in.
          </FieldHint>
        ) : null}
      </Frame>
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

  const freeCopy = freeQuota !== null ? `${freeQuota} free applications` : "free applications";

  return (
    <Frame>
      <div className="flex flex-col gap-3">
        <Eyebrow>{arrivedWithInvite ? "an invite" : "no password, ever"}</Eyebrow>
        <Display as="h1" size="section">
          {arrivedWithInvite ? (
            <>
              You&apos;re <Heavy>invited</Heavy>
            </>
          ) : (
            <>
              Sign up or <Heavy>sign in</Heavy>
            </>
          )}
        </Display>
        <p className="m-0 text-base leading-relaxed text-text-dim">
          {arrivedWithInvite ? (
            <>
              Your invite code is filled in below.{" "}
              {googleEnabled ? "Continue with Google, or add" : "Add"} your email and we
              send a one-time sign-in link. Every account starts with {freeCopy}; the
              invite adds its own on top (the number is on the invite itself).
            </>
          ) : (
            <>
              {googleEnabled ? "Continue with Google, or enter your email" : "Enter your email"}{" "}
              and we send a one-time sign-in link. Every account starts with {freeCopy}.
              Have an invite code from a friend? It adds that code&apos;s applications on
              top.
            </>
          )}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {googleEnabled ? (
        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => void withGoogle()}
            disabled={google || sending}
          >
            <GoogleMark size={14} />
            {google ? "opening Google…" : "continue with Google"}
          </Button>
          <FieldHint>
            Google tells us your name and email address — nothing else, and no access to
            your mail.
          </FieldHint>
          <div className="flex items-center gap-3" role="separator">
            <Separator className="flex-1" />
            <span className="font-mono text-xs text-text-faint">or use your email</span>
            <Separator className="flex-1" />
          </div>
        </div>
      ) : null}

      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="signup-email">email</Label>
          <Input
            id="signup-email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@school.edu"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="signup-invite">
            invite code{" "}
            <span className="font-regular text-text-faint">(optional — adds to the free allowance)</span>
          </Label>
          <Input
            id="signup-invite"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="JRA-XXXX-XXXX"
            className="font-mono"
          />
        </div>
        <div>
          <Button
            type="submit"
            disabled={sending || google}
            className="w-full bg-accent-brand text-primary-foreground hover:bg-accent-brand/90 sm:w-auto"
          >
            <Icon name="mail" size={14} />
            {sending ? "sending…" : "email me a sign-in link"}
          </Button>
        </div>
      </form>
      <FieldHint>
        We use your email for sign-in and application receipts — nothing else. Dispatch
        never sends mail in your name.
      </FieldHint>
    </Frame>
  );
}
