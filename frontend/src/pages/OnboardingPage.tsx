import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import type {
  OnboardingCheck,
  OnboardingCheckStatus,
  OnboardingStatus,
} from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";

/**
 * Guided onboarding. Every step names the exact documented CLI command,
 * and the live checks below each step verify what that command left on
 * disk — this page never collects credentials or writes a profile itself.
 * Fail-closed honesty carries into the UI: a check the server could not
 * run renders "unknown", never "ready".
 *
 * The canonical text lives in docs/operator-guide.md §0 ("One-time
 * setup"); this flow is the guided rendering of it.
 */
export function OnboardingPage(): JSX.Element {
  const status = usePoll<OnboardingStatus>(
    () => apiGet<OnboardingStatus>("/api/onboarding/status"),
    10000,
  );
  const s = status.data ?? null;
  const byId = new Map<string, OnboardingCheck>();
  for (const step of s?.steps ?? []) {
    for (const c of step.checks) byId.set(c.id, c);
  }

  return (
    <>
      <div className="page-head">
        <h1>Set up Dispatch</h1>
        <div className="sub">
          run each command in a terminal at the repo root — this page only
          verifies the result, it never stores credentials
        </div>
      </div>

      {status.error ? (
        // Fail-closed in the UI too: if the status endpoint is unreachable
        // nothing below can claim readiness — say so instead of spinning.
        <div className="banner warn">
          Could not reach the console API ({status.error}) — check results
          below are stale or missing, not passing.
        </div>
      ) : null}

      {s?.ready ? <ReadyCard /> : null}

      <StepCard
        n={1}
        title="Prerequisites"
        checks={picks(byId, ["env_file", "database_migrated", "debug_chrome"])}
      >
        <p className="muted flush-top">
          Install dependencies, the browser, and the pre-commit secret hook,
          then create the database:
        </p>
        <Cmd>{`npm install
npx playwright install chromium
npm run hooks:install
npm run migrate`}</Cmd>
        <p className="muted">
          Copy the flag file. <strong>Every ability that can change
          anything — filling forms, submitting, drafting email — is a flag
          in this file, and every flag starts off.</strong> Dispatch stays
          read-only until you deliberately flip a key in <code>.env</code>;
          nothing here needs to be enabled to finish setup.
        </p>
        <Cmd>{`copy .env.example .env`}</Cmd>
        <p className="faint flush-bottom">
          You also need Google Chrome installed — logins run in a real
          Chrome window you can see (started later, in step 3).
        </p>
      </StepCard>

      <StepCard
        n={2}
        title="Your candidate profile"
        checks={picks(byId, [
          "public_profile",
          "answer_aliases",
          "screener_bank",
          "sensitive_profile",
        ])}
      >
        <p className="muted flush-top">
          Everything Dispatch types into a form comes from files you write
          in <code>private\candidate\</code> (gitignored — it never leaves
          this machine). Copy the examples and fill in your real details:
        </p>
        <Cmd>{`copy private\\candidate\\public-profile.example.json private\\candidate\\public-profile.json
copy private\\candidate\\answer-aliases.example.json private\\candidate\\answer-aliases.json
npm run screeners:init`}</Cmd>
        <p className="muted">
          Optional: demographic (EEO) questions fill only from an encrypted
          profile you create yourself — write your answers into{" "}
          <code>private\candidate\sensitive-profile.draft.json</code>, then:
        </p>
        <Cmd>{`npm run candidate:encrypt-sensitive`}</Cmd>
        <p className="faint flush-bottom">
          With no encrypted profile, demographic fields are simply left
          blank — never guessed. Put your resume PDFs in{" "}
          <code>private\candidate\resumes\</code> while you are here.
        </p>
      </StepCard>

      <StepCard
        n={3}
        title="Browser logins"
        checks={picks(byId, [
          "jobright_session",
          "linkedin_session",
          "outlook_session",
          "gmail_token",
        ])}
      >
        <p className="muted flush-top">
          JobRight uses Google sign-in, which blocks automated browsers —
          so you sign in yourself, in a debug Chrome that Dispatch can
          attach to:
        </p>
        <Cmd>{`npm run chrome:debug:jobright`}</Cmd>
        <p className="muted">
          Sign into JobRight with Google in <em>that</em> window, then save
          the session:
        </p>
        <Cmd>{`npm run login:jobright:cdp`}</Cmd>
        <p className="muted">Optional extras, each in its own window:</p>
        <Cmd>{`npm run login:linkedin
npm run login:outlook
npm run gmail:auth -- --email <mailbox> --client-id <id> --client-secret <secret>`}</Cmd>
        <p className="faint flush-bottom">
          Gmail is a readonly OAuth grant (scope pinned to gmail.readonly)
          used only to fetch verification codes; you can also do it later
          from Settings.
        </p>
      </StepCard>

      <div className="card">
        <h2>4 · Verify everything</h2>
        <p className="muted flush-top">
          Live results, refreshed every few seconds using the same
          validation code the pipeline runs. A check the server cannot run
          says <em>unknown</em> — it is never assumed to pass. Optional
          rows inform; only required rows gate readiness.
        </p>
        {!s ? (
          <Skeleton width="16rem" />
        ) : (
          <ul className="setup-list">
            {s.steps.flatMap((step) =>
              step.checks.map((c) => <CheckRow key={c.id} check={c} />),
            )}
          </ul>
        )}
        {s && !s.ready ? (
          <p className="faint flush-bottom">
            Finish the required rows above, then this page flips to
            &quot;you&apos;re ready&quot; on its own. The full reference is{" "}
            <code>docs/operator-guide.md</code> §0 — the source of truth
            this flow follows.
          </p>
        ) : null}
      </div>

      {s?.ready ? <ReadyCard detailed /> : null}
    </>
  );
}

