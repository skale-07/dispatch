import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Display, Heavy } from "../components/public/Display";
import { Eyebrow } from "../components/public/Eyebrow";
import { FieldHint } from "../components/public/FieldHint";
import { PanelState } from "../components/public/PanelState";
import type { IntegrationRow } from "./contract";
import { getMyEngineControls, getMyIntegrations, setEnginePaused, setMyIntegration } from "./data";
import { integrationFor, integrationStatusLabel } from "./onboarding/handoff";
import { clearMySelfId } from "./selfId";
import { usePageTitle } from "./usePageTitle";

/**
 * /settings (plan M11): the account-level switches that are not profile
 * answers — pause the engine, disconnect JobRight, clear self-ID, sign
 * out. Every destructive action is a two-click confirm in place (never a
 * browser dialog), and every outcome is the server's own answer.
 */

type Confirm = "disconnect" | "clear-self-id" | null;

export function SettingsPage(): JSX.Element {
  usePageTitle("Settings");
  const { user, signOut } = useAuth();
  const [paused, setPaused] = useState<boolean | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const load = async (): Promise<void> => {
    try {
      const [c, i] = await Promise.all([getMyEngineControls(), getMyIntegrations()]);
      setPaused(c?.paused ?? false);
      setIntegrations(i);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (label: string, run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(label);
    setNotice(null);
    setConfirm(null);
    try {
      await run();
      setNotice({ tone: "ok", text: done });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const jobright = integrations ? integrationFor(integrations, "jobright") : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Eyebrow>your account</Eyebrow>
        <Display as="h1" size="section">
          <Heavy>Settings</Heavy>
        </Display>
        <p className="m-0 text-sm text-text-dim">{user?.email ?? "your account"}</p>
      </header>

      {notice ? (
        <Alert variant={notice.tone === "error" ? "destructive" : "default"} role={notice.tone === "error" ? "alert" : "status"}>
          <Icon name={notice.tone === "error" ? "alert" : "check"} size={14} />
          <AlertDescription>
            <p className="m-0">{notice.text}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {loadError ? <PanelState kind="error" title="Could not load your settings" body={loadError} /> : null}

      <Card className="py-6">
        <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
          <Eyebrow as="h2">the engine</Eyebrow>
          <div className="flex min-h-11 items-start gap-3">
            <Checkbox
              id="engine-paused"
              checked={paused === true}
              disabled={paused === null || busy !== null}
              onCheckedChange={(c: boolean | "indeterminate") =>
                void act("pause", () => setEnginePaused(c === true), c === true ? "Paused. Nothing new is queued for you until you unpause." : "Unpaused. The planner may queue work for you again.")
              }
            />
            <Label htmlFor="engine-paused" className="font-regular leading-relaxed">
              Pause Dispatch for my account. Nothing new is queued while this is on; anything
              already submitted keeps its receipt.
            </Label>
          </div>

          <Separator />
          <Eyebrow as="h2">JobRight</Eyebrow>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant={jobright?.status === "connected" ? "secondary" : "outline"}>{integrationStatusLabel(jobright)}</Badge>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/onboarding/integrations">
                  <Icon name="link" size={14} />
                  manage connection
                </Link>
              </Button>
              {jobright && jobright.status !== "disconnected" ? (
                confirm === "disconnect" ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void act("disconnect", () => setMyIntegration("jobright", { disconnect: true }), "JobRight disconnected. The stored session was deleted; Dispatch will not apply for you until you connect again.")}
                  >
                    click again to disconnect
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirm("disconnect")}>
                    disconnect
                  </Button>
                )
              ) : null}
            </div>
          </div>
          <FieldHint>
            Disconnecting deletes the captured JobRight session from Dispatch. Your JobRight
            account itself is untouched.
          </FieldHint>

          <Separator />
          <Eyebrow as="h2">self-identification</Eyebrow>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/onboarding/self-id">
                <Icon name="arrow-right" size={14} />
                review my answers
              </Link>
            </Button>
            {confirm === "clear-self-id" ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy !== null}
                onClick={() => void act("clear", () => clearMySelfId(), "Self-identification answers cleared. Those questions become per-application to-dos.")}
              >
                click again to clear everything
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirm("clear-self-id")}>
                clear my answers
              </Button>
            )}
          </div>
          <FieldHint>
            Stored encrypted, readable only by your own applications. Clearing removes the row
            entirely — nothing is kept or aggregated.
          </FieldHint>

          <Separator />
          <Eyebrow as="h2">account</Eyebrow>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/onboarding">edit your profile</Link>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
              sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
