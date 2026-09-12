import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The public app's page frame: one measured column, side gutters that
 * never collapse below 16px, vertical rhythm from the spacing scale.
 * PublicApp.tsx owns the skip link, <main> and the nav (the a11y test
 * reads those literals); this is only the column those sit in.
 */
export function PublicShell({
  children,
  className,
  width = "measure",
}: {
  children: ReactNode;
  className?: string;
  /** measure = reading width; wide = dashboard grids; full = live view. */
  width?: "measure" | "wide" | "full";
}): JSX.Element {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8",
        width === "measure" && "max-w-3xl",
        width === "wide" && "max-w-6xl",
        width === "full" && "max-w-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
