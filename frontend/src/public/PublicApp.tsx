import { Link, NavLink, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "../auth/AuthContext";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";
import { useTheme } from "../hooks/useTheme";
import { LandingPage } from "./LandingPage";
import { SignupPage } from "./SignupPage";
import { OnboardingPage } from "./onboarding/OnboardingPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { SettingsPage } from "./SettingsPage";
import { usePageTitle } from "./usePageTitle";

/**
 * The public consumer app — what a student reaches on the internet.
 *
 * Deliberately knows nothing about the operator console: no console
 * routes, no links to it, no boot tokens, no localhost assumptions.
 * (The console mounts only in a build that sets VITE_CONSOLE_ENABLED;
 * see lib/appConfig.ts.)
 *
 * Route map:
 *   /            landing (the story + sign-up CTA)
 *   /signup      magic-link sign-up + invite redemption
 *   /redeem      minted invite links (?code=JRA-XXXX-XXXX, per contract)
 *   /invite/:c   invite link entry — alias for the same page
 *   /onboarding/:step  the 13-step wizard (protected); bare /onboarding
 *                      resumes at the saved step
 *   /dashboard   needs-you · quota · applications + receipts · suggestions
 *                · referral drafter (protected)
 *   /dashboard/applications/:id  one application as a sheet over the dashboard
 *   /settings    pause the engine, disconnect JobRight, clear self-ID, sign out
 */
export function PublicApp(): JSX.Element {
  return (
    <AuthProvider>
      <PublicChrome />
    </AuthProvider>
  );
}

/** Shell + routes; a separate component so the nav can read the session. */
function PublicChrome(): JSX.Element {
  const { theme, cycle } = useTheme();
  const { session } = useAuth();

  return (
    <div className="public-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="public-topbar">
        <Link to="/" className="brand public-brand" aria-label="Dispatch home">
          <span className="brand-mark">
            <DispatchMark size={18} />
          </span>
          dispatch
        </Link>
        {/* Two links, never more: on a 390px phone a third item wrapped the
            bar onto two rows with the brand stranded on its own line (QA
            2026-09-02, D-01). Signed in, the brand mark is the way back to
            the story; the theme switch lives in the footer. */}
        <nav aria-label="Primary" className="public-nav">
          {session ? (
            <>
              <NavLink
                to="/dashboard"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                Dashboard
              </NavLink>
              <NavLink
                to="/onboarding"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                Profile
              </NavLink>
            </>
          ) : (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
                How it works
              </NavLink>
              <NavLink
                to="/signup"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                Sign in
              </NavLink>
            </>
          )}
        </nav>
      </header>

      <main className="public-main" id="main">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/redeem" element={<SignupPage />} />
          <Route path="/invite/:code" element={<SignupPage />} />
          <Route
            path="/onboarding/:step?"
            element={
              <RequireAuth>
                <OnboardingPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard/applications/:id"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<NotFoundPage signedIn={session !== null} />} />
        </Routes>
      </main>

      <footer className="public-foot">
        <span>receipts for everything · your words, never its guesses</span>
        <span className="faint">
          Dispatch drafts outreach emails for you to send — it can never
          send mail in your name.
        </span>
        <button
          className="ghost public-theme"
          onClick={cycle}
          aria-label={`Theme: ${theme}. Click to change.`}
        >
          theme: {theme}
        </button>
      </footer>
    </div>
  );
}

/**
 * A wrong URL is the most likely first page a student sees from a
 * mistyped invite link, so it gets a heading, a way home, and the two
 * places they were probably headed — not a bare yellow banner (D-08).
 */
function NotFoundPage({ signedIn }: { signedIn: boolean }): JSX.Element {
  usePageTitle("Page not found");
  return (
    <div className="card max-w-lg">
      <h1 className="hero-title">There&apos;s no page here</h1>
      <p className="muted flush-top">
        The link may be incomplete. Invite links look like{" "}
        <code>/redeem?code=JRA-XXXX-XXXX</code> — if yours was cut off, ask
        the person who sent it to resend the whole thing.
      </p>
      <div className="toolbar stack-actions flush-bottom">
        {signedIn ? (
          <Link to="/dashboard" className="btn">
            <Icon name="arrow-right" size={13} /> your dashboard
          </Link>
        ) : (
          <Link to="/signup" className="btn">
            <Icon name="arrow-right" size={13} /> sign up or sign in
          </Link>
        )}
        <Link to="/" className="btn-link">
          how Dispatch works
        </Link>
      </div>
    </div>
  );
}
