import { Link, useNavigate } from "react-router-dom";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";
import { RitualCard, WhatItDoesCard } from "../components/story/StoryCards";
import {
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
} from "../lib/appConfig";

/**
 * The public landing page — the splash narrative, retargeted at a
 * student arriving from an invite link or a shared receipt. Same story
 * as the console splash (shared cards in components/story/), but the
 * call to action is an account, not a local setup, and the trust card
 * tells the hosted product's truths instead of the console's.
 *
 * Fail-closed: a build without Supabase config renders everything, but
 * the sign-up CTA is disabled with the real reason — never a dead
 * button, never a fake form.
 */
export function LandingPage(): JSX.Element {
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
          sites from a profile you write once, drafts intro emails to real
          people inside the companies, and keeps a screenshot receipt for
          everything it does in your name.
        </p>
        <div className="toolbar" style={{ margin: "0.8rem 0" }}>
          {SUPABASE_CONFIGURED ? (
            <button
              className="primary hero-cta"
              onClick={() => navigate("/signup")}
            >
              <Icon name="play" size={14} /> Sign up with an invite
            </button>
          ) : (
            <button className="primary hero-cta" disabled>
              <Icon name="play" size={14} /> Sign up with an invite
            </button>
          )}
          <Link to="/signup" className="btn-link">
            already have an account — sign in{" "}
            <Icon name="arrow-right" size={13} />
          </Link>
        </div>
        {!SUPABASE_CONFIGURED ? (
          <p className="faint flush-bottom">{SUPABASE_UNCONFIGURED_REASON}</p>
        ) : null}
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
                stores a screenshot and the confirmation text, and your
                dashboard shows them. You never have to wonder whether it
                &quot;really applied&quot; — you can look.
              </span>
            </li>
            <li>
              <Icon name="file" size={14} /> <span>
                <strong>Your words, not its guesses.</strong> Forms are
                answered only from the profile you write in onboarding.
                Nothing about you is scraped, inferred, or invented — a
                question your profile doesn&apos;t answer becomes a to-do,
                not a guess.
              </span>
            </li>
            <li>
              <Icon name="bolt" size={14} /> <span>
                <strong>A quota you can see.</strong> Your invite says how
                many applications it covers before you sign up, and the
                dashboard counts them down in plain sight. No surprise
                caps, no weekly-billed-as-monthly anything.
              </span>
            </li>
            <li>
              <Icon name="mail" size={14} /> <span>
                <strong>You send your own emails.</strong> Outreach to
                people inside a company is drafted for you to review and
                send yourself. Dispatch cannot send mail as you — that is
                built in, not a setting.
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="card">
        <h2>What the hours are worth</h2>
        <p className="muted flush-top">
          A manual application runs about 20–40 minutes. Every application
          Dispatch submits for you hands that time back — your dashboard
          keeps the honest count (real submissions only; if there&apos;s
          nothing yet, it says so). No number on this site is ever
          invented: no fake user counts, no fake testimonials, and the one
          stat we quote — 7 applications submitted in one day across 5
          different job boards — is a real September&nbsp;1 run with its
          receipts on file.
        </p>
        <p className="flush-bottom">
          <Link to="/signup" className="btn-link">
            redeem your invite <Icon name="arrow-right" size={13} />
          </Link>
        </p>
      </div>
    </>
  );
}
