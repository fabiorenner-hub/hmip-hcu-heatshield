/**
 * Per-window sun-status card (Task 4).
 *
 * Shows whether the sun is on the window right now ("besonnt"), will
 * be within the look-ahead window ("bald besonnt") or is away
 * ("abgewandt"), plus the window orientation as a compass label. The
 * status is computed client-side from the inlined `getSunPosition`
 * and the window orientation — same maths as the engine, no backend
 * round-trip.
 */

import { h, type JSX } from 'preact';

import { compassLabel, deviceLabel } from '../format.js';
import { windowSunStatus, type SunWindowStatus } from '../sunIncidence.js';
import type { Window as WindowDef } from '../../../../shared/types.js';

export interface WindowSunCardProps {
  window: WindowDef;
  latitude: number;
  longitude: number;
  minElevationDeg: number;
  maxIncidenceAngleFacadeDeg: number;
  maxIncidenceAngleRoofDeg: number;
  /** Friendly name of the shutter device, if known. */
  friendlyName?: string;
  /** Reference clock; defaults to `new Date()`. */
  now?: Date;
}

const STATUS_META: Record<SunWindowStatus, { label: string; icon: string }> = {
  lit: { label: 'besonnt', icon: '🟠' },
  soon: { label: 'bald besonnt', icon: '🟡' },
  away: { label: 'abgewandt / verschattet', icon: '⚪' },
};

export function WindowSunCard(props: WindowSunCardProps): JSX.Element {
  const w = props.window;
  const status = windowSunStatus({
    now: props.now ?? new Date(),
    latitude: props.latitude,
    longitude: props.longitude,
    orientationDeg: w.orientationDeg,
    type: w.type,
    sunPrelookMinutes: w.sunPrelookMinutes,
    minElevationDeg: props.minElevationDeg,
    maxIncidenceAngleFacadeDeg: props.maxIncidenceAngleFacadeDeg,
    maxIncidenceAngleRoofDeg: props.maxIncidenceAngleRoofDeg,
  });
  const meta = STATUS_META[status];
  const name = deviceLabel({
    deviceId: w.shutterDeviceId,
    ...(props.friendlyName !== undefined ? { friendlyName: props.friendlyName } : {}),
  });

  return (
    <article
      class={`window-sun-card window-sun-card--${status}`}
      data-testid={`window-sun-card-${w.id}`}
      data-status={status}
    >
      <header class="window-sun-card__head">
        <span class="window-sun-card__icon" aria-hidden="true">
          {meta.icon}
        </span>
        <strong class="window-sun-card__name">{name}</strong>
      </header>
      <div class="window-sun-card__meta">
        <span>{compassLabel(w.orientationDeg)} ({Math.round(w.orientationDeg)}°)</span>
        <span class="window-sun-card__status">{meta.label}</span>
      </div>
    </article>
  );
}
