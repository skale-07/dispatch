import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The line under a field that says why we ask or what shape we want.
 * Give it an `id` and point the input's aria-describedby at it — that is
 * how the hint reaches a screen reader, not proximity.
 */
export function FieldHint({
  id,
  children,
  tone = "dim",
  className,
}: {
  id?: string;
  children: ReactNode;
  /** dim = guidance; warn = a soft problem; danger = a validation error. */
  tone?: "dim" | "warn" | "danger";
  className?: string;
}): JSX.Element {
  return (
    <p
      id={id}
      className={cn(
        "m-0 text-xs",
        tone === "dim" && "text-text-dim",
        tone === "warn" && "text-warn",
        tone === "danger" && "text-danger",
        className,
      )}
      role={tone === "danger" ? "alert" : undefined}
    >
      {children}
    </p>
  );
}
