/**
 * Heat Shield — Portal helper.
 *
 * Renders children into `document.body` so fixed-position overlays (chart
 * deep-dive, room detail) are positioned against the viewport rather than an
 * ancestor. Glass cards use `backdrop-filter`, which (per CSS spec) makes a
 * `position: fixed` descendant resolve against that filtered ancestor instead
 * of the viewport — shrinking the modal into a card corner. Portalling to the
 * body escapes that containing block.
 *
 * Safe under SSR/jsdom: returns null when there is no `document`.
 */

import { type ComponentChildren, type VNode } from 'preact';
import { createPortal } from 'preact/compat';

export function Portal(props: { children: ComponentChildren }): VNode | null {
  if (typeof document === 'undefined' || document.body === null) {
    return null;
  }
  return createPortal(props.children as VNode, document.body) as unknown as VNode;
}
