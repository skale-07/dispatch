import type { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import { SUPABASE_CONFIGURED, SUPABASE_UNCONFIGURED_REASON } from "../lib/appConfig";
import { supabase } from "../lib/supabaseClient";
import { ensureMember } from "../public/data";
import { describeAuthError, readAuthErrorFromUrl, stripAuthErrorFromUrl } from "./authError";

/**
 * Session state for the public app, from the one Supabase seam.
 *
 * `loading` is true until the client has answered getSession() once —
 * protected routes render a quiet placeholder during that window instead
 * of bouncing a signed-in user through /signup on every hard refresh.
 * In an unconfigured build there is no client; loading resolves false
 * and `configured` carries the reason to every consumer.
 *
 * Membership (open signup, 20260911000100): the first time a session
 * appears for a user id, ensure_member() runs exactly once. Its outcome
 * is exposed as `membership` so the dashboard can show the real reason
 * when the account row could not be created — never a silent "not a
 * member" and never a retry loop (the user reloads to try again).
 */

export type Membership =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "member"; created: boolean; freeSignupQuota: number }
  | { status: "failed"; reason: string };

type AuthState = {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  membership: Membership;
  /**
   * A provider sign-in that failed after the hop, read once from the URL
   * Supabase sent the user back to (see authError.ts). The signup page
   * shows it; anything else may ignore it. Cleared by the next attempt.
   */
  authError: string | null;
  clearAuthError: () => void;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState>({
  configured: false,
  loading: false,
  session: null,
  user: null,
  membership: { status: "idle" },
  authError: null,
  clearAuthError: () => {},
  signOut: async () => {},
});

/** Read (and strip) a callback error from the current URL, once, at first render. */
function takeAuthErrorFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const found = readAuthErrorFromUrl(window.location);
  if (!found) return null;
  window.history.replaceState(window.history.state, "", stripAuthErrorFromUrl(window.location));
  return describeAuthError(found);
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(SUPABASE_CONFIGURED);
  const [membership, setMembership] = useState<Membership>({ status: "idle" });
  const [authError, setAuthError] = useState<string | null>(takeAuthErrorFromLocation);
  const ensuredFor = useRef<string | null>(null);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      ensuredFor.current = null;
      setMembership({ status: "idle" });
      return;
    }
    if (ensuredFor.current === userId) return;
    ensuredFor.current = userId;
    let alive = true;
    setMembership({ status: "pending" });
    void ensureMember()
      .then((m) => {
        if (alive) {
          setMembership({
            status: "member",
            created: m.created,
            freeSignupQuota: m.free_signup_quota,
          });
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setMembership({
            status: "failed",
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (alive) setSession(next);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    configured: SUPABASE_CONFIGURED,
    loading,
    session,
    user: session?.user ?? null,
    membership,
    authError,
    clearAuthError: () => setAuthError(null),
    signOut: async () => {
      await supabase?.auth.signOut();
    },
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}

/**
 * Route guard. Unconfigured build: the honest reason, not a redirect
 * loop. Signed out: to /signup, remembering where the user was headed so
 * the post-login hop returns there.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { configured, loading, session } = useAuth();
  const location = useLocation();

  if (!configured) {
    return <div className="banner warn">{SUPABASE_UNCONFIGURED_REASON}</div>;
  }
  if (loading) {
    return <p className="faint">checking your session…</p>;
  }
  if (!session) {
    return <Navigate to="/signup" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
