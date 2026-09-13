import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deriveStatus } from "@/lib/appStatus";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { PanelState } from "../../components/public/PanelState";
import { supabase } from "../../lib/supabaseClient";
import type { ApplicationRowPublic, HandoffKind, HandoffTaskRow } from "../contract";
import { listMyHandoffTasks } from "../data";
import { ACTIVE_HANDOFF_STATUSES, handoffPhase } from "../onboarding/handoff";

/**
 * "Needs you" (plan M11): the human steps the engine cannot do headlessly
 * — a JobRight sign-in, a captcha, an employer login — plus applications
 * parked on a question only the user can answer. Realtime on
 * handoff_tasks (migration 20260912000100 publishes it; RLS keeps it to
 * the user's own rows) with a manual refresh; no polling.
 */

const KIND_LABEL: Record<HandoffKind, string> = {
  jobright_connect: "Connect your JobRight account",
  jobright_reconnect: "Sign in to JobRight again",
  ats_login: "Sign in on an employer site",
  captcha: "Clear a captcha",
  gmail_connect: "Connect Gmail",
  gmail_reconnect: "Reconnect Gmail",
};

function taskLink(task: HandoffTaskRow): { to: string; label: string } | null {
  switch (task.kind) {
    case "jobright_connect":
    case "jobright_reconnect":
      return { to: "/onboarding/integrations", label: "open" };
    case "gmail_connect":
    case "gmail_reconnect":
      return { to: "/onboarding/integrations", label: "open" };
    case "ats_login":
    case "captcha":
      // The remote-browser resolution for these is a later milestone; the
      // task is shown with its reason so nothing is hidden.
      return null;
  }
}

export function NeedsYouPanel({
  applications,
  onCount,
}: {
  applications: ApplicationRowPublic[] | null;
  /** Reports the open count to the host (stat tile); null while unknown or after a failed read. */
  onCount?: (n: number | null) => void;
}): JSX.Element {
  const [tasks, setTasks] = useState<HandoffTaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");

  const load = useCallback(async (): Promise<void> => {
    try {
      setTasks(await listMyHandoffTasks());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    if (!supabase) {
      setLive("off");
      return;
    }
    // A unique topic per mount: realtime-js returns the SAME channel for a
    // repeated topic, and a remount within the previous channel's leave
    // round-trip (StrictMode in dev) would otherwise never subscribe.
    const channel = supabase
      .channel(`needs-you-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "handoff_tasks" }, () => {
        void load();
      })
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED" ? "off" : "connecting");
      });
    return () => {
      void supabase?.removeChannel(channel);
    };
  }, [load]);

  const open = (tasks ?? []).filter((t) => ACTIVE_HANDOFF_STATUSES.includes(t.status));
  const parked = (applications ?? []).filter((a) => deriveStatus(a.status, false) === "needs-you");
  const count = open.length + parked.length;
  // Report a number only once the tasks read has answered; a failed read
  // reports null so the tile says "could not count" instead of a 0.
  const known = tasks !== null && error === null;
  useEffect(() => {
    onCount?.(known ? count : null);
  }, [known, count, onCount]);

  return (
    <section aria-labelledby="needs-you-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow as="h2">
          <span id="needs-you-heading">needs you</span>
        </Eyebrow>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-text-faint">
            {live === "live" ? "live" : live === "connecting" ? "connecting…" : "manual refresh"}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
            <Icon name="refresh" size={14} />
            refresh
          </Button>
        </div>
      </div>

      {error ? (
        <PanelState kind="error" title="Could not read your tasks" body={error} />
      ) : tasks === null ? (
        <PanelState kind="loading" />
      ) : count === 0 ? (
        <PanelState
          kind="empty"
          icon="check"
          title="Nothing needs you"
          body="When Dispatch hits something only you can do — a sign-in, a captcha, a question your profile does not answer — it shows up here."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {open.map((t) => {
            const link = taskLink(t);
            const phase = handoffPhase(t);
            return (
              <li key={t.id}>
                <Card className="py-4">
                  <CardContent className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="m-0 text-sm font-heavy text-text">{KIND_LABEL[t.kind]}</p>
                      <p className="m-0 text-xs text-text-dim">
                        {t.reason ?? "opened by the engine"}
                        {phase === "live" ? " · a browser is open for you" : phase === "verifying" ? " · checking what you did" : phase === "requested" ? " · opening a browser" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{phase}</Badge>
                      {link ? (
                        <Button asChild size="sm">
                          <Link to={link.to}>
                            <Icon name="arrow-right" size={14} />
                            {link.label}
                          </Link>
                        </Button>
                      ) : (
                        <span className="font-mono text-xs text-text-faint">handled in a later release</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
          {parked.map((a) => (
            <li key={a.id}>
              <Card className="py-4">
                <CardContent className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="m-0 text-sm font-heavy text-text">
                      {a.company ?? "—"} · {a.role ?? "—"}
                    </p>
                    <p className="m-0 text-xs text-text-dim">
                      parked on {a.status.toLowerCase().replace(/_/g, " ")} — the run stopped rather than guess
                    </p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/dashboard/applications/${a.id}`}>
                      <Icon name="arrow-right" size={14} />
                      details
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
