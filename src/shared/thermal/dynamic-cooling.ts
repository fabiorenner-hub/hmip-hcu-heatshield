/**
 * Dynamic cooling core — reduced RC building model (thermal-load-engine).
 *
 * A two-capacitance (air + thermal-mass) hourly model, VDI 2078 / VDI 6007
 * STRUCTURE but implemented as public-physics reduced RC (ISO-13790-style
 * simple hourly): air node exchanges with outdoor via ventilation + windows and
 * with the mass node; the mass node exchanges with outdoor via the opaque
 * envelope. Solar + radiant gains load the mass node, convective gains the air
 * node. Integrated with an UNCONDITIONALLY-STABLE implicit Euler step (the
 * knowledge model warns explicit integration can be unstable → stable solver).
 *
 * Status IMPLEMENTATION — a genuine dynamic core (peak lags the solar peak via
 * storage), non-normative. The licensed VDI 6007 parameterisation would be
 * applied once the NORM-PARAM values are captured; this module needs none.
 * Pure; no I/O, no zod.
 */

export interface RcRoomParams {
  /** Thermal-mass capacitance [J/K]. */
  cmJ: number;
  /** Air capacitance [J/K]. */
  caJ: number;
  /** Ventilation conductance H_ve [W/K] (air ↔ outdoor). */
  hVeW: number;
  /** Window transmission H_tr,w [W/K] (air ↔ outdoor, direct). */
  hWinW: number;
  /** Air ↔ mass coupling H_ms [W/K]. */
  hMsW: number;
  /** Mass ↔ outdoor (opaque) conductance H_em [W/K]. */
  hEmW: number;
  /** Cooling setpoint [°C]; air temperature is capped here when cooling. */
  coolingSetpointC: number;
}

/** Hourly design-day boundary series (length 24). */
export interface DesignDaySeries {
  outdoorC: number[];
  /** Solar power entering the room [W] (already through glazing). */
  solarToRoomW: number[];
  /** Convective internal gain to the air node [W]. */
  internalConvW: number[];
  /** Radiant internal gain to the mass node [W]. */
  internalRadW: number[];
}

export interface DynamicDayResult {
  hours: number[];
  airC: number[];
  massC: number[];
  operativeC: number[];
  coolingW: number[];
  peakCoolingW: number;
  peakHour: number;
  peakOperativeC: number;
}

/** Solve the 2×2 implicit-Euler step; returns end-of-step air/mass temps. */
function stepFreeFloat(
  p: RcRoomParams,
  dt: number,
  ta0: number,
  tm0: number,
  te: number,
  qConv: number,
  qRad: number,
): { ta: number; tm: number } {
  const a = p.caJ / dt + p.hVeW + p.hWinW + p.hMsW;
  const b = p.cmJ / dt + p.hMsW + p.hEmW;
  const rhsA = (p.caJ / dt) * ta0 + (p.hVeW + p.hWinW) * te + qConv;
  const rhsM = (p.cmJ / dt) * tm0 + p.hEmW * te + qRad;
  // [ a  -Hms ][ta]   [rhsA]
  // [-Hms  b  ][tm] = [rhsM]
  const det = a * b - p.hMsW * p.hMsW;
  const ta = (rhsA * b + p.hMsW * rhsM) / det;
  const tm = (a * rhsM + p.hMsW * rhsA) / det;
  return { ta, tm };
}

/**
 * Simulate a periodic design day. Runs `days` repetitions of the 24 h series to
 * reach periodic steady state and returns the LAST day. Cooling caps the air
 * node at the setpoint and reports the extracted power.
 */
