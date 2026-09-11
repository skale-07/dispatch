import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";
import { RitualCard, WhatItDoesCard } from "../components/story/StoryCards";
import {
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
} from "../lib/appConfig";
import { getReferralSettings } from "./referral";
import { usePageTitle } from "./usePageTitle";

/**
 * The public landing page — the splash narrative, retargeted at a
 * student arriving from an invite link or a shared receipt. Same story
 * as the console splash (shared cards in components/story/), but the
 * call to action is an account, not a local setup, and the trust card
 * tells the hosted product's truths instead of the console's.
 *
 * One door since open signup (2026-09-11): anyone signs up and starts
 * with the free allowance; an invite code, if they have one, adds its
 * own quota on top. The free number is read from referral_settings()
 * (free_signup_quota) — never a literal in this file. The waitlist
 * mailbox (2026-09-02, D-19) is retired from the page; the table stays.
 *
 * Fail-closed: a build without Supabase config renders everything, but
 * the sign-up button is disabled with the real reason — never a dead
 * button, never a fake form.
 */
export function LandingPage(): JSX.Element {
  usePageTitle(null);
  const navigate = useNavigate();
  return (
    <>
      <div className="card hero-card">
        <div className="hero-mark" aria-hidden>
          <DispatchMark size={28} />
        </div>
        <h1 className="hero-title">Applying to jobs is a part-time job.</h1>
        <p className="muted hero-lede">
          You didn&apos;t sign up for that one. Dispatch is an agent that
          works the worst part of the hunt — the forms — while you&apos;re
          in class, at practice, or asleep. It applies on real employer
          sites from a profile you write once, drafts intro emails to real
          people inside the companies, and keeps a screenshot receipt for
          everything it does in your name.
        </p>
        <div className="toolbar stack-actions" style={{ margin: "0.8rem 0" }}>
          <button
            className="primary hero-cta"
            onClick={() => navigate("/signup")}
            disabled={!SUPABASE_CONFIGURED}
          >
            <Icon name="play" size={14} /> Start free
          </button>
          <Link to="/signup" className="btn-link">
            already have an account — sign in{" "}
            <Icon name="arrow-right" size={13} />
          </Link>
        </div>
        {!SUPABASE_CONFIGURED ? (
          <p className="faint flush-bottom">{SUPABASE_UNCONFIGURED_REASON}</p>
        ) : (
          <p className="faint flush-bottom">
            No invite needed. Have a code from a friend? Add it at sign-up
            — it adds to the free allowance.
          </p>
        )}
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
          Dispatch submits for you hands that time back, and your dashboard
          keeps the honest count — real submissions only; if there&apos;s
          nothing yet, it says so. No number on this site is invented: no
          user counts, no testimonials. The one stat we quote — 7
          applications across 5 job boards in a day — is the real
          September&nbsp;1 run, receipts on file.
        </p>
        <p className="flush-bottom">
          <Link to="/signup" className="btn-link">
            start free <Icon name="arrow-right" size={13} />
          </Link>
        </p>
      </div>

      <StartFreeCard />
    </>
  );
}

/**
 * The offer, stated from server constants: free_signup_quota from
 * referral_settings() (open signup, migration 20260911000100). Until the
 * number has loaded the copy says "free" without one — a placeholder
 * count would be an invented number, which this site never shows.
 */
function StartFreeCard(): JSX.Element {
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let alive = true;
    void getReferralSettings()
      .then((s) => {
        if (alive) setFree(s.free_signup_quota);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="card" id="start-free">
      <h2>
        {free !== null
          ? `Start with ${free} free applications`
          : "Start with free applications"}
      </h2>
      <p className="muted flush-top">
        Sign up with your email or Google, write your profile once, and
        Dispatch applies from it — real employer sites, screenshot receipt
        for every submission. An invite code from a friend adds that
        code&apos;s applications on top; friends you invite earn you more
        when they activate.
      </p>
      {error ? (
        <p className="faint">
          Could not load the current offer ({error}) — the sign-up page
          shows it once you are in.
        </p>
      ) : null}
      <div className="toolbar stack-actions flush-bottom">
        <Link to="/signup" className="btn primary">
          <Icon name="play" size={14} /> start free
        </Link>
      </div>
      {!SUPABASE_CONFIGURED ? (
        <p className="faint flush-bottom stack-sm">
          {SUPABASE_UNCONFIGURED_REASON}
        </p>
      ) : null}
    </div>
  );
}
