/**
 * Heat Shield — "Liquid Glass V2" setup wizard (native v2).
 *
 * A from-scratch, guided first-run experience that lets a user set up the whole
 * system in a few friendly steps. Native v2: renders its own
 * `<main class="lg2-main lg2-wiz">` inside the shared Lg2Shell (the sidebar is
 * the chrome). Unlike the old v1 wizard it explicitly asks the two questions
 * the user cares about:
 *
 *   • Welche PV-Anlage? (none / FusionSolar + kWp + Ausrichtung)
 *   • Ist ein GARDENA smart system vorhanden? (nein / ja + Zugangsdaten)
 *
 * Everything is collected into local draft state and persisted in ONE final
 * `PUT /api/config` (via useConfig.save). Once ≥1 room and ≥1 window exist the
 * plugin readiness flips CONFIG_REQUIRED → READY automatically.
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t } from '../../i18n.js';
import { useConfig } from '../../hooks/useConfig.js';
import { runDiscovery, useDiscovery, type DiscoveredDevice } from '../../hooks/useDiscovery.js';
import { applyProfile, type ProfileName } from '../../profiles.js';
import { deviceLabel, PRIORITY_LABELS } from '../../format.js';
import type { Config, Location, Room, Window as WindowDef } from '../../../../../shared/types.js';
import { Icon, type IconName } from '../icons.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  } catch {
    return 'Europe/Berlin';
  }
}

const DEFAULT_LOCATION: Location = {
  latitude: 52.52,
  longitude: 13.41,
  timezone: guessTimezone(),
};

type PvKind = 'none' | 'fusion' | 'hmip';
type PvOrientation = 'southeast' | 'south' | 'southwest' | 'east' | 'west' | 'mixed';

/** Selectable floor/level for a room (chosen per room, not baked into presets). */
const FLOOR_OPTIONS: ReadonlyArray<{ v: string; de: string; en: string }> = [
  { v: 'KG', de: 'Keller (KG)', en: 'Basement (KG)' },
  { v: 'EG', de: 'Erdgeschoss (EG)', en: 'Ground floor (EG)' },
  { v: 'OG', de: 'Obergeschoss (OG)', en: 'Upper floor (OG)' },
  { v: 'DG', de: 'Dachgeschoss (DG)', en: 'Attic (DG)' },
];

/** Plain-language explanation of each room priority (shown as a legend). */
const PRIORITY_HELP: ReadonlyArray<{ v: Room['priority']; de: string; en: string }> = [
  { v: 'very_high', de: 'Sehr hoch — zuerst schützen (z. B. Schlaf-/Arbeitszimmer).', en: 'Very high — protect first (e.g. bed/study).' },
  { v: 'high', de: 'Hoch — wichtig, direkt danach.', en: 'High — important, right after.' },
  { v: 'medium', de: 'Mittel — normale Priorität.', en: 'Medium — normal priority.' },
  { v: 'low', de: 'Niedrig — zuletzt (z. B. Keller, Flur).', en: 'Low — last (e.g. basement, hallway).' },
];

/** Feature-name hint used to auto-pick a power feature on an HMIP device. */
const POWER_FEATURE_RE = /power|watt|leistung|energy|energie/i;

const PV_ORIENTATIONS: ReadonlyArray<{ v: PvOrientation; de: string; en: string }> = [
  { v: 'south', de: 'Süd', en: 'South' },
  { v: 'southeast', de: 'Südost', en: 'Southeast' },
  { v: 'southwest', de: 'Südwest', en: 'Southwest' },
  { v: 'east', de: 'Ost', en: 'East' },
  { v: 'west', de: 'West', en: 'West' },
  { v: 'mixed', de: 'Gemischt', en: 'Mixed' },
];

const COMPASS_OPTIONS: ReadonlyArray<{ deg: number; de: string; en: string }> = [
  { deg: 0, de: 'Nord', en: 'North' },
  { deg: 45, de: 'Nordost', en: 'Northeast' },
  { deg: 90, de: 'Ost', en: 'East' },
  { deg: 135, de: 'Südost', en: 'Southeast' },
  { deg: 180, de: 'Süd', en: 'South' },
  { deg: 225, de: 'Südwest', en: 'Southwest' },
  { deg: 270, de: 'West', en: 'West' },
  { deg: 315, de: 'Nordwest', en: 'Northwest' },
];

function nearestCompassDeg(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  const snapped = Math.round(norm / 45) * 45;
  return snapped === 360 ? 0 : snapped;
}

interface RoomPreset {
  de: string;
  en: string;
  priority: Room['priority'];
}
// Presets carry no floor — the floor is chosen per room afterwards.
const ROOM_PRESETS: readonly RoomPreset[] = [
  { de: 'Schlafzimmer', en: 'Bedroom', priority: 'very_high' },
  { de: 'Arbeitszimmer', en: 'Study', priority: 'high' },
  { de: 'Wohnzimmer', en: 'Living room', priority: 'high' },
  { de: 'Küche', en: 'Kitchen', priority: 'low' },
  { de: 'Kinderzimmer', en: 'Kids room', priority: 'high' },
  { de: 'Gästezimmer', en: 'Guest room', priority: 'medium' },
  { de: 'Bad', en: 'Bathroom', priority: 'medium' },
  { de: 'Keller', en: 'Basement', priority: 'low' },
];

const PROFILE_META: ReadonlyArray<{ v: ProfileName; de: string; en: string; descDe: string; descEn: string }> = [
  { v: 'conservative', de: 'Sanft', en: 'Gentle', descDe: 'Spät beschatten, viel Tageslicht.', descEn: 'Shade late, keep daylight.' },
  { v: 'standard', de: 'Ausgewogen', en: 'Balanced', descDe: 'Empfohlene Voreinstellung.', descEn: 'Recommended default.' },
  { v: 'aggressive', de: 'Konsequent', en: 'Aggressive', descDe: 'Früh und stark beschatten.', descEn: 'Shade early and strongly.' },
];

const PRIORITIES: Room['priority'][] = ['very_high', 'high', 'medium', 'low'];

