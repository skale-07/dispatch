import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A display line: Fraunces, set LIGHT (200), with at most one word set
 * HEAVY (800) through <Heavy>. The contrast between the two weights is
 * the whole typographic idea (CLAUDE.md: weight extremes, not 400 vs
 * 600); size jumps from body by 3× or more. Only heroes and section
 * openers use it — never a card title, never body copy.
 */
export function Display({
  children,
  className,
  as: Tag = "h1",
  size = "hero",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2" | "p";
  /** hero = 4xl on a phone, 5xl from sm up; section = 3xl / 4xl. */
  size?: "hero" | "section";
}): JSX.Element {
  return (
    <Tag
      className={cn(
        "m-0 font-display font-light leading-none tracking-tight text-balance text-text",
        size === "hero" && "text-4xl sm:text-5xl",
        size === "section" && "text-3xl sm:text-4xl",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** The one heavy word inside a <Display>. */
export function Heavy({ children }: { children: ReactNode }): JSX.Element {
  return <span className="font-heavy">{children}</span>;
}