export function simulateDesignDay(
  p: RcRoomParams,
  series: DesignDaySeries,
  opts?: { days?: number; initialC?: number; subStepsPerHour?: number },
): DynamicDayResult {
  const days = Math.max(1, opts?.days ?? 3);
  const sub = Math.max(1, opts?.subStepsPerHour ?? 4);
  const dt = 3600 / sub;
  let ta = opts?.initialC ?? 24;
  let tm = opts?.initialC ?? 24;

  const airC: number[] = [];
  const massC: number[] = [];
  const operativeC: number[] = [];
  const coolingW: number[] = [];

  for (let d = 0; d < days; d += 1) {
    const lastDay = d === days - 1;
    if (lastDay) { airC.length = 0; massC.length = 0; operativeC.length = 0; coolingW.length = 0; }
    for (let hLoop = 0; hLoop < 24; hLoop += 1) {
      const te = series.outdoorC[hLoop] ?? 0;
      const qConv = (series.internalConvW[hLoop] ?? 0);
      const qRad = (series.solarToRoomW[hLoop] ?? 0) + (series.internalRadW[hLoop] ?? 0);
      let hourCooling = 0;
      for (let s = 0; s < sub; s += 1) {
        const ff = stepFreeFloat(p, dt, ta, tm, te, qConv, qRad);
        if (ff.ta > p.coolingSetpointC) {
          // Cap the air node at the setpoint; solve mass + required extraction.
          const tSet = p.coolingSetpointC;
          const b = p.cmJ / dt + p.hMsW + p.hEmW;
          const rhsM = (p.cmJ / dt) * tm + p.hEmW * te + qRad + p.hMsW * tSet;
          const tmSet = rhsM / b;
          // Air balance at Ta=tSet: 0 = Hve(te-tSet)+Hwin(te-tSet)+Hms(tmSet-tSet)+qConv+Qhc - Ca/dt(tSet-ta)
          const qhc =
            (p.caJ / dt) * (tSet - ta) -
            (p.hVeW + p.hWinW) * (te - tSet) -
            p.hMsW * (tmSet - tSet) -
            qConv;
          // qhc < 0 → heat must be removed (cooling). Extraction = -qhc.
          hourCooling = Math.max(hourCooling, Math.max(0, -qhc));
          ta = tSet;
          tm = tmSet;
        } else {
          ta = ff.ta;
          tm = ff.tm;
        }
      }
      if (lastDay) {
        airC.push(ta);
        massC.push(tm);
        operativeC.push(0.5 * ta + 0.5 * tm);
        coolingW.push(hourCooling);
      }
    }
  }

  let peakCoolingW = 0;
  let peakHour = 0;
  for (let h = 0; h < coolingW.length; h += 1) {
    if ((coolingW[h] ?? 0) > peakCoolingW) { peakCoolingW = coolingW[h] as number; peakHour = h; }
  }
  return {
    hours: Array.from({ length: 24 }, (_, i) => i),
    airC,
    massC,
    operativeC,
    coolingW,
    peakCoolingW,
    peakHour,
    peakOperativeC: operativeC.reduce((m, v) => Math.max(m, v), -Infinity),
  };
}

/**
 * Derive reduced-RC parameters + solar aperture from a room's thermal input.
 * Uses public reduced-model defaults (medium thermal mass, air↔mass coupling);
 * the licensed VDI 6007 parameterisation would refine these once captured.
 */
export function rcInputsFromRoom(
  room: RcSourceRoom,
  opts?: { coolingSetpointC?: number; arealMassJ?: number },
): { params: RcRoomParams; solarApertureM2: number } {
  const arealMass = opts?.arealMassJ ?? 150000; // medium construction [J/(m²·K)]
  const caJ = room.volumeM3 * 1.2 * 1005; // air
  const cmJ = room.floorAreaM2 * arealMass;
  const n = Math.max(room.airChangeRate ?? 0.5, 0);
  const hVeW = 0.34 * n * room.volumeM3;

  let hWinW = 0;
  let hEmW = 0;
  let solarApertureM2 = 0;
  for (const s of room.surfaces) {
    if (s.glazing === true) {
      hWinW += s.uValue * s.areaM2;
      solarApertureM2 += s.areaM2 * (s.gTotal ?? 0.5) * (s.shadingFactor ?? 1);
    } else if (s.boundary === 'exterior' || s.boundary === 'ground') {
      hEmW += s.uValue * s.areaM2;
    }
  }
  const hMsW = 9 * 2.5 * room.floorAreaM2; // air↔mass coupling over internal area
  return {
    params: {
      caJ,
      cmJ,
      hVeW,
      hWinW,
      hMsW,
      hEmW,
      coolingSetpointC: opts?.coolingSetpointC ?? 26,
    },
    solarApertureM2,
  };
}

/** Minimal room shape the RC builder needs (subset of RoomThermalInput). */
export interface RcSourceRoom {
  floorAreaM2: number;
  volumeM3: number;
  airChangeRate?: number;
  surfaces: Array<{ areaM2: number; uValue: number; boundary: string; glazing?: boolean; gTotal?: number; shadingFactor?: number }>;
}

/** Build a simple design day: sinusoidal outdoor + a daytime solar bell. */
export function buildDesignDay(input: {
  peakOutdoorC: number;
  minOutdoorC: number;
  peakSolarW: number;
  internalConvW?: number;
  internalRadW?: number;
}): DesignDaySeries {
  const outdoorC: number[] = [];
  const solarToRoomW: number[] = [];
  const internalConvW: number[] = [];
  const internalRadW: number[] = [];
  const mean = (input.peakOutdoorC + input.minOutdoorC) / 2;
  const amp = (input.peakOutdoorC - input.minOutdoorC) / 2;
  for (let h = 0; h < 24; h += 1) {
    // Outdoor peak ~15:00, min ~05:00.
    outdoorC.push(mean - amp * Math.cos(((h - 15) / 24) * 2 * Math.PI));
    // Solar bell 06:00–18:00, peak at 12:00.
    const s = h >= 6 && h <= 18 ? Math.max(0, Math.sin(((h - 6) / 12) * Math.PI)) : 0;
    solarToRoomW.push(input.peakSolarW * s);
    internalConvW.push(input.internalConvW ?? 0);
    internalRadW.push(input.internalRadW ?? 0);
  }
  return { outdoorC, solarToRoomW, internalConvW, internalRadW };
}
