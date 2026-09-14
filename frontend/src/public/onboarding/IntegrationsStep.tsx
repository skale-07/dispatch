import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "../../auth/AuthContext";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import { LiveView } from "../../components/public/LiveView";
import { LockedPanel } from "../../components/public/LockedPanel";
import { PanelState } from "../../components/public/PanelState";
import type { EngineJobRow, FeedSampleRow, HandoffTaskRow, IntegrationRow } from "../contract";
import {
  getMyFeedSample,
  getMyIntegrations,
  handoffCancel,
  handoffUserDone,
  listMyEngineJobs,
  listMyHandoffTasks,
  requestFeedSample,
  requestHandoff,
} from "../data";
import {
  HANDOFF_POLL_CAP,
  HANDOFF_POLL_MS,
  JOBRIGHT_CHECKLIST,
  JOBRIGHT_CONNECT_KINDS,
  handoffPhase,
  integrationFor,
  integrationStatusLabel,
  isActiveHandoff,
  pickHandoff,
} from "./handoff";
import {
  GMAIL_PKCE_STORAGE_KEY,
  buildGmailConsentUrl,
  codeChallengeS256,
  defaultRedirectUri,
  randomVerifier,
  type PendingPkce,
} from "../gmailOauth";
import { StepActions, type StepProps } from "./StepChrome";

/**
 * Step 11 — integrations.
 *
 * JobRight is the USER'S OWN account (operator directive 2026-09-11;
 * never the operator's). Connecting is a handoff: the user asks, the
 * engine opens a browser it controls, the user signs in inside it (live
 * view), says "I'm signed in", and the engine verifies and seals the
 * session — the browser never marks anything connected. A soft feed
 * sample (titles only) then proves their own filters produce work.
 *
 * Gmail (drafts-only, readonly + compose; plan M19) is a PKCE consent
 * against Dispatch's own Web client: the browser holds the public client
 * id only, the engine exchanges the code and marks the integration
 * connected. Without a configured client id the card refuses by name.
 */

type Snapshot = {
  integrations: IntegrationRow[];
  tasks: HandoffTaskRow[];
  jobs: EngineJobRow[];
  sample: FeedSampleRow | null;
};

