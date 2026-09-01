import { Link, useNavigate } from "react-router-dom";
import { DispatchMark } from "../components/DispatchMark";
import { Icon } from "../components/Icon";

/**
 * The splash page — the first thing a brand-new operator sees. It answers
 * exactly two questions before anything is configured: "what does this
 * thing do?" and "why is it safe to let it near my job applications?",
 * then hands off to the guided onboarding flow (/onboarding). Operators
 * who are already set up skip straight to Home.
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
        <h1 className="hero-title">Meet Dispatch</h1>
        <p className="muted">
          Dispatch applies to jobs for you, end to end: it pulls fresh
          postings from your JobRight feed, finds each employer&apos;s real
          application page, fills the form from a profile you wrote, and
          submits — keeping a screenshot receipt for every application that
          goes out. When something genuinely needs a human (an essay, a
          CAPTCHA, a login), it parks that application as a to-do for you
          and keeps working the rest of the queue.
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

      <div className="grid-2">
        <div className="card">
          <h2>What it does</h2>
          <ul className="setup-list">
            <li>
              <Icon name="search" size={14} /> <span>
                <strong>Discovers</strong> — reads your JobRight feed and
                queues matching postings.
              </span>
            </li>
            <li>
              <Icon name="file" size={14} /> <span>
                <strong>Fills</strong> — answers each employer form from your
                own profile and screener answers; every field is read back
                and verified before anything is submitted.
              </span>
            </li>
            <li>
              <Icon name="check" size={14} /> <span>
                <strong>Submits with receipts</strong> — one confirmed click
                per application, then a screenshot and confirmation text are
                stored as evidence.
              </span>
            </li>
            <li>
              <Icon name="mail" size={14} /> <span>
                <strong>Drafts outreach</strong> — writes referral emails to
                insiders and saves them as drafts in <em>your</em> mailbox.
                Nothing in Dispatch can send mail.
              </span>
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Why it is safe to arm</h2>
          <ul className="setup-list">
            <li>
              <Icon name="bolt" size={14} /> <span>
                <strong>Everything mutating is off by default.</strong> Form
                filling, submitting, email drafting — each sits behind its
                own flag in your <code>.env</code>, fail-closed until you
                flip it.
              </span>
            </li>
            <li>
              <Icon name="check" size={14} /> <span>
                <strong>Answers come only from you.</strong> Forms fill from
                your profile and answer bank. Demographic questions fill
                only from your own encrypted profile — never inferred, never
                defaulted.
              </span>
            </li>
            <li>
              <Icon name="stop" size={14} /> <span>
                <strong>Submitting asks first.</strong> Every submission
                requires your explicit confirmation (or a timed, capped
                session you armed yourself), and a submitted application can
                never be re-submitted.
              </span>
            </li>
            <li>
              <Icon name="alert" size={14} /> <span>
                <strong>Local only.</strong> The console binds 127.0.0.1;
                your credentials, resume, and profile stay in a gitignored
                <code> private\</code> folder on this machine.
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="card">
        <h2>Setting up takes about 15 minutes</h2>
        <p className="muted flush-top">
          Four steps: prerequisites, your candidate profile, browser logins,
          then a live verification checklist that confirms each piece before
          you start. The guided flow shows the exact command for every step
          and checks the result — it never asks you to paste credentials
          into this page.
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