function picks(
  byId: Map<string, OnboardingCheck>,
  ids: string[],
): OnboardingCheck[] {
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is OnboardingCheck => c !== undefined);
}

function StepCard(props: {
  n: number;
  title: string;
  checks: OnboardingCheck[];
  children: ReactNode;
}): JSX.Element {
  const required = props.checks.filter((c) => c.required);
  const done =
    required.length > 0 && required.every((c) => c.status === "ok");
  return (
    <div className="card">
      <h2>
        {props.n} · {props.title}{" "}
        {done ? <span className="badge ok">done</span> : null}
      </h2>
      {props.children}
      {props.checks.length > 0 ? (
        <ul className="setup-list" style={{ marginTop: "0.6rem" }}>
          {props.checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const STATUS_BADGE: Record<OnboardingCheckStatus, { cls: string; text: string }> = {
  ok: { cls: "ok", text: "ready" },
  todo: { cls: "warn", text: "to do" },
  // Unknown is its own state on purpose: the server could not check, and
  // an uncheckable thing must never render as ready.
  unknown: { cls: "neutral", text: "unknown" },
};

function CheckRow({ check }: { check: OnboardingCheck }): JSX.Element {
  const badge = STATUS_BADGE[check.status];
  return (
    <li>
      <span className={`badge ${badge.cls}`}>{badge.text}</span>
      <span>
        {check.label}
        {!check.required ? <span className="faint"> (optional)</span> : null}
        <span className="faint"> — {check.detail}</span>
        {check.status !== "ok" && check.fix ? (
          <>
            <br />
            <span className="mono faint">{check.fix}</span>
          </>
        ) : null}
      </span>
    </li>
  );
}

function ReadyCard({ detailed = false }: { detailed?: boolean }): JSX.Element {
  return (
    <div className="card">
      <div className="banner ok">
        <Icon name="check" size={14} /> You&apos;re ready — every required
        check passes.
      </div>
      {detailed ? (
        <>
          <p className="muted">
            Head to the console <Link to="/">Home</Link> — one click there
            starts a supervised applying session, and the Setup card keeps
            watching these same checks. For a fully hands-off schedule from
            the terminal, the operator guide covers{" "}
            <code>npm run auto:cycle</code> (§19).
          </p>
          <p className="faint flush-bottom">
            Remember the capability ceiling: the shell that starts the
            console decides what any session may do. Applying needs{" "}
            <code>FORM_FILL_ENABLED</code>, <code>SUBMIT_ENABLED</code> and{" "}
            <code>DRY_RUN=false</code> in <code>.env</code> — all still
            off unless you flipped them.
          </p>
        </>
      ) : (
        <p className="faint flush-bottom">
          Jump to <Link to="/">the console</Link>, or review the checklist
          below.
        </p>
      )}
    </div>
  );
}

/** A copyable command block; commands are typed by the operator, never run by this page. */
function Cmd({ children }: { children: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions); the text is selectable.
    }
  };
  return (
    <div style={{ position: "relative", margin: "0.5rem 0" }}>
      <pre
        className="mono"
        style={{
          background: "var(--bg-inset)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "0.55rem 0.7rem",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {children}
      </pre>
      <button
        className="ghost"
        onClick={() => void copy()}
        style={{ position: "absolute", top: "0.3rem", right: "0.3rem" }}
        aria-label="Copy commands"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