export function IntegrationsStep(props: StepProps): JSX.Element {
  const { user } = useAuth();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [integrations, tasks, jobs, sample] = await Promise.all([
        getMyIntegrations(),
        listMyHandoffTasks(),
        listMyEngineJobs(),
        getMyFeedSample(),
      ]);
      setSnap({ integrations, tasks, jobs, sample });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const jobright = snap ? integrationFor(snap.integrations, "jobright") : null;
  const task = snap ? pickHandoff(snap.tasks, JOBRIGHT_CONNECT_KINDS) : null;
  const phase = handoffPhase(task);
  const feedJob = snap?.jobs.find((j) => j.kind === "feed_sample" && (j.status === "queued" || j.status === "leased")) ?? null;
  const inFlight = isActiveHandoff(task) || feedJob !== null;

  // Bounded re-read while something is in flight (no realtime publication
  // yet): HANDOFF_POLL_CAP ticks, then it stops and says so.
  useEffect(() => {
    if (!inFlight || polls >= HANDOFF_POLL_CAP) return;
    timer.current = window.setTimeout(() => {
      setPolls((n) => n + 1);
      void refresh();
    }, HANDOFF_POLL_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [inFlight, polls, refresh]);

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setActionError(null);
    try {
      await run();
      setPolls(0);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Anything that was once connected is a RE-connect (the engine treats it
  // as a session refresh); only a never-connected account "connects".
  const connectKind =
    jobright?.status === "expired" || jobright?.status === "revoked" || jobright?.status === "connected"
      ? "jobright_reconnect"
      : "jobright_connect";

  return (
    <div className="flex flex-col gap-6">
      <Card className="py-6">
        <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Eyebrow as="h2">your JobRight account</Eyebrow>
            <Badge variant={jobright?.status === "connected" ? "secondary" : "outline"}>
              {integrationStatusLabel(jobright)}
            </Badge>
          </div>
          <p className="m-0 text-base leading-relaxed text-text-dim">
            Dispatch discovers jobs through your own JobRight filters — never anyone
            else&apos;s account. You sign in once inside a browser Dispatch opens for you;
            it keeps that session, and asks you to sign in again only when it expires.
          </p>

          {loadError ? (
            <PanelState
              kind="error"
              title="Could not read your connection status"
              body={loadError}
              action={
                <Button type="button" variant="outline" onClick={() => void refresh()}>
                  <Icon name="refresh" size={14} />
                  try again
                </Button>
              }
            />
          ) : snap === null ? (
            <PanelState kind="loading" />
          ) : (
            <>
              {actionError ? (
                <Alert variant="destructive" role="alert">
                  <Icon name="alert" size={14} />
                  <AlertDescription>
                    <p className="m-0">{actionError}</p>
                  </AlertDescription>
                </Alert>
              ) : null}

              {phase === "none" || phase === "completed" || phase === "failed" || phase === "expired" || phase === "cancelled" ? (
                <div className="flex flex-col gap-3">
                  {phase === "failed" || phase === "expired" ? (
                    <FieldHint tone="warn">
                      The last attempt {phase === "failed" ? "failed" : "expired"}
                      {task?.reason ? ` — ${task.reason}` : ""}. You can start again.
                    </FieldHint>
                  ) : null}
                  {jobright?.status !== "connected" || phase === "failed" ? (
                    <div>
                      <Button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void act("request", () => requestHandoff(connectKind))}
                      >
                        <Icon name="link" size={14} />
                        {busy === "request"
                          ? "asking…"
                          : connectKind === "jobright_reconnect"
                            ? "reconnect JobRight"
                            : "connect your JobRight"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {phase === "requested" ? (
                <div className="flex flex-col gap-3">
                  <LiveView url={null} title="JobRight sign-in" />
                  <p className="m-0 font-mono text-xs text-text-dim" role="status" aria-live="polite">
                    {polls >= HANDOFF_POLL_CAP
                      ? "still waiting for Dispatch to open a browser — the engine may be offline; refresh later"
                      : "asking Dispatch to open a browser for you…"}
                  </p>
                </div>
              ) : null}

              {phase === "live" && task ? (
                <div className="flex flex-col gap-4">
                  <LiveView url={task.live_view_url} title="JobRight sign-in" expiresAt={task.expires_at} />
                  <ol className="m-0 flex flex-col gap-2 pl-5 text-sm text-text">
                    {JOBRIGHT_CHECKLIST.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                  <div className="flex flex-wrap gap-3">
                    <Button type="button" disabled={busy !== null} onClick={() => void act("done", () => handoffUserDone(task.id))}>
                      <Icon name="check" size={14} />
                      {busy === "done" ? "handing back…" : "I'm signed in"}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void act("cancel", () => handoffCancel(task.id))}>
                      cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              {phase === "verifying" ? (
                <p className="m-0 font-mono text-xs text-text-dim" role="status" aria-live="polite">
                  checking the session Dispatch captured — a headless open of your feed has to work before this counts as connected
                </p>
              ) : null}

              {isActiveHandoff(task) && phase !== "live" && task ? (
                <div>
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("cancel", () => handoffCancel(task.id))}>
                    cancel
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="ghost" size="sm" onClick={() => void act("refresh", async () => undefined)}>
                  <Icon name="refresh" size={14} />
                  refresh
                </Button>
              </div>

              {jobright?.status === "connected" ? (
                <>
                  <Separator />
                  <FeedSampleSection
                    sample={snap.sample}
                    pending={feedJob !== null}
                    busy={busy === "sample"}
                    onSample={() => void act("sample", () => requestFeedSample())}
                  />
                </>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <GmailSection
        gmail={snap ? integrationFor(snap.integrations, "gmail") : null}
        exchangeJob={snap?.jobs.find((j) => j.kind === "gmail_exchange" && (j.status === "queued" || j.status === "leased")) ?? null}
        email={user?.email ?? null}
        onError={(m) => setActionError(m)}
      />

      <StepActions
        goBack={props.goBack}
        onNext={() => void props.goNext()}
        status={
          <p className="m-0 font-mono text-xs text-text-dim">
            {jobright?.status === "connected" ? "JobRight connected" : "you can connect JobRight later from the dashboard"}
          </p>
        }
      />
    </div>
  );
}

const GMAIL_CLIENT_ID = (import.meta.env.VITE_GMAIL_OAUTH_CLIENT_ID as string | undefined)?.trim() ?? "";
const GMAIL_REDIRECT = (import.meta.env.VITE_GMAIL_OAUTH_REDIRECT_URI as string | undefined) ?? "";

/**
 * Gmail, drafts only (plan M19). The consent is PKCE against Dispatch's
 * own Web client id; the code goes to the engine, which alone holds the
 * secret. Without a configured client id the card refuses by name.
 */
function GmailSection({
  gmail,
  exchangeJob,
  email,
  onError,
}: {
  gmail: IntegrationRow | null;
  exchangeJob: EngineJobRow | null;
  email: string | null;
  onError: (message: string) => void;
}): JSX.Element {
  const [starting, setStarting] = useState(false);
  const status = gmail?.status ?? "disconnected";
  const connecting = status === "pending_handoff" || exchangeJob !== null;

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const verifier = randomVerifier();
      const state = randomVerifier();
      const redirectUri = defaultRedirectUri(window.location.origin, GMAIL_REDIRECT);
      const pending: PendingPkce = { verifier, state, redirectUri, startedAt: new Date().toISOString() };
      window.sessionStorage.setItem(GMAIL_PKCE_STORAGE_KEY, JSON.stringify(pending));
      const codeChallenge = await codeChallengeS256(verifier);
      window.location.assign(buildGmailConsentUrl({ clientId: GMAIL_CLIENT_ID, redirectUri, state, codeChallenge, loginHint: email }));
    } catch (err) {
      setStarting(false);
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!GMAIL_CLIENT_ID) {
    return (
      <Card className="py-2">
        <CardContent className="px-5 sm:px-8">
          <LockedPanel
            title="Gmail — drafts only"
            reason="Gmail connect is not configured for this deployment (VITE_GMAIL_OAUTH_CLIENT_ID is unset). No referral drafts are written for this account, and nothing is ever sent in your name."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-6">
      <CardContent className="flex flex-col gap-4 px-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow as="h2">Gmail — drafts only</Eyebrow>
          <Badge variant={status === "connected" ? "default" : "outline"} className="font-mono">
            {connecting && status !== "connected" ? "connecting…" : integrationStatusLabel(gmail)}
          </Badge>
        </div>
        <p className="m-0 text-sm text-text-dim">
          Two permissions, both in your own account: read (verification codes from job portals) and compose
          (referral emails written into your <span className="font-mono">Drafts</span>, for you to review and send).
          Dispatch can never send mail in your name — the engine refuses any wider grant.
        </p>
        {gmail?.last_error ? (
          <Alert variant="destructive">
            <AlertDescription>{gmail.last_error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void start()} disabled={starting || (connecting && status !== "connected")}>
            <Icon name="arrow-right" size={14} />
            {status === "connected" ? "reconnect Gmail" : "connect Gmail"}
          </Button>
          <FieldHint>
            {status === "connected" && gmail?.account_email
              ? `connected as ${gmail.account_email}`
              : connecting
                ? "the engine is verifying your grant — this updates on its own"
                : "you leave for Google and come straight back here"}
          </FieldHint>
        </div>
      </CardContent>
    </Card>
  );
}

function FeedSampleSection({
  sample,
  pending,
  busy,
  onSample,
}: {
  sample: FeedSampleRow | null;
  pending: boolean;
  busy: boolean;
  onSample: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Eyebrow as="h3">a sample of your feed</Eyebrow>
      <p className="m-0 text-sm text-text-dim">
        Soft check, never a gate: a handful of titles from your own Recommended feed, so
        you can see the filters are the ones you meant.
      </p>
      {sample && sample.jobs.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {sample.jobs.slice(0, 10).map((j, i) => (
            <li key={`${j.title ?? ""}-${i}`} className="text-sm text-text">
              <span className="font-heavy">{j.title ?? "—"}</span>
              {j.company ? <span className="text-text-dim"> · {j.company}</span> : null}
              {j.location ? <span className="text-text-dim"> · {j.location}</span> : null}
            </li>
          ))}
        </ul>
      ) : sample ? (
        <FieldHint tone="warn">
          The last sample found nothing{sample.note ? ` — ${sample.note}` : ""}. Check your JobRight
          filters; applying still runs.
        </FieldHint>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy || pending} onClick={onSample}>
          <Icon name="search" size={14} />
          {pending ? "sampling…" : sample ? "sample again" : "sample my feed"}
        </Button>
        {sample ? (
          <span className="font-mono text-xs text-text-dim">
            {sample.count} found · {new Date(sample.sampled_at).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
