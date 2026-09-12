import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Atmospheric depth for a hero (CLAUDE.md "Backgrounds"): layered
 * accent gradients over the page ground, optionally the track grid
 * behind them. Both utilities are built in tailwind.css from the accent
 * and surface tokens only, so the atmosphere recolors with the theme.
 * Heroes and section openers use it; cards and panels never do — depth
 * is for the one surface that sets the scene.
 */
export function Atmosphere({
  children,
  grid = false,
  className,
}: {
  children: ReactNode;
  /** Adds the waypoint-track grid under the gradients. */
  grid?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("relative isolate overflow-hidden bg-atmosphere", className)}>
      {grid ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-track-grid opacity-60"
        />
      ) : null}
      {children}
    </div>
  );
}
