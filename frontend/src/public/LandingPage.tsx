import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";
import { RitualCard, WhatItDoesCard } from "../components/story/StoryCards";
import {
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
} from "../lib/appConfig";
import { joinWaitlist, type WaitlistOutcome } from "./data";
import { usePageTitle } from "./usePageTitle";

/**
 * The public landing page — the splash narrative, retargeted at a
 * student arriving from an invite link or a shared receipt. Same story
 * as the console splash (shared cards in components/story/), but the
 * call to action is an account, not a local setup, and the trust card
 * tells the hosted product's truths instead of the console's.
 *
 * Two doors, because two kinds of visitor arrive: someone holding an
 * invite (sign up now) and someone who just saw a receipt in a group
 * chat (join the waitlist — the schema's anon-insert mailbox). Before
 * the waitlist form, the second visitor had no path at all (QA
 * 2026-09-02, D-19).
 *
 * Fail-closed: a build without Supabase config renders everything, but
 * both forms are disabled with the real reason — never a dead button,
 * never a fake form.
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
            <Icon name="play" size={14} /> Sign up with an invite
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
            No invite yet? <a href="#waitlist">Join the waitlist</a> — it&apos;s
            one email field, further down.
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
            redeem your invite <Icon name="arrow-right" size={13} />
          </Link>
        </p>
      </div>

      <WaitlistCard />
    </>
  );
}

/**
 * The second door. Invites are minted by hand right now, so this is a
 * mailbox and says so — no fake position counter, no "you're #1,204"
 * until a ladder exists server-side (college-launch.md §4 asks for one;
 * the ask is in the storefront report).
 */
function WaitlistCard(): JSX.Element {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<WaitlistOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await joinWaitlist(email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="waitlist">
      <h2>No invite? Join the waitlist</h2>
      {done ? (
        <div className="banner ok flush-bottom" role="status">
          <Icon name="check" size={14} />{" "}
          {done === "joined"
            ? "You're on the list. Invites go out in small batches this September — you'll get an email with a code and the number of applications it covers."
            : "That address is already on the list — nothing to do. Invites go out in small batches this September."}
        </div>
      ) : (
        <>
          <p className="muted flush-top">
            Invites are hand-minted in small batches while the queue is
            small — your school email helps us prioritize campuses. We
            store the address and nothing else, and never sell it.
          </p>
          {error ? (
            <div className="banner danger" role="alert">
              {error}
            </div>
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
                disabled={!SUPABASE_CONFIGURED}
              />
            </label>
            <div className="toolbar stack-actions flush-bottom">
              <button
                className="primary"
                type="submit"
                disabled={busy || !SUPABASE_CONFIGURED}
              >
                <Icon name="mail" size={14} />{" "}
                {busy ? "adding you…" : "put me on the list"}
              </button>
            </div>
          </form>
          {!SUPABASE_CONFIGURED ? (
            <p className="faint flush-bottom stack-sm">
              {SUPABASE_UNCONFIGURED_REASON}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
