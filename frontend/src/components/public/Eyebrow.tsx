import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small mono label ABOVE a display line or a panel — "needs you",
 * "this week", a section number. Monospace because it is a category,
 * not prose (DESIGN.md §2.2); dim so the display below it carries the
 * weight.
 */
export function Eyebrow({
  children,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "span" | "h2" | "h3";
}): JSX.Element {
  return (
    <Tag
      className={cn(
        "m-0 font-mono text-xs font-heavy uppercase tracking-widest text-text-dim",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
