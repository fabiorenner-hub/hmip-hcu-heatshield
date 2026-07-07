/**
 * Heat Shield — "Liquid Glass V2" pull-to-refresh (mobile).
 *
 * iOS WebViews / standalone PWAs have NO native pull-to-refresh, so we provide
 * our own: when the page is scrolled to the very top and the user pulls down
 * past a threshold, the page reloads. A small glass indicator (rotating arrow
 * → spinner) follows the pull, turning green once the release threshold is met.
 *
 * Touch-only (gated to coarse pointers); it never attaches on mouse desktops.
 * Pulls that start inside overlays (config panel, dialogs) or the horizontally
 * scrollable bottom bar are ignored, and normal downward scrolling is untouched
 * (we only `preventDefault` while actively pulling at the top).
 */

import { h, type JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const THRESHOLD = 72; // raw finger travel (px) required to trigger a reload
const MAX_PULL = 96; // cap on the indicator's visual travel (px)
const DAMP = 0.5; // resistance: indicator moves at half the finger speed

export function Lg2PullToRefresh(): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null);
  const spinRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    // Only meaningful on touch devices — never hijack mouse-wheel desktops.
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    if (!coarse) return undefined;
    const el = elRef.current;
    if (el === null) return undefined;

    let startY = 0;
    let startX = 0;
    let active = false; // a candidate gesture is in progress
    let pulling = false; // committed to a downward pull (we take over)
    let refreshing = false;
    let rawDy = 0;

    const atTop = (): boolean =>
      (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

    const skipTarget = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest(
        '.lg2-cfg, .lg2-cfg-scrim, .room-detail, .twin-popover, [role="dialog"], .lg2-side, input[type="range"]',
      ) !== null;

    const reset = (animate: boolean): void => {
      el.style.transition = animate ? 'transform 0.24s ease, opacity 0.24s ease' : 'none';
      el.style.transform = 'translateX(-50%) translateY(0px)';
      el.style.opacity = '0';
      el.classList.remove('lg2-ptr--ready');
    };

    const onStart = (e: TouchEvent): void => {
      if (refreshing || e.touches.length !== 1 || !atTop() || skipTarget(e.target)) {
        active = false;
        return;
      }
      active = true;
      pulling = false;
      rawDy = 0;
      startY = e.touches[0]!.clientY;
      startX = e.touches[0]!.clientX;
      el.style.transition = 'none';
    };

    const onMove = (e: TouchEvent): void => {
      if (!active || refreshing) return;
      const dy = e.touches[0]!.clientY - startY;
      const dx = e.touches[0]!.clientX - startX;
      if (!pulling) {
        // Only commit to a pull for a clearly downward, vertical gesture at top.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) {
          active = false;
          return;
        }
        pulling = true;
      }
      if (!atTop()) {
        active = false;
        reset(true);
        return;
      }
      rawDy = dy;
      const dist = Math.min(MAX_PULL, dy * DAMP);
      if (dist > 0) {
        if (e.cancelable) e.preventDefault(); // suppress the rubber-band while pulling
        el.style.transform = `translateX(-50%) translateY(${dist}px)`;
        el.style.opacity = String(Math.min(1, dy / THRESHOLD));
        el.classList.toggle('lg2-ptr--ready', dy >= THRESHOLD);
        const sp = spinRef.current;
        if (sp !== null) sp.style.transform = `rotate(${Math.min(dy, 220) * 1.6}deg)`;
      }
    };

    const onEnd = (): void => {
      if (!active) return;
      active = false;
      const trigger = pulling && rawDy >= THRESHOLD && !refreshing;
      pulling = false;
      rawDy = 0;
      if (trigger) {
        refreshing = true;
        el.classList.add('lg2-ptr--spin', 'lg2-ptr--ready');
        el.style.transition = 'transform 0.2s ease';
        el.style.transform = `translateX(-50%) translateY(${(MAX_PULL * 0.6).toFixed(0)}px)`;
        el.style.opacity = '1';
        window.setTimeout(() => window.location.reload(), 300);
      } else {
        reset(true);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return (): void => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return (
    <div ref={elRef} class="lg2-ptr" aria-hidden="true">
      <div ref={spinRef} class="lg2-ptr__spinner">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v5h-5" />
        </svg>
      </div>
    </div>
  );
}
