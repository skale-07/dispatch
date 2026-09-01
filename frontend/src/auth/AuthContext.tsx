import type { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import { SUPABASE_CONFIGURED, SUPABASE_UNCONFIGURED_REASON } from "../lib/appConfig";
import { supabase } from "../lib/supabaseClient";

/**
 * Session state for the public app, from the one Supabase seam.
 *
 * `loading` is true until the client has answered getSession() once —
 * protected routes render a quiet placeholder during that window instead
 * of bouncing a signed-in user through /signup on every hard refresh.
 * In an unconfigured build there is no client; loading resolves false
 * and `configured` carries the reason to every consumer.
 */

type AuthState = {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState>({
  configured: false,
  loading: false,
  session: null,
  user: null,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(SUPABASE_CONFIGURED);

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
