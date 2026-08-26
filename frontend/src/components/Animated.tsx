import type { ReactNode } from "react";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
} from "motion/react";

/**
 * The one seam between Dispatch and Motion. DESIGN.md's rule stands:
 * motion communicates a STATE CHANGE or an ARRIVAL, never decoration —
 * so this module exports a small vocabulary (arrive, depart) instead of
 * the whole library, and every component animates through it.
 *
 * Durations and easing mirror tokens.css (--duration-fast/base,
 * --ease-out); tests/unit/design-tokens.test.ts asserts the two stay
 * identical, same contract as every other token mirror. LazyMotion with
 * the dom-animation feature set keeps the initial bundle small, and
 * MotionConfig reducedMotion="user" honors the OS preference globally —
 * the same guard base.css applies to CSS transitions.
 */

/** Mirrors --duration-fast (120ms). Seconds, as Motion expects. */
export const DURATION_FAST = 0.12;
/** Mirrors --duration-base (200ms). */
export const DURATION_BASE = 0.2;
/** Mirrors --ease-out: cubic-bezier(0.16, 1, 0.3, 1). */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function MotionRoot({ children }: { children: ReactNode }): JSX.Element {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Arrival: fade + small rise, base duration. For content that MOUNTS. */
export const arrive = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: DURATION_BASE, ease: EASE_OUT },
} as const;

/**
 * Departure pair for AnimatePresence lists (a review item resolving, a
 * banner clearing): fast collapse so the layout closes up under it.
 */
export const arriveAndDepart = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0, overflow: "hidden", marginTop: 0 },
  transition: { duration: DURATION_FAST, ease: EASE_OUT },
} as const;

export { AnimatePresence, m };
