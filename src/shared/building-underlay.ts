/**
 * Heat Shield — Building Studio underlay model + calibration math (building-
 * model-editor Phase 2, BME-03/04/05/12). PURE, ZOD-FREE.
 *
 * An "underlay" is a reference raster (a scanned/photographed floor plan)
 * placed behind the 2D editor so the user can trace geometry over it. Underlays
 * are SOURCE artefacts, NOT canonical geometry — their binaries live in a
 * separate store with retention state (design §Data privacy); this module only
 * defines the metadata shape and the pixel↔model transform used to display and
 * calibrate them.
 *
 * Transform: an image pixel (px, py) — with py growing DOWNWARD — maps to model
 * metres by
 *     model = offset + Rot(rotationDeg) · (px · mpp, −py · mpp)
 * where `mpp` = metres-per-pixel (the calibration) and `offset` is the model
 * position of pixel (0,0). Two-point calibration solves `mpp` from a known
 * real-world distance between two picked points.
 */

export type UnderlayKind = 'floorplan' | 'section' | 'elevation' | 'roofplan' | 'reference';

export const UNDERLAY_KINDS: readonly UnderlayKind[] = [
  'floorplan',
  'section',
  'elevation',
  'roofplan',
  'reference',
];

/** Metadata for one underlay (no binary — the bytes live in the store). */
export interface UnderlayMeta {
  id: string;
  storeyId: string;
  name: string;
  kind: UnderlayKind;
  mediaType: string;
  widthPx: number;
  heightPx: number;
  /** Metres per pixel; null until calibrated. */
  metersPerPixel: number | null;
  /** Model coordinates (m) of image pixel (0,0). */
  offsetXM: number;
  offsetYM: number;
  /** Display rotation about pixel (0,0), degrees CCW. */
  rotationDeg: number;
  /** 0..100 display opacity. */
  opacityPct: number;
  /** 50..150 display contrast. */
  contrastPct: number;
  visible: boolean;
  /** Locked underlays do not intercept editing gestures (BME-12). */
  locked: boolean;
  /** True when north is assumed rather than known (BME-05). */
  northAssumed: boolean;
  createdAt: string;
}

/** Default metres-per-pixel used to DISPLAY an uncalibrated underlay. */
export const DEFAULT_MPP = 0.02;

export interface Vec2 {
  x: number;
  y: number;
}

/** Effective metres-per-pixel for display (falls back to the default). */
export function effectiveMpp(u: Pick<UnderlayMeta, 'metersPerPixel'>): number {
  return u.metersPerPixel !== null && u.metersPerPixel > 0 ? u.metersPerPixel : DEFAULT_MPP;
}

function rotate(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Map an image pixel to model metres under the underlay's transform. */
export function pixelToModel(
  px: number,
  py: number,
  u: Pick<UnderlayMeta, 'metersPerPixel' | 'offsetXM' | 'offsetYM' | 'rotationDeg'>,
): Vec2 {
  const mpp = effectiveMpp(u);
  const local = rotate({ x: px * mpp, y: -py * mpp }, u.rotationDeg);
  return { x: u.offsetXM + local.x, y: u.offsetYM + local.y };
}

/**
 * Two-point scale calibration (BME-05). Given two points picked in MODEL space
 * (`m1`, `m2`) whose true separation is `realDistanceM`, returns the corrected
 * `metersPerPixel` and `offset` so that `m1` stays fixed while the underlay is
 * rescaled by k = realDistanceM / |m2 − m1|. No-op factor (k=1) when the points
 * coincide or the real distance is non-positive.
 */
export function calibrateTwoPoint(
  u: Pick<UnderlayMeta, 'metersPerPixel' | 'offsetXM' | 'offsetYM' | 'rotationDeg'>,
  m1: Vec2,
  m2: Vec2,
  realDistanceM: number,
): { metersPerPixel: number; offsetXM: number; offsetYM: number } {
  const dModel = Math.hypot(m2.x - m1.x, m2.y - m1.y);
  const mpp = effectiveMpp(u);
  if (dModel <= 1e-9 || realDistanceM <= 0) {
    return { metersPerPixel: mpp, offsetXM: u.offsetXM, offsetYM: u.offsetYM };
  }
  const k = realDistanceM / dModel;
  // Keep m1 fixed: offset' = offset + (1 − k)·(m1 − offset).
  return {
    metersPerPixel: mpp * k,
    offsetXM: u.offsetXM + (1 - k) * (m1.x - u.offsetXM),
    offsetYM: u.offsetYM + (1 - k) * (m1.y - u.offsetYM),
  };
}

/** Clamp helpers used by the metadata patch path (keeps display values sane). */
export function clampUnderlayDisplay(patch: Partial<UnderlayMeta>): Partial<UnderlayMeta> {
  const out: Partial<UnderlayMeta> = { ...patch };
  if (out.opacityPct !== undefined) out.opacityPct = Math.max(0, Math.min(100, out.opacityPct));
  if (out.contrastPct !== undefined) out.contrastPct = Math.max(50, Math.min(150, out.contrastPct));
  if (out.rotationDeg !== undefined) out.rotationDeg = ((out.rotationDeg % 360) + 360) % 360;
  if (out.metersPerPixel !== undefined && out.metersPerPixel !== null && out.metersPerPixel <= 0) {
    out.metersPerPixel = null;
  }
  return out;
}
