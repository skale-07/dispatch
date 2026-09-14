import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "../components/Icon";
import { Display, Heavy } from "../components/public/Display";
import { Eyebrow } from "../components/public/Eyebrow";
import { PanelState } from "../components/public/PanelState";
import { submitGmailOauthCode } from "./data";
import { GMAIL_PKCE_STORAGE_KEY, parseCallback, type PendingPkce } from "./gmailOauth";
import { usePageTitle } from "./usePageTitle";

/**
 * /gmail/callback (plan M19): Google sends the user back here with a code.
 * The page matches the state it stored before leaving, hands code +
 * verifier to the engine, and tells the user what happens next — the
 * engine, not this page, marks Gmail connected. A missing verifier, a
 * state mismatch or a Google error are refusals in words, never a retry.
 */

type Outcome =
  | { kind: "working" }
  | { kind: "submitted"; jobId: string | null }
  | { kind: "refused"; reason: string };

function readPending(): PendingPkce | null {
  try {
    const raw = window.sessionStorage.getItem(GMAIL_PKCE_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPkce>;
    if (typeof p.verifier !== "string" || typeof p.state !== "string" || typeof p.redirectUri !== "string") return null;
    return { verifier: p.verifier, state: p.state, redirectUri: p.redirectUri, startedAt: p.startedAt ?? "" };
  } catch {
    return null;
  }
}

export function GmailCallbackPage(): JSX.Element {
  usePageTitle("Connecting Gmail");
  const location = useLocation();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "working" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const { code, state, error } = parseCallback(location.search);
    const pending = readPending();
    try {
      window.sessionStorage.removeItem(GMAIL_PKCE_STORAGE_KEY);
    } catch {
      // storage unavailable — the verifier is used once regardless
    }
    if (error) {
      setOutcome({ kind: "refused", reason: `Google did not grant access (${error}). Nothing was connected.` });
      return;
    }
    if (!code) {
      setOutcome({ kind: "refused", reason: "this page was opened without an authorization code — start again from the integrations step." });
      return;
    }
    if (!pending) {
      setOutcome({ kind: "refused", reason: "this browser has no record of starting a Gmail connect (the verifier is gone) — start again from the integrations step." });
      return;
    }
    if (state !== pending.state) {
      setOutcome({ kind: "refused", reason: "the response did not match the request this browser made (state mismatch) — start again from the integrations step." });
      return;
    }
    void submitGmailOauthCode({ code, codeVerifier: pending.verifier, redirectUri: pending.redirectUri })
      .then((r) => setOutcome({ kind: "submitted", jobId: r.jobId }))
      .catch((err: unknown) => setOutcome({ kind: "refused", reason: err instanceof Error ? err.message : String(err) }));
  }, [location.search]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Gmail — drafts only</Eyebrow>
        <Display>
          Connecting <Heavy>your Gmail</Heavy>
        </Display>
      </div>
      <Card className="py-6">
        <CardContent className="flex flex-col gap-4 px-5 sm:px-8">
          {outcome.kind === "working" ? (
            <PanelState kind="loading" title="handing the code to the engine" body="Only the engine holds the client secret; the browser never exchanges the code itself." />
          ) : outcome.kind === "submitted" ? (
            <PanelState
              kind="empty"
              icon="check"
              title="received — the engine is connecting your mailbox"
              body={
                <>
                  Your grant is readonly + compose: Dispatch can read verification codes and write drafts in your
                  Drafts folder. It can never send. The integrations step shows <span className="font-mono">connected</span>{" "}
                  once the engine has verified the grant
                  {outcome.jobId ? <> (job <span className="font-mono">{outcome.jobId.slice(0, 8)}</span>)</> : null}.
                </>
              }
            />
          ) : (
            <PanelState kind="error" title="not connected" body={<>Refused: {outcome.reason}</>} />
          )}
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/onboarding/integrations">
                <Icon name="arrow-right" size={14} />
                back to integrations
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link to="/dashboard">dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
