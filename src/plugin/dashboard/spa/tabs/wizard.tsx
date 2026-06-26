/**
 * Setup wizard tab (Task 12.4).
 *
 * Mirrors `design.md` §Dashboard / Wizard exactly:
 *
 *   1. **Standort** — latitude / longitude / timezone, Beispielstadt
 *      defaults pre-filled when the config is empty. "Verbindung
 *      testen" uses the inlined `getSunPosition` helper from
 *      `sunPolarPlot.tsx` to render a live sun position so the
 *      user can sanity-check the timezone.
 *   2. **Datenquellen** — `POST /api/sources/discover`, render
 *      results as three lists, let the user pick the OpenMeteo
 *      device that drives the weather feed.
 *   3. **Räume** — simplified rooms list with a priority dropdown
 *      per row.
 *   4. **Fenster** — assign each `WINDOW_COVERING` device to a
 *      room. The roof-window heuristic picks `roof_window` for any
 *      friendly name containing `Dach`, `Velux`, or `Roto`.
 *   5. **Profil & Feintuning** — the same four-button profile
 *      switcher used in the Rules tab.
 *
 * Each step has a "Validieren" button that calls `POST
 * /api/wizard/step/:n` with the per-step body schema documented in
 * `server.ts`. "Weiter" advances to the next step; on step 5
 * "Speichern" finalises and routes back to `/live`.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { navigate } from '../app.js';
import { getSunPosition } from '../components/sunPolarPlot.js';
import { useConfig } from '../hooks/useConfig.js';
import {
  runDiscovery,
  useDiscovery,
  type DiscoveredDevice,
} from '../hooks/useDiscovery.js';
import { DiscoveryStatus } from '../components/discoveryStatus.js';
import { CompassPicker } from '../components/compassPicker.js';
import { deviceLabel, PRIORITY_LABELS } from '../format.js';
import { applyProfile, type ProfileName } from '../profiles.js';
import type {
  Config,
  Location,
  Room,
  Window as WindowDef,
} from '../../../../shared/types.js';

const DEFAULT_LOCATION: Location = {
  latitude: 52.52,
  longitude: 13.41,
  timezone: 'Europe/Berlin',
};

const PRIORITIES: Room['priority'][] = ['very_high', 'high', 'medium', 'low'];
const PROFILES: ProfileName[] = ['conservative', 'standard', 'aggressive', 'custom'];

interface ValidationOutcome {
  ok: boolean;
  message: string;
  issues?: Array<{ path: (string | number)[]; message: string }>;
}

export function WizardTab(): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();
  const [step, setStep] = useState<number>(1);
  const [stepResults, setStepResults] = useState<Record<number, ValidationOutcome | null>>({});
  const [draftLocation, setDraftLocation] = useState<Location>(DEFAULT_LOCATION);
  const [draftRooms, setDraftRooms] = useState<Room[]>([]);
  const [draftWindows, setDraftWindows] = useState<WindowDef[]>([]);
  const [openMeteoDeviceId, setOpenMeteoDeviceId] = useState<string>('');
  const [draftProfile, setDraftProfile] = useState<ProfileName>('standard');

  // Pre-fill draft state from existing config (or Beispielstadt).
  useEffect(() => {
    const c = cfg.config.value;
    if (c === null) {
      return;
    }
    setDraftLocation(c.location);
    setDraftRooms(c.rooms);
    setDraftWindows(c.windows);
    setDraftProfile(c.rules.profile);
  }, [cfg.config.value]);

  const validateStep = async (n: number, body: unknown): Promise<ValidationOutcome> => {
    try {
      const res = await fetch(`/api/wizard/step/${n}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            status?: string;
            error?: {
              code: string;
              message: string;
              issues?: Array<{ path: (string | number)[]; message: string }>;
            };
          }
        | null;
      if (res.ok && json?.ok === true) {
        const ok: ValidationOutcome = {
          ok: true,
          message: `Schritt ${n} validiert (status=${json.status ?? 'unknown'}).`,
        };
        return ok;
      }
      return {
        ok: false,
        message: json?.error?.message ?? `HTTP ${res.status}`,
        ...(json?.error?.issues !== undefined ? { issues: json.error.issues } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'unknown error',
      };
    }
  };

  const handleValidateStep = async (n: number): Promise<void> => {
    let body: unknown = {};
    if (n === 1) {
      body = draftLocation;
    } else if (n === 2) {
      body = {
        sources: {
          fusionSolar: {
            baseUrl: cfg.config.value?.fusionSolar.baseUrl ?? 'http://host.containers.internal:8088',
          },
          openMeteoDeviceId: openMeteoDeviceId.length > 0 ? openMeteoDeviceId : 'placeholder',
        },
        validated: true,
      };
    } else if (n === 3) {
      body = { rooms: draftRooms };
    } else if (n === 4) {
      body = { windows: draftWindows };
    } else if (n === 5) {
      body = { profile: draftProfile };
    }
    const result = await validateStep(n, body);
    setStepResults((prev) => ({ ...prev, [n]: result }));
  };

  const handleSaveAll = async (): Promise<void> => {
    const current = cfg.config.value;
    if (current === null) {
      return;
    }
    const merged: Config = {
      ...current,
      location: draftLocation,
      rooms: draftRooms,
      windows: draftWindows,
      rules: applyProfile(current.rules, draftProfile),
    };
    const ok = await cfg.save(merged);
    if (ok) {
      // Step 5 "Speichern" → back to Live tab.
      navigate('/live');
    }
  };

  const handleAddRoom = (): void => {
    const id = `room-${draftRooms.length + 1}`;
    const newRoom: Room = {
      id,
      name: id,
      priority: 'medium',
      targets: { target_c: 23.0, warning_c: 25.0, strong_shade_c: 26.0, critical_c: 27.0 },
      signals: {},
      occupancyMode: 'always_priority',
    };
    setDraftRooms([...draftRooms, newRoom]);
  };

  const setRoomPriority = (idx: number, priority: Room['priority']): void => {
    setDraftRooms(draftRooms.map((r, i) => (i === idx ? { ...r, priority } : r)));
  };

  const setRoomName = (idx: number, name: string): void => {
    setDraftRooms(draftRooms.map((r, i) => (i === idx ? { ...r, name } : r)));
  };

  const shutters = useMemo<DiscoveredDevice[]>(() => {
    return discovery.shutterSources.value;
  }, [discovery.shutterSources.value]);

  const handleAssignWindow = (deviceId: string, roomId: string): void => {
    setDraftWindows((prev) => {
      const existing = prev.find((w) => w.id === deviceId);
      if (existing !== undefined) {
        return prev.map((w) => (w.id === deviceId ? { ...w, roomId } : w));
      }
      const meta = shutters.find((d) => d.deviceId === deviceId);
      const friendly = (meta?.friendlyName ?? '').toLowerCase();
      const isRoof = /dach|velux|roto/.test(friendly);
      const newWindow: WindowDef = {
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
      };
      return [...prev, newWindow];
    });
  };

  const handleUpdateWindow = (
    deviceId: string,
    patch: Partial<WindowDef>,
  ): void => {
    setDraftWindows((prev) =>
      prev.map((w) => (w.id === deviceId ? { ...w, ...patch } : w)),
    );
  };

  const handleNext = async (): Promise<void> => {
    if (step >= 5) {
      await handleSaveAll();
      return;
    }
    setStep(step + 1);
  };

  const handleBack = (): void => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const result = stepResults[step] ?? null;

  return (
    <section class="tab-wizard" data-testid="tab-wizard">
      <header class="tab-wizard__header">
        <h2>Einrichtungs-Assistent — Schritt {step} / 5</h2>
      </header>

      <ol class="tab-wizard__steps" data-testid="wizard-steps">
        {[1, 2, 3, 4, 5].map((n) => (
          <li
            key={n}
            class={n === step ? 'tab-wizard__step--active' : ''}
            data-testid={`wizard-step-indicator-${n}`}
          >
            {n}
          </li>
        ))}
      </ol>

      <div class="tab-wizard__body" data-testid={`wizard-body-${step}`}>
        {step === 1 && <Step1 location={draftLocation} setLocation={setDraftLocation} />}
        {step === 2 && (
          <Step2
            discovery={discovery}
            openMeteoDeviceId={openMeteoDeviceId}
            setOpenMeteoDeviceId={setOpenMeteoDeviceId}
          />
        )}
        {step === 3 && (
          <Step3
            rooms={draftRooms}
            onAdd={handleAddRoom}
            onPriorityChange={setRoomPriority}
            onNameChange={setRoomName}
          />
        )}
        {step === 4 && (
          <Step4
            shutters={shutters}
            rooms={draftRooms}
            windows={draftWindows}
            contacts={discovery.contactSources.value}
            onAssign={handleAssignWindow}
            onUpdateWindow={handleUpdateWindow}
          />
        )}
        {step === 5 && (
          <Step5 profile={draftProfile} onChange={setDraftProfile} />
        )}
      </div>

      {result !== null && (
        <div
          class={`tab-wizard__validation tab-wizard__validation--${result.ok ? 'ok' : 'fail'}`}
          data-testid={`wizard-validation-${step}`}
        >
          {result.message}
          {result.issues !== undefined && result.issues.length > 0 && (
            <ul>
              {result.issues.map((iss, i) => (
                <li key={i}>
                  {iss.path.join('.')}: {iss.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div class="tab-wizard__actions">
        <button
          type="button"
          data-testid="wizard-validate"
          onClick={(): void => {
            void handleValidateStep(step);
          }}
        >
          Validieren
        </button>
        <button
          type="button"
          data-testid="wizard-back"
          onClick={handleBack}
          disabled={step === 1}
        >
          Zurück
        </button>
        <button
          type="button"
          data-testid="wizard-next"
          onClick={(): void => {
            void handleNext();
          }}
        >
          {step === 5 ? 'Speichern' : 'Weiter'}
        </button>
      </div>
    </section>
  );
}

interface Step1Props {
  location: Location;
  setLocation: (l: Location) => void;
}
function Step1(props: Step1Props): JSX.Element {
  const { location, setLocation } = props;
  const sun = useMemo(
    () => getSunPosition(new Date(), location.latitude, location.longitude),
    [location.latitude, location.longitude],
  );
  return (
    <div data-testid="wizard-step-1">
      <h3>Standort</h3>
      <label>
        Latitude
        <input
          type="number"
          step={0.01}
          data-testid="wizard-latitude"
          value={location.latitude}
          onInput={(e): void => {
            const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) {
              setLocation({ ...location, latitude: v });
            }
          }}
        />
      </label>
      <label>
        Longitude
        <input
          type="number"
          step={0.01}
          data-testid="wizard-longitude"
          value={location.longitude}
          onInput={(e): void => {
            const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) {
              setLocation({ ...location, longitude: v });
            }
          }}
        />
      </label>
      <label>
        Zeitzone
        <input
          type="text"
          data-testid="wizard-timezone"
          value={location.timezone}
          onInput={(e): void =>
            setLocation({
              ...location,
              timezone: (e.currentTarget as HTMLInputElement).value,
            })
          }
        />
      </label>
      <p data-testid="wizard-sun-preview">
        Sonnenstand jetzt: Azimut {sun.azimuthDeg.toFixed(1)}°, Höhe {sun.elevationDeg.toFixed(1)}°
      </p>
    </div>
  );
}

interface Step2Props {
  discovery: ReturnType<typeof useDiscovery>;
  openMeteoDeviceId: string;
  setOpenMeteoDeviceId: (id: string) => void;
}
function Step2(props: Step2Props): JSX.Element {
  const { discovery, openMeteoDeviceId, setOpenMeteoDeviceId } = props;
  return (
    <div data-testid="wizard-step-2">
      <h3>Datenquellen</h3>
      <button
        type="button"
        data-testid="wizard-discover"
        onClick={(): void => {
          void runDiscovery();
        }}
        disabled={discovery.discovering.value}
      >
        {discovery.discovering.value ? 'Suche läuft…' : 'Geräte suchen'}
      </button>
      <DiscoveryStatus discovery={discovery} />
      <h4>Temperatur-Sensoren (HCU)</h4>
      <ul data-testid="wizard-list-climate">
        {discovery.temperatureSources.value.map((d) => (
          <li key={d.deviceId}>
            <strong>{deviceLabel(d)}</strong>
          </li>
        ))}
      </ul>
      <h4>OpenMeteo-Kandidaten</h4>
      <ul data-testid="wizard-list-openmeteo">
        {discovery.openMeteo.value.map((d) => (
          <li key={d.deviceId}>
            <label>
              <input
                type="radio"
                name="wizard-openmeteo"
                data-testid={`wizard-openmeteo-${d.deviceId}`}
                checked={openMeteoDeviceId === d.deviceId}
                onChange={(): void => setOpenMeteoDeviceId(d.deviceId)}
              />
              {deviceLabel(d)}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Step3Props {
  rooms: Room[];
  onAdd: () => void;
  onPriorityChange: (idx: number, priority: Room['priority']) => void;
  onNameChange: (idx: number, name: string) => void;
}
function Step3(props: Step3Props): JSX.Element {
  return (
    <div data-testid="wizard-step-3">
      <h3>Räume</h3>
      <button type="button" data-testid="wizard-add-room" onClick={props.onAdd}>
        + Raum hinzufügen
      </button>
      {props.rooms.length === 0 ? (
        <p>Noch keine Räume. Lege mindestens einen Raum an.</p>
      ) : (
        <table data-testid="wizard-rooms-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Priorität</th>
            </tr>
          </thead>
          <tbody>
            {props.rooms.map((r, idx) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="text"
                    data-testid={`wizard-room-name-${r.id}`}
                    value={r.name}
                    onInput={(e): void =>
                      props.onNameChange(idx, (e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </td>
                <td>
                  <select
                    data-testid={`wizard-room-priority-${r.id}`}
                    value={r.priority}
                    onChange={(e): void =>
                      props.onPriorityChange(
                        idx,
                        (e.currentTarget as HTMLSelectElement).value as Room['priority'],
                      )
                    }
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface Step4Props {
  shutters: DiscoveredDevice[];
  rooms: Room[];
  windows: WindowDef[];
  contacts: DiscoveredDevice[];
  onAssign: (deviceId: string, roomId: string) => void;
  onUpdateWindow: (deviceId: string, patch: Partial<WindowDef>) => void;
}

function Step4(props: Step4Props): JSX.Element {
  return (
    <div data-testid="wizard-step-4">
      <h3>Fenster &amp; Rollläden</h3>
      {props.shutters.length === 0 && (
        <p>
          Keine Rollladen-Geräte erkannt (Geräte mit shutterLevel-Feature).
          Geräte­suche in Schritt 2 ausführen.
        </p>
      )}
      <table class="window-table">
        <thead>
          <tr>
            <th>Rollladen</th>
            <th>Raum</th>
            <th>Himmelsrichtung</th>
            <th>Typ</th>
            <th>Fensterkontakt</th>
            <th>Max. Schließung</th>
            <th>Blockiert</th>
          </tr>
        </thead>
        <tbody>
          {props.shutters.map((d) => {
            const assigned = props.windows.find((w) => w.id === d.deviceId);
            const isAssigned = assigned !== undefined;
            return (
              <tr key={d.deviceId} data-testid={`wizard-window-row-${d.deviceId}`}>
                <td>
                  <strong>{deviceLabel(d)}</strong>
                </td>
                <td>
                  <select
                    data-testid={`wizard-window-room-${d.deviceId}`}
                    value={assigned?.roomId ?? ''}
                    onChange={(e): void =>
                      props.onAssign(d.deviceId, (e.currentTarget as HTMLSelectElement).value)
                    }
                  >
                    <option value="">— wählen —</option>
                    {props.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <CompassPicker
                    value={assigned?.orientationDeg ?? 180}
                    disabled={!isAssigned}
                    size={100}
                    onChange={(deg): void =>
                      props.onUpdateWindow(d.deviceId, { orientationDeg: deg })
                    }
                  />
                </td>
                <td>
                  <select
                    data-testid={`wizard-window-wtype-${d.deviceId}`}
                    disabled={!isAssigned}
                    value={assigned?.type ?? 'facade'}
                    onChange={(e): void =>
                      props.onUpdateWindow(d.deviceId, {
                        type: (e.currentTarget as HTMLSelectElement)
                          .value as WindowDef['type'],
                      })
                    }
                  >
                    <option value="facade">Fassade</option>
                    <option value="roof_window">Dachfenster</option>
                  </select>
                </td>
                <td>
                  <select
                    data-testid={`wizard-window-contact-${d.deviceId}`}
                    disabled={!isAssigned}
                    value={assigned?.contactDeviceId ?? ''}
                    onChange={(e): void => {
                      const v = (e.currentTarget as HTMLSelectElement).value;
                      props.onUpdateWindow(d.deviceId, {
                        contactDeviceId: v.length > 0 ? v : undefined,
                      });
                    }}
                  >
                    <option value="">— kein —</option>
                    {props.contacts.map((c) => (
                      <option key={c.deviceId} value={c.deviceId}>
                        {deviceLabel(c)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <label class="window-table__cap">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      data-testid={`wizard-window-cap-${d.deviceId}`}
                      disabled={!isAssigned}
                      value={Math.round(
                        (assigned?.maxHeatProtectionLevel01 ??
                          (assigned?.type === 'roof_window' ? 1 : 0.95)) * 100,
                      )}
                      onInput={(e): void => {
                        const pct = Number.parseInt(
                          (e.currentTarget as HTMLInputElement).value,
                          10,
                        );
                        if (Number.isFinite(pct)) {
                          props.onUpdateWindow(d.deviceId, {
                            maxHeatProtectionLevel01: Math.min(100, Math.max(0, pct)) / 100,
                          });
                        }
                      }}
                    />
                    <span>%</span>
                  </label>
                </td>
                <td>
                  <label class="window-table__block">
                    <input
                      type="checkbox"
                      data-testid={`wizard-window-blocked-${d.deviceId}`}
                      disabled={!isAssigned}
                      checked={assigned?.automationBlocked ?? false}
                      onChange={(e): void =>
                        props.onUpdateWindow(d.deviceId, {
                          automationBlocked: (e.currentTarget as HTMLInputElement).checked,
                        })
                      }
                    />
                    <span>Automatik aus</span>
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Step5Props {
  profile: ProfileName;
  onChange: (profile: ProfileName) => void;
}
function Step5(props: Step5Props): JSX.Element {
  return (
    <div data-testid="wizard-step-5">
      <h3>Profil & Feintuning</h3>
      <div class="tab-wizard__profile-switcher" role="tablist">
        {PROFILES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={props.profile === p}
            data-testid={`wizard-profile-${p}`}
            onClick={(): void => props.onChange(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <p>
        Aktuell gewählt: <strong>{props.profile}</strong>
      </p>
    </div>
  );
}
