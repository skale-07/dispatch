import type { ReactNode } from "react";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
  useReducedMotion,
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
/** --duration-slow: the one orchestrated page-load reveal, nothing else. */
export const DURATION_SLOW = 0.6;
/** --stagger: delay between siblings inside that reveal. */
export const STAGGER = 0.07;
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

/**
 * The ONE orchestrated page-load reveal (CLAUDE.md "Motion": one
 * well-orchestrated reveal beats scattered micro-interactions). A
 * `<Reveal>` staggers its `<RevealItem>` children on mount by --stagger,
 * each rising over --duration-slow. Nothing else in the public app
 * animates on load. Under prefers-reduced-motion the items simply
 * appear: MotionConfig reducedMotion="user" (MotionRoot) already
 * neutralises transforms, and `useReducedMotion` here drops the stagger
 * so a reader who asked for no motion is not made to wait either.
 */
const revealParent = {
  hidden: {},
  shown: { transition: { staggerChildren: STAGGER, delayChildren: STAGGER } },
} as const;
const revealChild = {
  hidden: { opacity: 0, y: 12 },
  shown: { opacity: 1, y: 0, transition: { duration: DURATION_SLOW, ease: EASE_OUT } },
} as const;
const revealChildStill = {
  hidden: { opacity: 1, y: 0 },
  shown: { opacity: 1, y: 0 },
} as const;

export function Reveal({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  /** The wrapper element — a section/header/ul reads as such to AT. */
  as?: "div" | "section" | "header" | "ul" | "ol";
}): JSX.Element {
  const reduced = useReducedMotion();
  const Tag = m[as];
  // Spread rather than pass `undefined`: exactOptionalPropertyTypes.
  const variants = reduced ? {} : { variants: revealParent };
  return (
    <Tag className={className} {...variants} initial="hidden" animate="shown">
      {children}
    </Tag>
  );
}

export function RevealItem({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "p" | "h1" | "h2" | "li" | "span";
}): JSX.Element {
  const reduced = useReducedMotion();
  const Tag = m[as];
  return (
    <Tag className={className} variants={reduced ? revealChildStill : revealChild}>
      {children}
    </Tag>
  );
}

export { AnimatePresence, m };