function newRoomId(name: string, existing: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = slug.length > 0 ? slug : 'room';
  let candidate = base;
  let n = 1;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** Best-effort reverse-geocode of coordinates → locality (for the DWD region). */
async function reverseGeocodeRegion(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=de`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { locality?: string; city?: string; principalSubdivision?: string };
    const name = (j.locality ?? j.city ?? j.principalSubdivision ?? '').trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Wizard                                                                     */
/* -------------------------------------------------------------------------- */

interface StepMeta {
  id: 'welcome' | 'location' | 'pv' | 'gardena' | 'rooms' | 'windows' | 'finish';
  icon: IconName;
  titleDe: string;
  titleEn: string;
  subDe: string;
  subEn: string;
}

const STEPS: readonly StepMeta[] = [
  { id: 'welcome', icon: 'logo', titleDe: 'Willkommen', titleEn: 'Welcome', subDe: 'In wenigen Schritten ist alles eingerichtet.', subEn: "We'll set everything up in a few steps." },
  { id: 'location', icon: 'haus', titleDe: 'Standort', titleEn: 'Location', subDe: 'Damit Sonnenstand und Wetter genau stimmen.', subEn: 'So sun position and weather are accurate.' },
  { id: 'pv', icon: 'pv', titleDe: 'PV-Anlage', titleEn: 'PV system', subDe: 'Nutzt du eine Photovoltaik-Anlage?', subEn: 'Do you have a photovoltaic system?' },
  { id: 'gardena', icon: 'tropfen', titleDe: 'Bewässerung', titleEn: 'Irrigation', subDe: 'Ist ein GARDENA smart system vorhanden?', subEn: 'Is a GARDENA smart system present?' },
  { id: 'rooms', icon: 'haus', titleDe: 'Räume', titleEn: 'Rooms', subDe: 'Lege deine Räume an.', subEn: 'Create your rooms.' },
  { id: 'windows', icon: 'fenster', titleDe: 'Rollläden', titleEn: 'Shutters', subDe: 'Ordne die gefundenen Rollläden den Räumen zu.', subEn: 'Assign the discovered shutters to rooms.' },
  { id: 'finish', icon: 'einstellungen', titleDe: 'Feinschliff & Start', titleEn: 'Finish & start', subDe: 'Verhalten wählen und speichern.', subEn: 'Pick a behaviour and save.' },
];

export function LiquidGlass2Wizard(): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();

  const [step, setStep] = useState<number>(0);
  const [location, setLocation] = useState<Location>(DEFAULT_LOCATION);
  const [region, setRegion] = useState<string>('Berlin');
  const regionAutoRef = useRef<string>('');

  const [pvKind, setPvKind] = useState<PvKind>('none');
  const [pvKwp, setPvKwp] = useState<number>(8.8);
  const [pvOrientation, setPvOrientation] = useState<PvOrientation>('southeast');
  const [pvBaseUrl, setPvBaseUrl] = useState<string>('http://host.containers.internal:8088');
  // Generic HMIP power source (e.g. a watt meter exposed by the Modbus plugin).
  const [pvDeviceId, setPvDeviceId] = useState<string>('');
  const [pvFeature, setPvFeature] = useState<string>('');

  const [gardenaPresent, setGardenaPresent] = useState<boolean>(false);
  const [gardenaClientId, setGardenaClientId] = useState<string>('');
  const [gardenaClientSecret, setGardenaClientSecret] = useState<string>('');

  const [draftRooms, setDraftRooms] = useState<Room[]>([]);
  const [draftWindows, setDraftWindows] = useState<WindowDef[]>([]);
  const [profile, setProfile] = useState<ProfileName>('standard');
  const [activate, setActivate] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const hydratedRef = useRef<boolean>(false);
  const discoveredRef = useRef<boolean>(false);

  // Hydrate drafts from the existing config once.
  useEffect(() => {
    const c = cfg.config.value;
    if (c === null || hydratedRef.current) return;
    hydratedRef.current = true;
    setLocation(c.location.latitude !== 0 || c.location.longitude !== 0 ? c.location : DEFAULT_LOCATION);
    setRegion(c.dwd?.regionName ?? 'Berlin');
    setDraftRooms(c.rooms);
    setDraftWindows(c.windows);
    setProfile(c.rules.profile);
    if (c.gardena?.enabled === true) {
      setGardenaPresent(true);
      setGardenaClientId(c.gardena.clientId ?? '');
    }
    const pv = c.globalSignals?.pvPower?.primary;
    if (pv !== undefined) {
      setPvKwp(c.fusionSolar?.pvPeakKwp ?? 8.8);
      setPvOrientation((c.fusionSolar?.orientationHint as PvOrientation) ?? 'southeast');
      setPvBaseUrl(c.fusionSolar?.baseUrl ?? pvBaseUrl);
      if (pv.kind === 'hmip') {
        setPvKind('hmip');
        setPvDeviceId(pv.deviceId);
        setPvFeature(pv.feature);
      } else {
        setPvKind('fusion');
      }
    }
  }, [cfg.config.value]);

  // Reverse-geocode the DWD region from coordinates (debounced, best-effort).
  useEffect(() => {
    const { latitude: lat, longitude: lon } = location;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    let cancelled = false;
    const id = setTimeout(() => {
      void reverseGeocodeRegion(lat, lon).then((name) => {
        if (cancelled || name === null) return;
        setRegion((cur) => (cur.trim() === '' || cur === 'Berlin' || cur === regionAutoRef.current ? name : cur));
        regionAutoRef.current = name;
      });
    }, 700);
    return (): void => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [location.latitude, location.longitude]);

  const shutters = discovery.shutterSources.value;
  const contacts = discovery.contactSources.value;

  // Auto-run discovery the first time the user reaches the rooms/shutters area.
  useEffect(() => {
    const id = STEPS[step]?.id;
    if ((id === 'pv' || id === 'rooms' || id === 'windows') && !discoveredRef.current && !discovery.discovering.value) {
      discoveredRef.current = true;
      void runDiscovery();
    }
  }, [step]);

  const useMyLocation = (): void => {
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation((l) => ({
          ...l,
          latitude: Math.round(pos.coords.latitude * 10000) / 10000,
          longitude: Math.round(pos.coords.longitude * 10000) / 10000,
        }));
      },
      () => {
        /* denied / unavailable — keep manual entry */
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  };

  const addPreset = (p: RoomPreset): void => {
    setDraftRooms((prev) => {
      const existing = new Set(prev.map((r) => r.id));
      const name = t(p.de, p.en);
      const id = newRoomId(name, existing);
      return [
        ...prev,
        {
          id,
          name,
          priority: p.priority,
          targets: { target_c: 23.0, warning_c: 25.0, strong_shade_c: 26.0, critical_c: 27.0 },
          signals: {},
          occupancyMode: 'always_priority',
          activeCooling: false,
        },
      ];
    });
  };

  const addCustomRoom = (): void => {
    setDraftRooms((prev) => {
      const existing = new Set(prev.map((r) => r.id));
      const id = newRoomId(`raum ${prev.length + 1}`, existing);
      return [
        ...prev,
        {
          id,
          name: t(`Raum ${prev.length + 1}`, `Room ${prev.length + 1}`),
          priority: 'medium',
          targets: { target_c: 23.0, warning_c: 25.0, strong_shade_c: 26.0, critical_c: 27.0 },
          signals: {},
          occupancyMode: 'always_priority',
          activeCooling: false,
        },
      ];
    });
  };

  const removeRoom = (id: string): void => {
    setDraftRooms((prev) => prev.filter((r) => r.id !== id));
    setDraftWindows((prev) => prev.filter((w) => w.roomId !== id));
  };

  const assignShutter = (deviceId: string, roomId: string): void => {
    setDraftWindows((prev) => {
      if (roomId === '') return prev.filter((w) => w.id !== deviceId);
      const existing = prev.find((w) => w.id === deviceId);
      if (existing !== undefined) return prev.map((w) => (w.id === deviceId ? { ...w, roomId } : w));
      const meta = shutters.find((d) => d.deviceId === deviceId);
      const isRoof = /dach|velux|roto/.test((meta?.friendlyName ?? '').toLowerCase());
      const win: WindowDef = {
        id: deviceId,
        roomId,
        shutterDeviceId: deviceId,
        automationBlocked: false,
        orientationDeg: 180,
        type: isRoof ? 'roof_window' : 'facade',
        isDoor: false,
        canMoveWhenOpen: true,
        maxPositionWhenOpenPct: 60,
        maxHeatProtectionLevel01: isRoof ? 1 : 0.95,
        sunPrelookMinutes: 60,
        lockoutProtection: true,
        blockSchedules: [],
      };
      return [...prev, win];
    });
  };

  const updateWindow = (deviceId: string, patch: Partial<WindowDef>): void => {
    setDraftWindows((prev) => prev.map((w) => (w.id === deviceId ? { ...w, ...patch } : w)));
  };

  const finish = async (): Promise<void> => {
    const current = cfg.config.value;
    if (current === null) return;
    setSaving(true);
    setSaveErr(null);
    const globalSignals = { ...current.globalSignals };
    if (pvKind === 'fusion') {
      globalSignals.pvPower = { primary: { kind: 'fusion', field: 'activePower' }, staleAfterSec: 600 };
    } else if (pvKind === 'hmip' && pvDeviceId !== '' && pvFeature !== '') {
      globalSignals.pvPower = { primary: { kind: 'hmip', deviceId: pvDeviceId, feature: pvFeature }, staleAfterSec: 600 };
    } else {
      delete globalSignals.pvPower;
    }
    // Peak power + orientation inform the PV scaling regardless of the source
    // kind; the FusionSolar baseUrl only matters when the source IS FusionSolar.
    const merged: Config = {
      ...current,
      location,
      globalSignals,
      fusionSolar:
        pvKind === 'none'
          ? current.fusionSolar
          : {
              baseUrl:
                pvKind === 'fusion'
                  ? pvBaseUrl.trim() || 'http://host.containers.internal:8088'
                  : current.fusionSolar.baseUrl,
              pvPeakKwp: pvKwp,
              orientationHint: pvOrientation,
            },
      rooms: draftRooms,
      windows: draftWindows,
      rules: applyProfile(current.rules, profile),
      dwd: { ...current.dwd, regionName: region.trim().length > 0 ? region.trim() : 'Berlin' },
      gardena: gardenaPresent
        ? { ...current.gardena, enabled: true, clientId: gardenaClientId.trim(), clientSecret: gardenaClientSecret.trim() }
        : { ...current.gardena, enabled: false },
      automationEnabled: activate ? true : current.automationEnabled,
    };
    const ok = await cfg.save(merged);
    setSaving(false);
    if (ok) {
      route('/uebersicht');
    } else {
      setSaveErr(cfg.saveError.value?.error.message ?? t('Speichern fehlgeschlagen.', 'Saving failed.'));
    }
  };

  const meta = STEPS[step];
  if (meta === undefined) {
    return <main class="lg2-main lg2-wiz" data-testid="lg2-wizard" />;
  }
  const isLast = step === STEPS.length - 1;
  const canNext = meta.id === 'location' ? Number.isFinite(location.latitude) && Number.isFinite(location.longitude) : true;

  const next = (): void => {
    if (isLast) {
      void finish();
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const back = (): void => setStep((s) => Math.max(0, s - 1));

  return (
    <main class="lg2-main lg2-wiz" data-testid="lg2-wizard">
      <div class="lg2-wiz__shell">
        <WizardProgress step={step} onJump={(n): void => { if (n <= step) setStep(n); }} />

        <section class="lg2-card lg2-wiz__card">
          <header class="lg2-wiz__head">
            <span class="lg2-wiz__badge"><Icon name={meta.icon} size={24} /></span>
            <div>
              <h1 class="lg2-wiz__title">{t(meta.titleDe, meta.titleEn)}</h1>
              <p class="lg2-wiz__sub">{t(meta.subDe, meta.subEn)}</p>
            </div>
            <span class="lg2-wiz__count">{t(`Schritt ${step + 1} von ${STEPS.length}`, `Step ${step + 1} of ${STEPS.length}`)}</span>
          </header>

          <div class="lg2-wiz__body" data-testid={`lg2-wiz-body-${meta.id}`}>
            {meta.id === 'welcome' && <WelcomeStep />}
            {meta.id === 'location' && (
              <LocationStep location={location} setLocation={setLocation} region={region} setRegion={setRegion} onUseMyLocation={useMyLocation} />
            )}
            {meta.id === 'pv' && (
              <PvStep
                kind={pvKind}
                setKind={setPvKind}
                kwp={pvKwp}
                setKwp={setPvKwp}
                orientation={pvOrientation}
                setOrientation={setPvOrientation}
                baseUrl={pvBaseUrl}
                setBaseUrl={setPvBaseUrl}
                discovery={discovery}
                deviceId={pvDeviceId}
                setDeviceId={setPvDeviceId}
                feature={pvFeature}
                setFeature={setPvFeature}
              />
            )}
            {meta.id === 'gardena' && (
              <GardenaStep
                present={gardenaPresent}
                setPresent={setGardenaPresent}
                clientId={gardenaClientId}
                setClientId={setGardenaClientId}
                clientSecret={gardenaClientSecret}
                setClientSecret={setGardenaClientSecret}
              />
            )}
            {meta.id === 'rooms' && (
              <RoomsStep rooms={draftRooms} onPreset={addPreset} onAdd={addCustomRoom} onRemove={removeRoom} setRooms={setDraftRooms} />
            )}
            {meta.id === 'windows' && (
              <WindowsStep
                discovery={discovery}
                shutters={shutters}
                contacts={contacts}
                rooms={draftRooms}
                windows={draftWindows}
                onAssign={assignShutter}
                onUpdate={updateWindow}
              />
            )}
            {meta.id === 'finish' && (
              <FinishStep
                profile={profile}
                setProfile={setProfile}
                activate={activate}
                setActivate={setActivate}
                roomsCount={draftRooms.length}
                windowsCount={draftWindows.length}
                pvKind={pvKind}
                gardenaPresent={gardenaPresent}
              />
            )}
          </div>

          {saveErr !== null && <p class="lg2-wiz__error" data-testid="lg2-wiz-error">{saveErr}</p>}

          <footer class="lg2-wiz__nav">
            <button type="button" class="lg2-btn lg2-wiz__back" data-testid="lg2-wiz-back" onClick={back} disabled={step === 0}>
              {t('Zurück', 'Back')}
            </button>
            <span class="lg2-wiz__spacer" />
            {!isLast && step > 0 && (
              <button type="button" class="lg2-btn lg2-wiz__skip" data-testid="lg2-wiz-skip" onClick={next}>
                {t('Überspringen', 'Skip')}
              </button>
            )}
            <button
              type="button"
              class="lg2-btn lg2-btn--primary lg2-wiz__next"
              data-testid="lg2-wiz-next"
              onClick={next}
              disabled={!canNext || saving}
            >
              {isLast
                ? saving
                  ? t('Speichert…', 'Saving…')
                  : t('Speichern & starten', 'Save & start')
                : step === 0
                  ? t('Los geht’s', "Let's go")
                  : t('Weiter', 'Next')}
            </button>
          </footer>
        </section>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

function WizardProgress(props: { step: number; onJump: (n: number) => void }): JSX.Element {
  return (
    <ol class="lg2-wiz__progress" data-testid="lg2-wiz-progress">
      {STEPS.map((s, i) => {
        const state = i < props.step ? 'done' : i === props.step ? 'active' : 'todo';
        return (
          <li key={s.id} class={`lg2-wiz__pstep lg2-wiz__pstep--${state}`}>
            <button
              type="button"
              class="lg2-wiz__pdot"
              disabled={i > props.step}
              aria-current={i === props.step ? 'step' : undefined}
              onClick={(): void => props.onJump(i)}
              title={t(s.titleDe, s.titleEn)}
            >
              {state === 'done' ? '✓' : i + 1}
            </button>
            <span class="lg2-wiz__plabel">{t(s.titleDe, s.titleEn)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Reusable big choice card                                                   */
/* -------------------------------------------------------------------------- */

function ChoiceCard(props: {
  selected: boolean;
  icon: IconName;
  title: string;
  desc: string;
  onSelect: () => void;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`lg2-wiz__choice${props.selected ? ' lg2-wiz__choice--on' : ''}`}
      aria-pressed={props.selected}
      data-testid={props.testId}
      onClick={props.onSelect}
    >
      <span class="lg2-wiz__choice-icon"><Icon name={props.icon} size={26} /></span>
      <span class="lg2-wiz__choice-text">
        <span class="lg2-wiz__choice-title">{props.title}</span>
        <span class="lg2-wiz__choice-desc">{props.desc}</span>
      </span>
      <span class="lg2-wiz__choice-check" aria-hidden="true">{props.selected ? '✓' : ''}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

function WelcomeStep(): JSX.Element {
  const items: ReadonlyArray<{ icon: IconName; de: string; en: string }> = [
    { icon: 'haus', de: 'Standort für exakten Sonnenstand', en: 'Location for an accurate sun position' },
    { icon: 'pv', de: 'PV-Anlage (optional) für PV-geführte Beschattung', en: 'PV system (optional) for PV-led shading' },
    { icon: 'tropfen', de: 'GARDENA-Bewässerung (optional)', en: 'GARDENA irrigation (optional)' },
    { icon: 'fenster', de: 'Räume & Rollläden zuordnen', en: 'Assign rooms & shutters' },
  ];
  return (
    <div class="lg2-wiz__welcome">
      <p class="lg2-wiz__lead">
        {t(
          'HeatShield schützt dein Zuhause vorausschauend vor sommerlicher Hitze — auf Basis von Sonnenstand, Wetter und (optional) deiner PV-Erzeugung. Dieser Assistent richtet in wenigen Minuten alles ein.',
          'HeatShield proactively protects your home from summer heat — based on sun position, weather and (optionally) your PV production. This wizard sets everything up in a few minutes.',
        )}
      </p>
      <ul class="lg2-wiz__checklist">
        {items.map((it) => (
          <li key={it.de}>
            <span class="lg2-wiz__checkicon"><Icon name={it.icon} size={18} /></span>
            {t(it.de, it.en)}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface LocationStepProps {
  location: Location;
  setLocation: (l: Location) => void;
  region: string;
  setRegion: (s: string) => void;
  onUseMyLocation: () => void;
}
function LocationStep(props: LocationStepProps): JSX.Element {
  const { location, setLocation, region, setRegion } = props;
  const num = (v: string, fallback: number): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return (
    <div class="lg2-wiz__form">
      <button type="button" class="lg2-btn lg2-wiz__geo" data-testid="lg2-wiz-geo" onClick={props.onUseMyLocation}>
        <Icon name="haus" size={16} /> {t('Meinen Standort verwenden', 'Use my location')}
      </button>
      <div class="lg2-wiz__row2">
        <label class="lg2-wiz__field">
          <span>{t('Breitengrad', 'Latitude')}</span>
          <input
            type="number"
            step={0.0001}
            data-testid="lg2-wiz-lat"
            value={location.latitude}
            onInput={(e): void => setLocation({ ...location, latitude: num((e.currentTarget as HTMLInputElement).value, location.latitude) })}
          />
        </label>
        <label class="lg2-wiz__field">
          <span>{t('Längengrad', 'Longitude')}</span>
          <input
            type="number"
            step={0.0001}
            data-testid="lg2-wiz-lon"
            value={location.longitude}
            onInput={(e): void => setLocation({ ...location, longitude: num((e.currentTarget as HTMLInputElement).value, location.longitude) })}
          />
        </label>
      </div>
      <label class="lg2-wiz__field">
        <span>{t('Zeitzone', 'Time zone')}</span>
        <input
          type="text"
          data-testid="lg2-wiz-tz"
          value={location.timezone}
          onInput={(e): void => setLocation({ ...location, timezone: (e.currentTarget as HTMLInputElement).value })}
        />
      </label>
      <label class="lg2-wiz__field">
        <span>{t('Ort für Unwetterwarnungen (DWD)', 'Location for severe-weather warnings (DWD)')}</span>
        <input
          type="text"
          data-testid="lg2-wiz-region"
          value={region}
          placeholder="Berlin"
          onInput={(e): void => setRegion((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <p class="lg2-wiz__hint">
        {t(
          'Der Ort wird automatisch aus den Koordinaten vorgeschlagen und lässt sich anpassen.',
          'The location is suggested automatically from the coordinates and can be adjusted.',
        )}
      </p>
    </div>
  );
}

interface PvStepProps {
  kind: PvKind;
  setKind: (k: PvKind) => void;
  kwp: number;
  setKwp: (n: number) => void;
  orientation: PvOrientation;
  setOrientation: (o: PvOrientation) => void;
  baseUrl: string;
  setBaseUrl: (s: string) => void;
  discovery: ReturnType<typeof useDiscovery>;
  deviceId: string;
  setDeviceId: (s: string) => void;
  feature: string;
  setFeature: (s: string) => void;
}
function PvStep(props: PvStepProps): JSX.Element {
  const inventory = props.discovery.inventory.value;
  // Devices that expose at least one numeric-looking feature — candidates for a
  // watt/power source (e.g. from the Modbus bridge plugin).
  const powerDevices = inventory.filter((d) => d.features.length > 0 && d.deviceType !== undefined);
  const selected = inventory.find((d) => d.deviceId === props.deviceId);
  const featureList = selected?.features ?? [];

  const pickDevice = (id: string): void => {
    props.setDeviceId(id);
    const dev = inventory.find((d) => d.deviceId === id);
    const feats = dev?.features ?? [];
    // Auto-select a power-ish feature; otherwise the first feature.
    const power = feats.find((f) => POWER_FEATURE_RE.test(f));
    props.setFeature(power ?? feats[0] ?? '');
  };

  return (
    <div class="lg2-wiz__form">
      <div class="lg2-wiz__choices lg2-wiz__choices--3">
        <ChoiceCard
          selected={props.kind === 'none'}
          icon="haus"
          title={t('Keine PV-Anlage', 'No PV system')}
          desc={t('Beschattung nach Sonne und Wetter.', 'Shading based on sun and weather.')}
          onSelect={(): void => props.setKind('none')}
          testId="lg2-wiz-pv-none"
        />
        <ChoiceCard
          selected={props.kind === 'fusion'}
          icon="pv"
          title={t('FusionSolar (Huawei)', 'FusionSolar (Huawei)')}
          desc={t('Live-PV-Leistung des FusionSolar-Plugins.', 'Live PV power from the FusionSolar plugin.')}
          onSelect={(): void => props.setKind('fusion')}
          testId="lg2-wiz-pv-fusion"
        />
        <ChoiceCard
          selected={props.kind === 'hmip'}
          icon="pv"
          title={t('Anderes Watt-Gerät', 'Other watt device')}
          desc={t('Ein HMIP-Gerät mit Leistung (z. B. Modbus-Plugin).', 'An HMIP device reporting power (e.g. Modbus plugin).')}
          onSelect={(): void => props.setKind('hmip')}
          testId="lg2-wiz-pv-hmip"
        />
      </div>

      {props.kind === 'hmip' && (
        <Fragment>
          <div class="lg2-wiz__discoverbar">
            <button
              type="button"
              class="lg2-btn"
              data-testid="lg2-wiz-pv-discover"
              disabled={props.discovery.discovering.value}
              onClick={(): void => { void runDiscovery(); }}
            >
              {props.discovery.discovering.value ? t('Suche läuft…', 'Searching…') : t('Geräte suchen', 'Discover devices')}
            </button>
            <span class="lg2-wiz__discovercount">{t(`${powerDevices.length} Geräte`, `${powerDevices.length} devices`)}</span>
          </div>
          <div class="lg2-wiz__row2">
            <label class="lg2-wiz__field">
              <span>{t('Gerät', 'Device')}</span>
              <select
                data-testid="lg2-wiz-pv-device"
                value={props.deviceId}
                onChange={(e): void => pickDevice((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">{t('— wählen —', '— select —')}</option>
                {powerDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {(d.friendlyName ?? d.deviceId)}{d.deviceType !== undefined ? ` · ${d.deviceType}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label class="lg2-wiz__field">
              <span>{t('Leistungs-Messwert', 'Power value')}</span>
              <select
                data-testid="lg2-wiz-pv-feature"
                value={props.feature}
                disabled={props.deviceId === ''}
                onChange={(e): void => props.setFeature((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">{t('— wählen —', '— select —')}</option>
                {featureList.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>
          <p class="lg2-wiz__hint">
            {t(
              'Wähle das Gerät und den Messwert, der die aktuelle Leistung in Watt liefert. So funktioniert die PV-geführte Beschattung mit jedem System, das Leistung über die HCU meldet.',
              'Pick the device and the value that reports the current power in watts. This lets PV-led shading work with any system that reports power via the HCU.',
            )}
          </p>
        </Fragment>
      )}

      {(props.kind === 'fusion' || props.kind === 'hmip') && (
        <Fragment>
          <div class="lg2-wiz__row2">
            <label class="lg2-wiz__field">
              <span>{t('Spitzenleistung (kWp)', 'Peak power (kWp)')}</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                data-testid="lg2-wiz-pv-kwp"
                value={props.kwp}
                onInput={(e): void => {
                  const n = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(n) && n > 0) props.setKwp(n);
                }}
              />
            </label>
            <label class="lg2-wiz__field">
              <span>{t('Hauptausrichtung', 'Main orientation')}</span>
              <select
                data-testid="lg2-wiz-pv-orientation"
                value={props.orientation}
                onChange={(e): void => props.setOrientation((e.currentTarget as HTMLSelectElement).value as PvOrientation)}
              >
                {PV_ORIENTATIONS.map((o) => (
                  <option key={o.v} value={o.v}>{t(o.de, o.en)}</option>
                ))}
              </select>
            </label>
          </div>
          {props.kind === 'fusion' && (
            <label class="lg2-wiz__field">
              <span>{t('FusionSolar-Plugin URL', 'FusionSolar plugin URL')}</span>
              <input
                type="text"
                data-testid="lg2-wiz-pv-url"
                value={props.baseUrl}
                onInput={(e): void => props.setBaseUrl((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          )}
        </Fragment>
      )}
    </div>
  );
}

interface GardenaStepProps {
  present: boolean;
  setPresent: (b: boolean) => void;
  clientId: string;
  setClientId: (s: string) => void;
  clientSecret: string;
  setClientSecret: (s: string) => void;
}
function GardenaStep(props: GardenaStepProps): JSX.Element {
  return (
    <div class="lg2-wiz__form">
      <div class="lg2-wiz__choices">
        <ChoiceCard
          selected={!props.present}
          icon="haus"
          title={t('Keine Bewässerung', 'No irrigation')}
          desc={t('GARDENA kann später ergänzt werden.', 'GARDENA can be added later.')}
          onSelect={(): void => props.setPresent(false)}
          testId="lg2-wiz-gardena-no"
        />
        <ChoiceCard
          selected={props.present}
          icon="tropfen"
          title={t('GARDENA smart system', 'GARDENA smart system')}
          desc={t('Ventile & Sensoren über die GARDENA-Cloud steuern.', 'Control valves & sensors via the GARDENA cloud.')}
          onSelect={(): void => props.setPresent(true)}
          testId="lg2-wiz-gardena-yes"
        />
      </div>

      {props.present && (
        <Fragment>
          <label class="lg2-wiz__field">
            <span>{t('Application Key', 'Application key')}</span>
            <input
              type="text"
              autocomplete="off"
              data-testid="lg2-wiz-gardena-id"
              value={props.clientId}
              placeholder={t('aus dem GARDENA-Entwicklerportal', 'from the GARDENA developer portal')}
              onInput={(e): void => props.setClientId((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="lg2-wiz__field">
            <span>{t('Application Secret', 'Application secret')}</span>
            <input
              type="password"
              autocomplete="new-password"
              data-testid="lg2-wiz-gardena-secret"
              value={props.clientSecret}
              onInput={(e): void => props.setClientSecret((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <p class="lg2-wiz__hint">
            {t(
              'Lege im GARDENA-Entwicklerportal (developer.husqvarnagroup.cloud) eine Application mit der „Authentication API" und der „GARDENA smart system API" an. Der Secret wird verschlüsselt gespeichert und nie im Log ausgegeben.',
              'In the GARDENA developer portal (developer.husqvarnagroup.cloud) create an application with the "Authentication API" and the "GARDENA smart system API". The secret is stored masked and never logged.',
            )}
          </p>
        </Fragment>
      )}
    </div>
  );
}

interface RoomsStepProps {
  rooms: Room[];
  onPreset: (p: RoomPreset) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  setRooms: (updater: (prev: Room[]) => Room[]) => void;
}
function RoomsStep(props: RoomsStepProps): JSX.Element {
  const rename = (id: string, name: string): void => props.setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  const setPrio = (id: string, priority: Room['priority']): void => props.setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, priority } : r)));
  const setFloor = (id: string, floor: string): void =>
    props.setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        if (floor === '') {
          const { floor: _drop, ...rest } = r;
          return rest as Room;
        }
        return { ...r, floor };
      }),
    );
  return (
    <div class="lg2-wiz__form">
      <p class="lg2-wiz__note" data-testid="lg2-wiz-rooms-disclaimer">
        <Icon name="warnung" size={16} />
        <span>
          {t(
            'Hinweis: Das Plugin kann die in der Homematic-App angelegten Räume nicht auslesen. Lege deine Räume hier neu an — sie sind unabhängig von der App.',
            'Note: the plugin cannot read the rooms defined in the Homematic app. Create your rooms here — they are independent from the app.',
          )}
        </span>
      </p>

      <div class="lg2-wiz__presets" data-testid="lg2-wiz-room-presets">
        <span class="lg2-wiz__presets-label">{t('Schnell anlegen:', 'Quick add:')}</span>
        {ROOM_PRESETS.map((p) => (
          <button key={p.de} type="button" class="lg2-wiz__preset" onClick={(): void => props.onPreset(p)}>
            + {t(p.de, p.en)}
          </button>
        ))}
      </div>

      {props.rooms.length === 0 ? (
        <p class="lg2-wiz__empty" data-testid="lg2-wiz-rooms-empty">
          {t('Noch keine Räume. Nutze die Vorschläge oben oder füge einen eigenen Raum hinzu.', 'No rooms yet. Use the suggestions above or add a custom room.')}
        </p>
      ) : (
        <ul class="lg2-wiz__roomlist" data-testid="lg2-wiz-roomlist">
          {props.rooms.map((r) => (
            <li key={r.id} class="lg2-wiz__roomrow">
              <input
                class="lg2-wiz__roomname"
                type="text"
                value={r.name}
                aria-label={t('Raumname', 'Room name')}
                onInput={(e): void => rename(r.id, (e.currentTarget as HTMLInputElement).value)}
              />
              <select
                class="lg2-wiz__roomfloorsel"
                value={r.floor ?? ''}
                aria-label={t('Stockwerk', 'Floor')}
                onChange={(e): void => setFloor(r.id, (e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">{t('Stockwerk', 'Floor')}</option>
                {FLOOR_OPTIONS.map((f) => (
                  <option key={f.v} value={f.v}>{t(f.de, f.en)}</option>
                ))}
              </select>
              <select
                class="lg2-wiz__roomprio"
                value={r.priority}
                aria-label={t('Priorität', 'Priority')}
                onChange={(e): void => setPrio(r.id, (e.currentTarget as HTMLSelectElement).value as Room['priority'])}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p] ?? p}</option>
                ))}
              </select>
              <button
                type="button"
                class="lg2-wiz__roomdel"
                title={t('Raum entfernen', 'Remove room')}
                aria-label={t(`Raum ${r.name} entfernen`, `Remove room ${r.name}`)}
                onClick={(): void => props.onRemove(r.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" class="lg2-btn lg2-wiz__addroom" data-testid="lg2-wiz-add-room" onClick={props.onAdd}>
        + {t('Eigener Raum', 'Custom room')}
      </button>

      <div class="lg2-wiz__priohelp" data-testid="lg2-wiz-priohelp">
        <span class="lg2-wiz__priohelp-title">{t('Was bedeutet die Priorität?', 'What does priority mean?')}</span>
        <ul>
          {PRIORITY_HELP.map((p) => (
            <li key={p.v}>
              <b>{PRIORITY_LABELS[p.v] ?? p.v}</b> — {t(p.de.replace(/^[^—]+—\s*/u, ''), p.en.replace(/^[^—]+—\s*/u, ''))}
            </li>
          ))}
        </ul>
        <span class="lg2-wiz__priohelp-foot">
          {t('Bei Hitze werden Räume mit höherer Priorität zuerst beschattet und gekühlt.', 'During heat, higher-priority rooms are shaded and cooled first.')}
        </span>
      </div>
    </div>
  );
}

interface WindowsStepProps {
  discovery: ReturnType<typeof useDiscovery>;
  shutters: DiscoveredDevice[];
  contacts: DiscoveredDevice[];
  rooms: Room[];
  windows: WindowDef[];
  onAssign: (deviceId: string, roomId: string) => void;
  onUpdate: (deviceId: string, patch: Partial<WindowDef>) => void;
}
function WindowsStep(props: WindowsStepProps): JSX.Element {
  const assignedCount = props.windows.length;
  return (
    <div class="lg2-wiz__form">
      <div class="lg2-wiz__discoverbar">
        <button
          type="button"
          class="lg2-btn"
          data-testid="lg2-wiz-discover"
          disabled={props.discovery.discovering.value}
          onClick={(): void => { void runDiscovery(); }}
        >
          {props.discovery.discovering.value ? t('Suche läuft…', 'Searching…') : t('Geräte suchen', 'Discover devices')}
        </button>
        <span class="lg2-wiz__discovercount">
          {t(`${props.shutters.length} Rollläden gefunden · ${assignedCount} zugeordnet`, `${props.shutters.length} shutters found · ${assignedCount} assigned`)}
        </span>
      </div>

      {props.rooms.length === 0 && (
        <p class="lg2-wiz__empty">{t('Lege zuerst mindestens einen Raum an (Schritt zurück).', 'Add at least one room first (previous step).')}</p>
      )}

      {props.shutters.length === 0 ? (
        <p class="lg2-wiz__empty" data-testid="lg2-wiz-shutters-empty">
          {t('Noch keine Rollläden gefunden. „Geräte suchen" ausführen — sie erscheinen, sobald die HCU antwortet.', 'No shutters found yet. Run "Discover devices" — they appear as soon as the HCU responds.')}
        </p>
      ) : (
        <ul class="lg2-wiz__shutterlist" data-testid="lg2-wiz-shutterlist">
          {props.shutters.map((d) => {
            const win = props.windows.find((w) => w.id === d.deviceId);
            const assigned = win !== undefined;
            return (
              <li key={d.deviceId} class={`lg2-wiz__shutterrow${assigned ? ' lg2-wiz__shutterrow--on' : ''}`} data-testid={`lg2-wiz-shutter-${d.deviceId}`}>
                <span class="lg2-wiz__shuttername">{deviceLabel(d)}</span>
                <label class="lg2-wiz__inline">
                  <span>{t('Raum', 'Room')}</span>
                  <select
                    data-testid={`lg2-wiz-shutter-room-${d.deviceId}`}
                    value={win?.roomId ?? ''}
                    onChange={(e): void => props.onAssign(d.deviceId, (e.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">{t('— nicht zugeordnet —', '— unassigned —')}</option>
                    {props.rooms.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}{r.floor !== undefined ? ` (${r.floor})` : ''}</option>
                    ))}
                  </select>
                </label>
                {assigned && (
                  <Fragment>
                    <label class="lg2-wiz__inline">
                      <span>{t('Richtung', 'Facing')}</span>
                      <select
                        data-testid={`lg2-wiz-shutter-orient-${d.deviceId}`}
                        value={String(nearestCompassDeg(win?.orientationDeg ?? 180))}
                        onChange={(e): void => props.onUpdate(d.deviceId, { orientationDeg: Number((e.currentTarget as HTMLSelectElement).value) })}
                      >
                        {COMPASS_OPTIONS.map((o) => (
                          <option key={o.deg} value={String(o.deg)}>{t(o.de, o.en)}</option>
                        ))}
                      </select>
                    </label>
                    <label class="lg2-wiz__inline">
                      <span>{t('Typ', 'Type')}</span>
                      <select
                        data-testid={`lg2-wiz-shutter-type-${d.deviceId}`}
                        value={win?.type ?? 'facade'}
                        onChange={(e): void => props.onUpdate(d.deviceId, { type: (e.currentTarget as HTMLSelectElement).value as WindowDef['type'] })}
                      >
                        <option value="facade">{t('Fassade', 'Facade')}</option>
                        <option value="roof_window">{t('Dachfenster', 'Roof window')}</option>
                      </select>
                    </label>
                    {props.contacts.length > 0 && (
                      <label class="lg2-wiz__inline">
                        <span>{t('Fensterkontakt', 'Window contact')}</span>
                        <select
                          data-testid={`lg2-wiz-shutter-contact-${d.deviceId}`}
                          value={win?.contactDeviceId ?? ''}
                          onChange={(e): void => {
                            const v = (e.currentTarget as HTMLSelectElement).value;
                            props.onUpdate(d.deviceId, v.length > 0 ? { contactDeviceId: v } : { contactDeviceId: undefined });
                          }}
                        >
                          <option value="">{t('— keiner —', '— none —')}</option>
                          {props.contacts.map((c) => (
                            <option key={c.deviceId} value={c.deviceId}>{deviceLabel(c)}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </Fragment>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface FinishStepProps {
  profile: ProfileName;
  setProfile: (p: ProfileName) => void;
  activate: boolean;
  setActivate: (b: boolean) => void;
  roomsCount: number;
  windowsCount: number;
  pvKind: PvKind;
  gardenaPresent: boolean;
}
function FinishStep(props: FinishStepProps): JSX.Element {
  const ready = props.roomsCount > 0 && props.windowsCount > 0;
  return (
    <div class="lg2-wiz__form">
      <span class="lg2-wiz__sectionlabel">{t('Verhalten', 'Behaviour')}</span>
      <div class="lg2-wiz__profiles" data-testid="lg2-wiz-profiles">
        {PROFILE_META.map((p) => (
          <button
            key={p.v}
            type="button"
            class={`lg2-wiz__profile${props.profile === p.v ? ' lg2-wiz__profile--on' : ''}`}
            aria-pressed={props.profile === p.v}
            data-testid={`lg2-wiz-profile-${p.v}`}
            onClick={(): void => props.setProfile(p.v)}
          >
            <span class="lg2-wiz__profile-title">{t(p.de, p.en)}</span>
            <span class="lg2-wiz__profile-desc">{t(p.descDe, p.descEn)}</span>
          </button>
        ))}
      </div>

      <div class="lg2-wiz__summary" data-testid="lg2-wiz-summary">
        <SummaryChip ok={props.roomsCount > 0} label={t(`${props.roomsCount} Räume`, `${props.roomsCount} rooms`)} />
        <SummaryChip ok={props.windowsCount > 0} label={t(`${props.windowsCount} Rollläden`, `${props.windowsCount} shutters`)} />
        <SummaryChip ok={props.pvKind === 'fusion'} label={props.pvKind === 'fusion' ? t('PV: FusionSolar', 'PV: FusionSolar') : t('Keine PV', 'No PV')} neutral={props.pvKind !== 'fusion'} />
        <SummaryChip ok={props.gardenaPresent} label={props.gardenaPresent ? t('GARDENA aktiv', 'GARDENA on') : t('Keine Bewässerung', 'No irrigation')} neutral={!props.gardenaPresent} />
      </div>

      <label class="lg2-wiz__activate" data-testid="lg2-wiz-activate">
        <input type="checkbox" checked={props.activate} onChange={(e): void => props.setActivate((e.currentTarget as HTMLInputElement).checked)} />
        <span>
          {t('Automatik nach dem Speichern aktivieren', 'Activate automation after saving')}
          <small>{t('Rollläden werden dann automatisch gefahren. Sturm hat immer Vorrang.', 'Shutters will then move automatically. Storm always takes precedence.')}</small>
        </span>
      </label>

      {!ready && (
        <p class="lg2-wiz__hint lg2-wiz__hint--warn" data-testid="lg2-wiz-notready">
          {t(
            'Hinweis: ohne mindestens einen Raum mit zugeordnetem Rollladen bleibt das Plugin im Einrichtungs-Modus. Du kannst trotzdem speichern und später ergänzen.',
            'Note: without at least one room with an assigned shutter the plugin stays in setup mode. You can still save and add more later.',
          )}
        </p>
      )}
    </div>
  );
}

function SummaryChip(props: { ok: boolean; label: string; neutral?: boolean }): JSX.Element {
  const tone = props.neutral === true ? 'neutral' : props.ok ? 'ok' : 'bad';
  return (
    <span class={`lg2-wiz__chip lg2-wiz__chip--${tone}`}>
      <span class="lg2-wiz__chip-dot" aria-hidden="true" />
      {props.label}
    </span>
  );
}
