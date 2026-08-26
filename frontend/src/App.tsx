import { Suspense, lazy, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { OverviewPage } from "./pages/OverviewPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { FillOutcomesPage } from "./pages/FillOutcomesPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { EnqueuePage } from "./pages/EnqueuePage";
import { OutreachPage } from "./pages/OutreachPage";
import { SettingsPage } from "./pages/SettingsPage";
// Charts (visx + the Bklit components) are the heaviest thing the console
// ships; the lazy route keeps them out of everyone else's first load.
const InsightsPage = lazy(() =>
  import("./pages/InsightsPage").then((m) => ({ default: m.InsightsPage })),
);
import { useTheme } from "./hooks/useTheme";
import { formatCountdown, useArmStatus } from "./hooks/useArmStatus";
import { usePoll } from "./hooks/usePoll";
import { apiGet } from "./api/client";
import type { ReviewItemView } from "./api/types";
import { DispatchMark } from "./components/DispatchMark";
import { Icon } from "./components/Icon";
import { AnimatePresence, arriveAndDepart, m } from "./components/Animated";

/**
 * Navigation is split by audience. The primary set answers what is
 * happening, what needs me, what is in flight, plus Outreach (apply
 * yourself; Dispatch only drafts emails). Operator-grade pages live
 * behind one collapsible "advanced" group so a non-technical user never
 * has to learn what a "fill outcome" is to use the product.
 */
const PRIMARY_NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/review", label: "Needs you", end: false },
  { to: "/applications", label: "Applications", end: false },
  { to: "/outreach", label: "Outreach", end: false },
  { to: "/settings", label: "Settings", end: false },
];

const ADVANCED_NAV = [
  { to: "/overview", label: "Overview" },
  { to: "/insights", label: "Insights" },
  { to: "/runs", label: "Runs" },
  { to: "/enqueue", label: "Enqueue" },
  { to: "/fill-outcomes", label: "Fill outcomes" },
];

export function App(): JSX.Element {
  const { theme, cycle } = useTheme();
  const { status: arm } = useArmStatus();
  const [advancedOpen, setAdvancedOpen] = useState(
    () => window.localStorage.getItem("dispatch.advancedNav") === "open",
  );
  const reviews = usePoll<ReviewItemView[]>(
    () => apiGet<ReviewItemView[]>("/api/review-items"),
    10000,
  );
  const needsYou = reviews.data?.length ?? 0;

  const toggleAdvanced = (): void => {
    const next = !advancedOpen;
    setAdvancedOpen(next);
    window.localStorage.setItem("dispatch.advancedNav", next ? "open" : "closed");
  };

  return (
    <div className="shell">
      {/* The first stop for a keyboard: skip the whole nav and land on
          the page content. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand" title="Dispatch — every application accounted for">
          <span className="brand-mark">
            <DispatchMark size={18} />
          </span>
          dispatch<span>·console</span>
        </div>
        <nav aria-label="Primary">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.label}
              {item.to === "/review" && needsYou > 0 ? (
                <span className="nav-count" aria-label={`${needsYou} waiting`}>
                  {needsYou}
                </span>
              ) : null}
            </NavLink>
          ))}
          <button
            className="ghost nav-group-toggle"
            onClick={toggleAdvanced}
            aria-expanded={advancedOpen}
          >
            <Icon name={advancedOpen ? "chevron-down" : "chevron-right"} size={13} />{" "}
            advanced
          </button>
          {advancedOpen
            ? ADVANCED_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `nav-advanced ${isActive ? "active" : ""}`
                  }
                >
                  {item.label}
                </NavLink>
              ))
            : null}
        </nav>
        <div className="spacer" />
        <button
          className="ghost"
          onClick={cycle}
          aria-label={`Theme: ${theme}. Click to change.`}
          style={{ textAlign: "left" }}
        >
          theme: {theme}
        </button>
        <div className="foot">
          every application accounted for
          <br />
          localhost only · mutations need the boot token
        </div>
      </aside>

      <main className="main" id="main">
        <AnimatePresence initial={false}>
          {arm?.armed ? (
            // Arming/disarming is exactly the state change motion exists
            // for — the banner slides in when a session goes live and
            // collapses away when it ends.
            <m.div key="armed" {...arriveAndDepart}>
              <Link
                to="/"
                className="armed-banner"
                title="An unattended session is live"
              >
                <Icon name="bolt" size={13} /> Dispatch is applying — {formatCountdown(arm.seconds_remaining)} left ·{" "}
                {arm.submits_used}/{arm.max_submits} submitted · {arm.apps_started}/
                {arm.max_apps} worked
              </Link>
            </m.div>
          ) : null}
        </AnimatePresence>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/enqueue" element={<EnqueuePage />} />
          <Route path="/outreach" element={<OutreachPage />} />
          <Route path="/fill-outcomes" element={<FillOutcomesPage />} />
          <Route
            path="/insights"
            element={
              <Suspense fallback={<p className="faint">Loading insights…</p>}>
                <InsightsPage />
              </Suspense>
            }
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={<div className="banner warn">No such page.</div>}
          />
        </Routes>
      </main>
    </div>
  );
}
