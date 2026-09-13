import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APP_STATUS, deriveStatus, type AppStatus } from "@/lib/appStatus";
import { cn } from "@/lib/utils";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { PanelState } from "../../components/public/PanelState";
import type { ApplicationRowPublic } from "../contract";
import { receiptUrl } from "../data";

/**
 * Every application, accounted for (plan M11): the console's one status
 * vocabulary (lib/appStatus.ts), tabs by what the user cares about, a
 * table from `sm` up and cards below it, and the receipt — a screenshot
 * in a private bucket — shown in a dialog from a short-lived signed URL.
 * Nothing is counted that did not happen.
 */

type Tab = "all" | "submitted" | "needs-you" | "working";

function tabOf(status: AppStatus): Tab {
  if (status === "submitted") return "submitted";
  if (status === "needs-you") return "needs-you";
  return "working";
}

const TONE_CLASS: Record<AppStatus, string> = {
  queued: "border-border text-text-dim",
  filling: "border-accent-brand/40 text-accent-brand",
  ready: "border-accent-brand/40 text-accent-brand",
  submitted: "border-ok/40 text-ok",
  "needs-you": "border-warn/40 text-warn",
  failed: "border-danger/40 text-danger",
};

export function StatusBadge({ row }: { row: ApplicationRowPublic }): JSX.Element {
  const status = deriveStatus(row.status, false);
  const p = APP_STATUS[status];
  return (
    <Badge variant="outline" className={cn("gap-1", TONE_CLASS[status])} title={p.hint}>
      <Icon name={p.icon} size={11} />
      {p.label}
    </Badge>
  );
}

export function ApplicationsPanel({
  applications,
  loading,
  error,
  onRetry,
  onboardingDone,
}: {
  applications: ApplicationRowPublic[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onboardingDone: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("all");
  const rows = applications ?? [];
  const counts: Record<Tab, number> = { all: rows.length, submitted: 0, "needs-you": 0, working: 0 };
  for (const a of rows) counts[tabOf(deriveStatus(a.status, false))] += 1;
  const shown = rows.filter((a) => tab === "all" || tabOf(deriveStatus(a.status, false)) === tab);

  return (
    <section aria-labelledby="applications-heading" className="flex flex-col gap-4">
      <Eyebrow as="h2">
        <span id="applications-heading">every application, accounted for</span>
      </Eyebrow>

      {loading && applications === null ? <PanelState kind="loading" /> : null}
      {!loading && applications === null ? (
        <PanelState
          kind="error"
          title="Couldn't load your applications"
          body={`${error ?? "the read failed"} — the numbers above show only what did load, never a guess.`}
          action={
            <Button type="button" variant="outline" onClick={onRetry}>
              <Icon name="refresh" size={14} />
              try again
            </Button>
          }
        />
      ) : null}
      {!loading && applications !== null && applications.length === 0 ? (
        <PanelState
          kind="empty"
          title="Nothing here yet"
          body={
            onboardingDone
              ? "Your profile is finished. Dispatch's next run picks it up, and each application it submits lands here with a screenshot receipt — nothing is counted until it really happened."
              : "Applications appear here — each with a screenshot receipt — once your profile is finished. Dispatch does not apply from a half-finished profile."
          }
          action={
            onboardingDone ? undefined : (
              <Button asChild>
                <Link to="/onboarding">finish your profile</Link>
              </Button>
            )
          }
        />
      ) : null}

      {applications !== null && applications.length > 0 ? (
        <Tabs value={tab} onValueChange={(v: string) => setTab(v as Tab)}>
          <TabsList className="flex w-full flex-wrap justify-start">
            {(["all", "submitted", "needs-you", "working"] as const).map((t) => (
              <TabsTrigger key={t} value={t} className="font-mono text-xs">
                {t === "needs-you" ? "needs you" : t}
                <span className="text-text-faint"> {counts[t]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={tab} className="mt-4">
            {shown.length === 0 ? (
              <PanelState kind="empty" title={`Nothing under “${tab === "needs-you" ? "needs you" : tab}”`} />
            ) : (
              <>
                {/* phone: cards */}
                <ul className="m-0 flex list-none flex-col gap-3 p-0 sm:hidden">
                  {shown.map((a) => (
                    <li key={a.id} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="m-0 text-sm font-heavy text-text">{a.company ?? "—"}</p>
                          <p className="m-0 text-sm text-text-dim">{a.role ?? "—"}</p>
                        </div>
                        <StatusBadge row={a} />
                      </div>
                      <p className="m-0 font-mono text-xs text-text-dim">
                        {a.source_ats ?? "—"}
                        {a.submitted_at ? ` · submitted ${new Date(a.submitted_at).toLocaleDateString()}` : ""}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <ReceiptButton row={a} />
                        <Button asChild size="sm" variant="ghost">
                          <Link to={`/dashboard/applications/${a.id}`}>details</Link>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                {/* sm+: table */}
                <div className="hidden overflow-x-auto sm:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>company</TableHead>
                        <TableHead>role</TableHead>
                        <TableHead>status</TableHead>
                        <TableHead>via</TableHead>
                        <TableHead>submitted</TableHead>
                        <TableHead>receipt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="font-heavy">{a.company ?? "—"}</TableCell>
                          <TableCell className="max-w-48 truncate lg:max-w-xs">
                            <Link to={`/dashboard/applications/${a.id}`} className="text-text">
                              {a.role ?? "—"}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <StatusBadge row={a} />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{a.source_ats ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <ReceiptButton row={a} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      ) : null}
    </section>
  );
}

/**
 * Receipts live in a private bucket; the URL is minted on demand (10
 * minutes) and the image shown in a dialog — one attempt per click, the
 * real error inline. No receipt stored says so.
 */
export function ReceiptButton({ row }: { row: ApplicationRowPublic }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!row.receipt_path) {
    return <span className="whitespace-nowrap font-mono text-xs text-text-faint">none stored</span>;
  }
  const path = row.receipt_path;

  const show = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setUrl(await receiptUrl(path));
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void show()}>
        <Icon name="file" size={14} />
        {busy ? "opening…" : "receipt"}
      </Button>
      {error ? (
        <span role="alert" className="font-mono text-xs text-danger">
          {error}
        </span>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-heavy">
              {row.company ?? "—"} · {row.role ?? "—"}
            </DialogTitle>
            <DialogDescription>
              The screenshot Dispatch stored the moment this was submitted
              {row.submitted_at ? ` (${new Date(row.submitted_at).toLocaleString()})` : ""}.
            </DialogDescription>
          </DialogHeader>
          {url ? (
            <img src={url} alt={`Submission receipt for ${row.company ?? "this application"}`} className="w-full rounded-md border border-border" />
          ) : null}
          {url ? (
            <Button asChild variant="outline" size="sm" className="self-start">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={14} />
                open full size
              </a>
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
