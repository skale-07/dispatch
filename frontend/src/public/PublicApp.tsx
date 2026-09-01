import { Link, NavLink, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider } from "../auth/AuthContext";
import { DispatchMark } from "../components/DispatchMark";
import { useTheme } from "../hooks/useTheme";
import { LandingPage } from "./LandingPage";
import { SignupPage } from "./SignupPage";

/**
 * The public consumer app — what a student reaches on the internet.
 *
 * Deliberately knows nothing about the operator console: no console
 * routes, no links to it, no boot tokens, no localhost assumptions.
 * (The console mounts only in a build that sets VITE_CONSOLE_ENABLED;
 * see lib/appConfig.ts.)
 *
 * Route map grows with the build sequence:
 *   /            landing (the story + sign-up CTA)
 *   /signup      magic-link sign-up + invite redemption
 *   /invite/:c   invite link entry — lands on signup with the code
 *   /onboarding  profile wizard (protected)        [next milestone]
 *   /dashboard   applications + receipts + quota   [next milestone]
 */
export function PublicApp(): JSX.Element {
  const { theme, cycle } = useTheme();

  useEffect(() => {
    document.title = "Dispatch — job applications, done with receipts";
  }, []);

  return (
    <AuthProvider>
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
        <nav aria-label="Primary" className="public-nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            How it works
          </NavLink>
          <NavLink
            to="/signup"
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            Sign in
          </NavLink>
          <button
            className="ghost"
            onClick={cycle}
            aria-label={`Theme: ${theme}. Click to change.`}
          >
            theme: {theme}
          </button>
        </nav>
      </header>

      <main className="public-main" id="main">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/invite/:code" element={<SignupPage />} />
          <Route
            path="*"
            element={<div className="banner warn">No such page.</div>}
          />
        </Routes>
      </main>

      <footer className="public-foot">
        <span>
          receipts for everything · your words, never its guesses
        </span>
        <span className="faint">
          Dispatch drafts outreach emails for you to send — it can never
          send mail in your name.
        </span>
      </footer>
    </div>
    </AuthProvider>
  );
}
