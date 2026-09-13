import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { LockedPanel } from "../../components/public/LockedPanel";
import { PanelState } from "../../components/public/PanelState";
import type { IntegrationRow, OutreachDraftRow } from "../contract";
import { getMyIntegrations, listMyOutreachDrafts } from "../data";
import { integrationFor } from "../onboarding/handoff";

/**
 * The referral drafter (plan M11): runs only when JobRight Premium AND
 * Gmail are both connected. Locked, it names the gate that refused —
 * "Refused: Gmail not connected" — never a greyed-out mystery. Unlocked,
 * it lists the drafts waiting in the user's own Gmail (outreach_drafts
 * holds that a draft exists and its subject; the body never leaves the
 * engine) with a link into Gmail. Dispatch never sends.
 */
export function ReferralDrafterPanel(): JSX.Element {
  const [integrations, setIntegrations] = useState<IntegrationRow[] | null>(null);
  const [drafts, setDrafts] = useState<OutreachDraftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getMyIntegrations(), listMyOutreachDrafts()])
      .then(([i, d]) => {
        if (!alive) return;
        setIntegrations(i);
        setDrafts(d);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const jobright = integrations ? integrationFor(integrations, "jobright") : null;
  const gmail = integrations ? integrationFor(integrations, "gmail") : null;
  const premium = jobright?.premium === true;
  const gmailOn = gmail?.status === "connected";

  return (
    <section aria-labelledby="drafter-heading" className="flex flex-col gap-4">
      <Eyebrow as="h2">
        <span id="drafter-heading">referral drafts</span>
      </Eyebrow>
      {error ? (
        <PanelState kind="error" title="Could not read the drafter's status" body={error} />
      ) : integrations === null ? (
        <PanelState kind="loading" />
      ) : !premium || !gmailOn ? (
        <LockedPanel
          title="Referral drafting is off"
          reason={
            !premium && !gmailOn
              ? "JobRight Premium not detected and Gmail not connected. Drafting needs both."
              : !premium
                ? "JobRight Premium not detected. Drafts use the insider contacts Premium unlocks."
                : "Gmail not connected. Drafts are written into your own Gmail Drafts folder and never sent."
          }
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={premium ? "/onboarding/integrations" : "/onboarding/persona"}>
                <Icon name="arrow-right" size={14} />
                {premium ? "connect Gmail" : "set up on the persona step"}
              </Link>
            </Button>
          }
        />
      ) : drafts === null || drafts.length === 0 ? (
        <PanelState
          kind="empty"
          icon="mail"
          title="No drafts yet"
          body="After a submission, Dispatch finds a real person inside the company and writes a short intro into your Gmail Drafts — for you to read and send."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {drafts.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="m-0 text-sm font-heavy text-text">{d.subject ?? "(no subject recorded)"}</p>
                <p className="m-0 text-xs text-text-dim">
                  {[d.company, d.contact_name].filter(Boolean).join(" · ") || "—"} ·{" "}
                  {new Date(d.created_at).toLocaleDateString()}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={14} />
                  open Gmail drafts
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
