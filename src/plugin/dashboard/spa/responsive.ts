/**
 * Heat Shield dashboard — responsive foundation (HeatShield Unified Programme,
 * Gate 2 slice G2.1).
 *
 * Single source of truth for the programme breakpoints
 * (`config/responsive-breakpoints.json`) plus a tiny reactive hook the shells
 * use to pick desktop vs. mobile layout. Pure data + one DOM-observing hook;
 * importing this module changes nothing until a shell actually uses it.
 */

import { useEffect, useState } from 'preact/hooks';

/** Breakpoint class names (blueprint §5.1). */
export type Breakpoint =
  | 'compactPhone'
  | 'largePhone'
  | 'compactTablet'
  | 'expandedTablet'
  | 'desktop';

/** Min width (px) for each breakpoint, ascending. Mirrors the programme JSON. */
export const BREAKPOINT_MIN: Record<Breakpoint, number> = {
  compactPhone: 320,
  largePhone: 390,
  compactTablet: 600,
  expandedTablet: 840,
  desktop: 1200,
};

const ORDER: Breakpoint[] = [
  'compactPhone',
  'largePhone',
  'compactTablet',
  'expandedTablet',
  'desktop',
];

/** Classify a viewport width (px) into a {@link Breakpoint}. Pure. */
export function breakpointFor(width: number): Breakpoint {
  let result: Breakpoint = 'compactPhone';
  for (const bp of ORDER) {
    if (width >= BREAKPOINT_MIN[bp]) result = bp;
  }
  return result;
}

/** True for phone-class widths (compact/large phone). Pure. */
export function isPhone(bp: Breakpoint): boolean {
  return bp === 'compactPhone' || bp === 'largePhone';
}

/** True for tablet-or-wider (compact tablet … desktop). Pure. */
export function isTabletUp(bp: Breakpoint): boolean {
  return !isPhone(bp);
}

/**
 * True for "narrow" viewports — phones AND compact tablets (< 840px). At these
 * widths the vertical v2 sidebar collapses into a cramped, horizontally
 * scrolling all-tabs bar that gets cut off, so the shell shows the Apple-style
 * bottom `MobileNav` (4 tabs + "Mehr") instead. Pure.
 */
export function isNarrow(bp: Breakpoint): boolean {
  return bp === 'compactPhone' || bp === 'largePhone' || bp === 'compactTablet';
}

/**
 * Reactive current breakpoint. Safe in non-DOM / test environments: when
 * `window` is unavailable it returns `desktop` and never subscribes.
 */
export function useBreakpoint(): Breakpoint {
  const initial: Breakpoint =
    typeof window !== 'undefined' && typeof window.innerWidth === 'number'
      ? breakpointFor(window.innerWidth)
      : 'desktop';

  const [bp, setBp] = useState<Breakpoint>(initial);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const onResize = (): void => setBp(breakpointFor(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return bp;
}
