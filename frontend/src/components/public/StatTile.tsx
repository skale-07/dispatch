import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./Eyebrow";

/**
 * One number and what it means. The value is MONO and HEAVY — a count is
 * something the user compares and copies (DESIGN.md §2.2); the label sits
 * above as an eyebrow and the hint below in dim prose. Never invents a
 * number: a tile with nothing to show renders its `empty` text instead
 * of a zero that would read as a fact.
 */
export function StatTile({
  label,
  value,
  hint,
  empty,
  className,
}: {
  label: ReactNode;
  value: ReactNode | null;
  hint?: ReactNode;
  /** What to say when there is no value yet — honest, not "0". */
  empty?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-5",
        className,
      )}
    >
      <Eyebrow>{label}</Eyebrow>
      {value === null || value === undefined ? (
        <p className="m-0 text-base text-text-dim">{empty ?? "nothing yet"}</p>
      ) : (
        <p className="m-0 font-mono text-3xl font-heavy leading-none tabular-nums text-text">
          {value}
        </p>
      )}
      {hint ? <p className="m-0 text-xs text-text-dim">{hint}</p> : null}
    </div>
  );
}
