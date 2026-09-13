import { useNavigate } from "react-router-dom";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { APP_STATUS, deriveStatus } from "@/lib/appStatus";
import type { ApplicationRowPublic } from "../contract";
import { ReceiptButton, StatusBadge } from "./ApplicationsPanel";

/**
 * /dashboard/applications/:id — one application, as a sheet over the
 * dashboard: what it is, where it stands in the one status vocabulary
 * (with the sentence that explains it), when the engine last touched it,
 * and the receipt. Closing returns to /dashboard.
 */
export function ApplicationSheet({ row }: { row: ApplicationRowPublic | null }): JSX.Element {
  const navigate = useNavigate();
  const status = row ? deriveStatus(row.status, false) : null;
  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open: boolean) => {
        if (!open) navigate("/dashboard");
      }}
    >
      <SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
        {row ? (
          <>
            <SheetHeader className="gap-2 text-left">
              <SheetTitle className="font-heavy">
                {row.company ?? "—"} · {row.role ?? "—"}
              </SheetTitle>
              <SheetDescription>
                {status ? APP_STATUS[status].hint : ""}
              </SheetDescription>
            </SheetHeader>
            <dl className="m-0 flex flex-col">
              {[
                ["status", <StatusBadge key="s" row={row} />],
                ["via", <span key="v" className="font-mono">{row.source_ats ?? "—"}</span>],
                ["route", <span key="r" className="font-mono">{row.route ?? "—"}</span>],
                ["submitted", row.submitted_at ? new Date(row.submitted_at).toLocaleString() : "—"],
                ["last engine update", row.engine_updated_at ? new Date(row.engine_updated_at).toLocaleString() : "—"],
                ["raw state", <span key="raw" className="font-mono text-xs">{row.status}</span>],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex items-baseline justify-between gap-4 border-b border-border py-2">
                  <dt className="m-0 font-mono text-xs uppercase tracking-widest text-text-dim">{k}</dt>
                  <dd className="m-0 text-sm text-text">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <ReceiptButton row={row} />
            </div>
            {status === "needs-you" ? (
              <p className="m-0 text-sm text-text-dim">
                The run stopped here rather than guess. Questions the profile could answer show
                up under <span className="font-heavy text-text">suggested for you</span> on the
                dashboard; a sign-in or captcha appears under{" "}
                <span className="font-heavy text-text">needs you</span>.
              </p>
            ) : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
