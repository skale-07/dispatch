import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "../Icon";

/**
 * Every panel's non-happy state, in one place, so the public app never
 * hand-rolls an empty message or a spinner. Four kinds:
 *   empty   — nothing to show yet; says so honestly (never a fake zero)
 *   loading — skeleton rows, no text (nothing to read yet)
 *   error   — what failed, in the user's terms, plus a retry if given
 *   locked  — a feature that refused, naming the reason
 * Icons are decoration for the title beside them (aria-hidden).
 */
export type PanelStateKind = "empty" | "loading" | "error" | "locked";

const DEFAULT_ICON: Record<PanelStateKind, IconName> = {
  empty: "inbox",
  loading: "clock",
  error: "alert",
  locked: "lock",
};

export function PanelState({
  kind,
  title,
  body,
  icon,
  action,
  className,
}: {
  kind: PanelStateKind;
  title?: ReactNode;
  body?: ReactNode;
  icon?: IconName | undefined;
  action?: ReactNode;
  /** `| undefined` so a wrapper may forward its own optional className. */
  className?: string | undefined;
}): JSX.Element {
  if (kind === "loading") {
    return (
      <div
        className={cn("flex flex-col gap-3 py-4", className)}
        role="status"
        aria-label="loading"
      >
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  }
  const tone =
    kind === "error" ? "text-danger" : kind === "locked" ? "text-warn" : "text-text-dim";
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center",
        className,
      )}
      role={kind === "error" ? "alert" : undefined}
    >
      <Icon name={icon ?? DEFAULT_ICON[kind]} size={20} className={tone} />
      {title ? <p className="m-0 text-base font-heavy text-text">{title}</p> : null}
      {body ? <p className="m-0 max-w-md text-sm text-text-dim">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
