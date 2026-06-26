/**
 * Reusable HTML5 drag-and-drop hook for device assignment (Task 5).
 *
 * Generalises the shutter→room drag that already lives in the Räume
 * tab so three assignment scenarios share one behaviour:
 *   - shutter   → room   (create/assign window)
 *   - tempSensor→ room   (set room indoorTemp primary)
 *   - contact   → window (set window contactDeviceId)
 *
 * DnD is an additive convenience layer: every assignment keeps an
 * equivalent dropdown, because HTML5 drag-and-drop is unreliable on
 * iOS-Safari (the installed PWA). The hook therefore never owns the
 * canonical state — it only emits a typed payload on drop.
 */

import { signal, type Signal } from '@preact/signals';
import type { JSX } from 'preact';

export type DndKind = 'shutter' | 'tempSensor' | 'contact';

export interface DndPayload {
  kind: DndKind;
  deviceId: string;
}

const MIME = 'text/plain';

/** Serialise a payload for `dataTransfer`. */
export function serializeDnd(p: DndPayload): string {
  return JSON.stringify({ kind: p.kind, deviceId: p.deviceId });
}

/**
 * Parse a `dataTransfer` string back into a payload. Backward
 * compatible: a bare deviceId string (the pre-Task-5 format used by
 * the shutter→room drag) decodes deterministically to a `shutter`
 * payload. Returns `null` for empty/garbage input.
 */
export function parseDnd(raw: string): DndPayload | null {
  if (raw.length === 0) {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<DndPayload>;
    if (
      obj !== null &&
      typeof obj === 'object' &&
      typeof obj.deviceId === 'string' &&
      (obj.kind === 'shutter' || obj.kind === 'tempSensor' || obj.kind === 'contact')
    ) {
      return { kind: obj.kind, deviceId: obj.deviceId };
    }
    return null;
  } catch {
    // Not JSON → treat as a bare deviceId (legacy shutter drag).
    return { kind: 'shutter', deviceId: raw };
  }
}

export interface UseDeviceDndResult {
  /** Spread onto a draggable source element. */
  dragProps(payload: DndPayload): JSX.HTMLAttributes<HTMLElement>;
  /** Spread onto a drop target; `onDrop` fires with the parsed payload. */
  dropProps(
    onDrop: (payload: DndPayload) => void,
    targetKey?: string,
  ): JSX.HTMLAttributes<HTMLElement>;
  /** Key of the target currently hovered (for highlight), or null. */
  hoverKey: Signal<string | null>;
}

export function useDeviceDnd(): UseDeviceDndResult {
  const hoverKey = signal<string | null>(null);

  return {
    hoverKey,
    dragProps(payload: DndPayload): JSX.HTMLAttributes<HTMLElement> {
      return {
        draggable: true,
        onDragStart: (e: JSX.TargetedDragEvent<HTMLElement>): void => {
          e.dataTransfer?.setData(MIME, serializeDnd(payload));
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
          }
        },
      };
    },
    dropProps(
      onDrop: (payload: DndPayload) => void,
      targetKey?: string,
    ): JSX.HTMLAttributes<HTMLElement> {
      return {
        onDragOver: (e: JSX.TargetedDragEvent<HTMLElement>): void => {
          e.preventDefault();
          hoverKey.value = targetKey ?? '';
        },
        onDragLeave: (): void => {
          hoverKey.value = null;
        },
        onDrop: (e: JSX.TargetedDragEvent<HTMLElement>): void => {
          e.preventDefault();
          hoverKey.value = null;
          const raw = e.dataTransfer?.getData(MIME) ?? '';
          const payload = parseDnd(raw);
          if (payload !== null) {
            onDrop(payload);
          }
        },
      };
    },
  };
}
