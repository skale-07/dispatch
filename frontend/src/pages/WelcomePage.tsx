import { Suspense, lazy } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";
import { RitualCard, WhatItDoesCard } from "../components/story/StoryCards";

// Same rule as App.tsx's Insights route: charts (visx) are the heaviest
// thing the console ships, and /welcome is the very first page a curious
// person loads — the time-saved section arrives lazily so the story
// renders instantly.
const TimeSaved = lazy(() =>
  import("../components/TimeSaved").then((m) => ({ default: m.TimeSaved })),
);

/**
 * The splash page — the first thing a brand-new person sees, and the page
 * a curious student lands on. It tells the true story in their voice:
 * the job hunt's worst part is a part-time job of form-filling, Dispatch
 * does that part while you live your life, and it proves everything with
 * receipts. Everything factual on this page is real (a claim that cannot
 * be backed by an artifact does not belong here — no invented user
 * counts, no fake testimonials). Hands off to /onboarding; operators who
 * are already set up skip straight to Home.
 */
export function WelcomePage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <>
      <div className="card hero-card">
        <div
          style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}
          aria-hidden
        >
          <DispatchMark size={28} />
        </div>
        <h1 className="hero-title">Applying to jobs is a part-time job.</h1>
        <p className="muted" style={{ fontSize: "var(--text-md)" }}>
          You didn&apos;t sign up for that one. Dispatch is an agent that
          works the worst part of the hunt — the forms — while you&apos;re
          in class, at practice, or asleep. It applies on real employer
          sites from a profile you wrote once, drafts intro emails to real
          people inside the companies, and keeps a screenshot receipt for
          everything it does in your name.
        </p>
        <div className="toolbar" style={{ margin: "0.8rem 0" }}>
          <button
            className="primary hero-cta"
            onClick={() => navigate("/onboarding")}
          >
            <Icon name="play" size={14} /> Set up Dispatch
          </button>
          <Link to="/" className="btn-link">
            already set up — open the console <Icon name="arrow-right" size={13} />
          </Link>
        </div>
      </div>

      <RitualCard />

      <div className="grid-2">
        <WhatItDoesCard />

        <div className="card">
          <h2>Why you can let it near your name</h2>
          <ul className="setup-list">
            <li>
              <Icon name="check" size={14} /> <span>
                <strong>Receipts for everything.</strong> Every submission
                stores a screenshot and the confirmation text. You never
                have to wonder whether it &quot;really applied&quot; — you
                can look.
              </span>
            </li>
            <li>
              <Icon name="stop" size={14} /> <span>
                <strong>Everything is off until you turn it on.</strong>
                {" "}Filling, submitting, email drafting — each sits behind
                its own switch, off by default. Submitting asks you first
                (or runs inside a timed, capped session you armed
                yourself), and nothing submits twice.
              </span>
            </li>
            <li>
              <Icon name="file" size={14} /> <span>
                <strong>Your words, not its guesses.</strong> Forms fill
                only from answers you wrote. Demographic questions fill
                only from your own encrypted answers or stay blank —
                never inferred, never defaulted.
              </span>
            </li>
            <li>
              <Icon name="alert" size={14} /> <span>
                <strong>Runs on your machine, full stop.</strong> The
                console binds to localhost; your resume, profile, and
                logins never leave your laptop. There is no server, no
                account, nothing to breach.
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="card">
        <h2>The hours, given back</h2>
        <p className="muted flush-top">
          This section is live from your own database — real submissions,
          real receipts, and the form-filling time you got back (an average
          manual application runs 20–40 minutes). If there&apos;s nothing
          here yet, it says so; nothing on this page is ever made up.
        </p>
        <Suspense fallback={<p className="faint">loading the numbers…</p>}>
          <TimeSaved />
        </Suspense>
      </div>

      <div className="card">
        <h2>Setting up takes about 15 minutes</h2>
        <p className="muted flush-top">
          Four steps: prerequisites, your profile (write your answers once,
          ever), browser logins, then a live checklist that verifies each
          piece before anything runs. The guided flow shows the exact
          command for every step and checks the result — it never asks you
          to paste credentials into a web page.
        </p>
        <p className="flush-bottom">
          <Link to="/onboarding" className="btn-link">
            start the guided setup <Icon name="arrow-right" size={13} />
          </Link>
        </p>
      </div>
    </>
  );
}
