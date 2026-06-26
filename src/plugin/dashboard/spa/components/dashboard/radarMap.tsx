/**
 * Heat Shield — animated rain radar (Wetter tab).
 *
 * A native Leaflet map on a DARK base layer (CARTO dark_all — matches the
 * dashboard's dark glass UI) with animated RainViewer radar frames and an
 * optional cloud (infrared satellite) overlay. Radar uses a vivid colour
 * scheme at high opacity so rain reads clearly; clouds render as a soft veil.
 *
 * All Leaflet/network work happens inside effects wrapped in try/catch, so a
 * headless/jsdom environment (tests) degrades to the static shell instead of
 * throwing. Tiles are fetched browser-side from CARTO + RainViewer.
 */

import { h, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as L from 'leaflet';

interface RvFrame {
  time: number;
  path: string;
}

export function RadarMap(props: { latitude: number; longitude: number }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const radarLayersRef = useRef<L.TileLayer[]>([]);
  const satLayerRef = useRef<L.TileLayer | null>(null);
  const hostRef = useRef<string>('');
  const [frames, setFrames] = useState<RvFrame[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(true);
  const [clouds, setClouds] = useState<boolean>(true);
  const [failed, setFailed] = useState<boolean>(false);

  const showFrame = (idx: number): void => {
    const layers = radarLayersRef.current;
    for (let i = 0; i < layers.length; i += 1) {
      try {
        layers[i]!.setOpacity(i === idx ? 0.92 : 0);
      } catch {
        /* layer detached */
      }
    }
  };

  // 1. Initialise the Leaflet map once, with a dark base layer.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let map: L.Map | null = null;
    try {
      map = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: false,
      }).setView([props.latitude, props.longitude], 7);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 12,
        minZoom: 4,
        attribution: '© OpenStreetMap, © CARTO',
      }).addTo(map);
      L.marker([props.latitude, props.longitude], {
        icon: L.divIcon({
          className: 'radar-home-marker',
          html: '<span></span>',
          iconSize: [16, 16],
        }),
      }).addTo(map);
      mapRef.current = map;
    } catch {
      setFailed(true);
      return;
    }
    return (): void => {
      try {
        map?.remove();
      } catch {
        /* already gone */
      }
      mapRef.current = null;
      radarLayersRef.current = [];
      satLayerRef.current = null;
    };
  }, [props.latitude, props.longitude]);

  // 2. Load RainViewer frames (radar + cloud satellite) and build layers.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          host: string;
          radar?: { past?: RvFrame[]; nowcast?: RvFrame[] };
          satellite?: { infrared?: RvFrame[] };
        };
        const fr = [...(json.radar?.past ?? []), ...(json.radar?.nowcast ?? [])];
        const map = mapRef.current;
        if (cancelled || map === null || fr.length === 0) return;
        hostRef.current = json.host;

        // Rebuild radar layers (colour scheme 4 = vivid, smooth + snow).
        for (const l of radarLayersRef.current) {
          try {
            map.removeLayer(l);
          } catch {
            /* noop */
          }
        }
        radarLayersRef.current = fr.map((f) =>
          L.tileLayer(`${json.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`, {
            opacity: 0,
            maxZoom: 12,
            minZoom: 4,
            zIndex: 400,
          }).addTo(map),
        );

        // Cloud layer: the latest infrared satellite frame as a soft veil.
        const sat = json.satellite?.infrared ?? [];
        const latestSat = sat[sat.length - 1];
        if (satLayerRef.current !== null) {
          try {
            map.removeLayer(satLayerRef.current);
          } catch {
            /* noop */
          }
          satLayerRef.current = null;
        }
        if (latestSat !== undefined) {
          satLayerRef.current = L.tileLayer(
            `${json.host}${latestSat.path}/256/{z}/{x}/{y}/0/0_0.png`,
            { opacity: clouds ? 0.5 : 0, maxZoom: 12, minZoom: 4, zIndex: 350 },
          ).addTo(map);
        }

        setFrames(fr);
        const startIdx = Math.max(0, (json.radar?.past?.length ?? fr.length) - 1);
        setActiveIdx(startIdx);
        showFrame(startIdx);
      } catch {
        /* radar overlay unavailable; the dark base map still renders */
      }
    };
    void load();
    const refresh = setInterval(() => void load(), 5 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(refresh);
    };
  }, [props.latitude, props.longitude]);

  // 3. Playback timer.
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => {
      setActiveIdx((prev) => {
        const next = (prev + 1) % frames.length;
        showFrame(next);
        return next;
      });
    }, 700);
    return (): void => clearInterval(id);
  }, [playing, frames.length]);

  // 4. Toggle the cloud veil.
  useEffect(() => {
    try {
      satLayerRef.current?.setOpacity(clouds ? 0.5 : 0);
    } catch {
      /* noop */
    }
  }, [clouds]);

  const onScrub = (e: JSX.TargetedEvent<HTMLInputElement>): void => {
    const idx = Number((e.currentTarget as HTMLInputElement).value);
    setPlaying(false);
    setActiveIdx(idx);
    showFrame(idx);
  };

  const activeTime = frames[activeIdx]?.time ?? null;
  const label =
    activeTime === null
      ? '—'
      : new Date(activeTime * 1000).toLocaleTimeString('de-DE', {
          hour: '2-digit',
          minute: '2-digit',
        });

  return (
    <section class="radar" data-testid="radar-map">
      <header class="radar__head">
        <h2>Regenradar</h2>
        <span class="radar__time" data-testid="radar-time">
          {label}
        </span>
      </header>
      <div class="radar__map" ref={containerRef} data-testid="radar-canvas" />
      {failed ? (
        <p class="radar__error">Karte konnte nicht geladen werden.</p>
      ) : (
        <div class="radar__controls">
          <button
            type="button"
            class="radar__play"
            data-testid="radar-play"
            aria-label={playing ? 'Pause' : 'Abspielen'}
            onClick={(): void => setPlaying((p) => !p)}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <input
            type="range"
            class="radar__scrub"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={activeIdx}
            disabled={frames.length < 2}
            onInput={onScrub}
            aria-label="Radar-Zeitpunkt"
          />
          <button
            type="button"
            class={`radar__clouds${clouds ? ' radar__clouds--on' : ''}`}
            data-testid="radar-clouds"
            aria-pressed={clouds}
            onClick={(): void => setClouds((c) => !c)}
          >
            Wolken
          </button>
          <span class="radar__legend">RainViewer · dBZ</span>
        </div>
      )}
    </section>
  );
}
