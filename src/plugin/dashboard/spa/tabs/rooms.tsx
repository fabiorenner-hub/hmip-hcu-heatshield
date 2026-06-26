/**
 * Rooms & Windows tab (Task 12.1).
 *
 * Two-column layout:
 *
 *   - **Left**: list of configured rooms. Each room card carries
 *     the four target temperatures (regelwerk §19) and acts as a
 *     drop target for HMIP `WINDOW_COVERING` devices.
 *   - **Right**: list of discovered `WINDOW_COVERING` devices
 *     (after pressing the discovery button). Each device shows
 *     `friendlyName`, `deviceId`, and the room it is currently
 *     assigned to (or `Unassigned`). Devices are draggable.
 *
 * Drag-and-drop is implemented with the native HTML5 API — no
 * extra library. The `dataTransfer` payload carries the device id;
 * the drop target is identified by `data-drop-room-id` on the room
 * card, plus a virtual `__unassigned__` slot that detaches a
 * window from its room.
 *
 * On save the merged config is sent through `PUT /api/config`. The
 * server's Zod validation catches any structural error and
 * returns `error.issues[*].path`, which we render as inline
 * highlights on the offending room or window row.
 */

import { Fragment, h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  Config,
  Room,
  RoomTargets,
  Window as WindowDef,
} from '../../../../shared/types.js';
import { runDiscovery, useDiscovery, type DiscoveredDevice } from '../hooks/useDiscovery.js';
import { parseDnd, serializeDnd } from '../hooks/useDeviceDnd.js';
import { DiscoveryStatus } from '../components/discoveryStatus.js';
import { useConfig } from '../hooks/useConfig.js';
import {
  deviceLabel,
  compassLabel,
  TARGET_LABELS,
  PRIORITY_LABELS,
  WINDOW_TYPE_LABELS,
} from '../format.js';

const PRIORITIES: Room['priority'][] = ['very_high', 'high', 'medium', 'low'];

/** Compass directions for the window orientation selector (0=N … clockwise). */
const COMPASS_OPTIONS: ReadonlyArray<{ deg: number; label: string }> = [
  { deg: 0, label: 'Nord' },
  { deg: 45, label: 'Nordost' },
  { deg: 90, label: 'Ost' },
  { deg: 135, label: 'Südost' },
  { deg: 180, label: 'Süd' },
  { deg: 225, label: 'Südwest' },
  { deg: 270, label: 'West' },
  { deg: 315, label: 'Nordwest' },
];

/** Snap an arbitrary orientation to the nearest 45° compass option. */
function nearestCompassDeg(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  const snapped = Math.round(norm / 45) * 45;
  return snapped === 360 ? 0 : snapped;
}

/**
 * Quick-add room presets grouped by floor. Fully optional — the user
 * can still add fully custom rooms. Priorities follow the steering
 * profile (sleeping/working/living rooms are the heat-priority ones).
 * The list is extensible: add an entry here and it appears as a
 * one-click button. Rooms are otherwise free-form (any name/floor).
 */
interface RoomPreset {
  name: string;
  floor: string;
  priority: Room['priority'];
}

/**
 * Common floor/level presets offered as a datalist on every room card.
 * The control stays free-text (the schema allows any string up to 40
 * chars) — the presets are just one-click conveniences. Ordered bottom
 * → top to match the house-twin floor stacking (KG bottom … DG top).
 */
const FLOOR_PRESETS: readonly string[] = ['KG', 'EG', 'OG', 'DG'];

const ROOM_PRESETS: readonly RoomPreset[] = [
  { name: 'Schlafzimmer', floor: 'OG', priority: 'very_high' },
  { name: 'Arbeitszimmer', floor: 'OG', priority: 'high' },
  { name: 'Gästezimmer', floor: 'OG', priority: 'medium' },
  { name: 'Badezimmer', floor: 'OG', priority: 'medium' },
  { name: 'Küche', floor: 'EG', priority: 'low' },
  { name: 'Garderobe', floor: 'EG', priority: 'low' },
  { name: 'Flur', floor: 'EG', priority: 'low' },
  { name: 'Wohnzimmer', floor: 'EG', priority: 'high' },
  { name: 'Keller', floor: 'KG', priority: 'low' },
];

/**
 * Default targets if the user adds a room without typing the four
 * temperature values. Mirrors regelwerk §19's "standard" profile.
 */
const DEFAULT_TARGETS: RoomTargets = {
  target_c: 23.0,
  warning_c: 25.0,
  strong_shade_c: 26.0,
  critical_c: 27.0,
};

/**
 * Sentinel room id used by the drag-and-drop layer to mean "drop
 * here to detach from any room". The unassigned slot does not
 * appear in the persisted config — it is purely a visual affordance
 * that lets users move a window out of a room without deleting it.
 *
 * Persisted windows always carry a real `roomId`; the
 * `__unassigned__` virtual id is only ever a transient state
 * tracked in the SPA's local form state. On save we drop any
 * window that is still virtually unassigned, since the schema
 * requires `roomId` to point at a real room.
 */
const VIRTUAL_UNASSIGNED_ROOM_ID = '__unassigned__';

function newRoomId(prefix: string, existing: ReadonlySet<string>): string {
  const slug = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = slug.length > 0 ? slug : 'room';
  let candidate = base;
  let n = 1;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

interface AddRoomFormState {
  open: boolean;
  id: string;
  name: string;
  floor: string;
  priority: Room['priority'];
  targets: RoomTargets;
}

const INITIAL_ADD_ROOM_FORM: AddRoomFormState = {
  open: false,
  id: '',
  name: '',
  floor: '',
  priority: 'medium',
  targets: { ...DEFAULT_TARGETS },
};

export function RoomsTab(): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();

  const [draftRooms, setDraftRooms] = useState<Room[]>([]);
  const [draftWindows, setDraftWindows] = useState<WindowDef[]>([]);
  const [windowAssignments, setWindowAssignments] = useState<Record<string, string>>({});
  const [dragHoverRoomId, setDragHoverRoomId] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<AddRoomFormState>(INITIAL_ADD_ROOM_FORM);

  // Hydrate the local draft from the server config exactly once; after that
  // the draft is the source of truth (auto-save pushes changes back). A
  // `touched` flag gates auto-save so the initial hydration — which lands
  // across three separate setState calls — never fires a spurious save.
  const hydratedRef = useRef<boolean>(false);
  const touchedRef = useRef<boolean>(false);

  // Sync local draft state from the server-side config on first load only.
  useEffect(() => {
    const c = cfg.config.value;
    if (c === null || hydratedRef.current) {
      return;
    }
    hydratedRef.current = true;
    setDraftRooms(c.rooms);
    setDraftWindows(c.windows);
    const initial: Record<string, string> = {};
    for (const w of c.windows) {
      initial[w.id] = w.roomId;
    }
    setWindowAssignments(initial);
  }, [cfg.config.value]);

  // Auto-discover on first mount so already-assigned shutters/sensors/contacts
  // are visible without pressing "Geräte suchen".
  useEffect(() => {
    if (discovery.inventory.value.length === 0 && !discovery.discovering.value) {
      void runDiscovery();
    }
  }, []);

  // Discovered shutter devices = every device exposing a
  // `shutterLevel` feature (BRAND_SHUTTER, Velux/PLUGIN_EXTERNAL, …),
  // NOT a `deviceType === 'WINDOW_COVERING'` filter — that enum only
  // applies to plugin-OWN devices and never matches native HmIP
  // shutters read from getSystemState.
  const discoveredShutters = useMemo<DiscoveredDevice[]>(() => {
    return discovery.shutterSources.value;
  }, [discovery.shutterSources.value]);

  const issuePathsByWindow = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    const issues = cfg.saveError.value?.error.issues ?? [];
    for (const i of issues) {
      if (i.path[0] === 'windows' && typeof i.path[1] === 'number') {
        const w = draftWindows[i.path[1]];
        if (w) {
          out.add(w.id);
        }
      }
    }
    return out;
  }, [cfg.saveError.value, draftWindows]);

  const issuePathsByRoom = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    const issues = cfg.saveError.value?.error.issues ?? [];
    for (const i of issues) {
      if (i.path[0] === 'rooms' && typeof i.path[1] === 'number') {
        const r = draftRooms[i.path[1]];
        if (r) {
          out.add(r.id);
        }
      }
    }
    return out;
  }, [cfg.saveError.value, draftRooms]);

  const onDragStart = (e: DragEvent, deviceId: string): void => {
    e.dataTransfer?.setData('text/plain', serializeDnd({ kind: 'shutter', deviceId }));
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  };

  const onDragStartTempSensor = (e: DragEvent, deviceId: string): void => {
    e.dataTransfer?.setData('text/plain', serializeDnd({ kind: 'tempSensor', deviceId }));
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  };

  const onDragStartContact = (e: DragEvent, deviceId: string): void => {
    e.dataTransfer?.setData('text/plain', serializeDnd({ kind: 'contact', deviceId }));
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  };

  // Assign a window contact sensor to a specific shutter/window.
  const assignContact = (windowId: string, deviceId: string): void => {
    touchedRef.current = true;
    setDraftWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, contactDeviceId: deviceId } : w)),
    );
  };

  // Remove the contact assignment from a window.
  const clearContact = (windowId: string): void => {
    touchedRef.current = true;
    setDraftWindows((prev) =>
      prev.map((w) => {
        if (w.id !== windowId) {
          return w;
        }
        const { contactDeviceId: _omit, ...rest } = w;
        return rest as WindowDef;
      }),
    );
  };

  // Assign a temperature sensor as a room's indoorTemp primary source.
  const assignTempSensor = (roomId: string, deviceId: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) {
          return r;
        }
        const existing = r.signals.indoorTemp;
        const primary = { kind: 'hmip' as const, deviceId, feature: 'actualTemperature' };
        const indoorTemp =
          existing !== undefined
            ? { ...existing, primary }
            : { staleAfterSec: 600, primary };
        return { ...r, signals: { ...r.signals, indoorTemp } };
      }),
    );
  };

  const onDragOverRoom = (e: DragEvent, roomId: string): void => {
    e.preventDefault();
    setDragHoverRoomId(roomId);
  };

  const onDragLeaveRoom = (): void => {
    setDragHoverRoomId(null);
  };

  const onDropRoom = (e: DragEvent, roomId: string): void => {
    e.preventDefault();
    setDragHoverRoomId(null);
    const payload = parseDnd(e.dataTransfer?.getData('text/plain') ?? '');
    if (payload === null) {
      return;
    }
    touchedRef.current = true;
    if (payload.kind === 'tempSensor') {
      assignTempSensor(roomId, payload.deviceId);
      return;
    }
    if (payload.kind === 'contact') {
      // Contacts are assigned per-window (dropped on a shutter row), not on
      // the room as a whole — ignore a stray drop on the room background.
      return;
    }
    // Default / 'shutter': assign or create the window for this room.
    const deviceId = payload.deviceId;
    setWindowAssignments((prev) => ({ ...prev, [deviceId]: roomId }));
    setDraftWindows((prev) => {
      const existing = prev.find((w) => w.id === deviceId || w.shutterDeviceId === deviceId);
      if (existing !== undefined) {
        return prev.map((w) => {
          if (w.id === deviceId || w.shutterDeviceId === deviceId) {
            return { ...w, roomId };
          }
          return w;
        });
      }
      // Synthesise a brand-new window for a freshly dropped
      // discovered device. Field defaults match `WindowSchema`.
      const meta = discoveredShutters.find((d) => d.deviceId === deviceId);
      const orientationDeg = 180; // default S; user picks orientation later
      const friendly = (meta?.friendlyName ?? '').toLowerCase();
      const isRoof = /dach|velux|roto/.test(friendly);
      const newWindow: WindowDef = {
        id: deviceId,
        roomId,
        shutterDeviceId: deviceId,
        automationBlocked: false,
        orientationDeg,
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

  const onDropUnassigned = (e: DragEvent): void => {
    e.preventDefault();
    setDragHoverRoomId(null);
    const payload = parseDnd(e.dataTransfer?.getData('text/plain') ?? '');
    if (payload === null || payload.kind === 'tempSensor') {
      return;
    }
    touchedRef.current = true;
    setWindowAssignments((prev) => ({
      ...prev,
      [payload.deviceId]: VIRTUAL_UNASSIGNED_ROOM_ID,
    }));
  };

  const handleAddRoom = (): void => {
    setAddForm({ ...INITIAL_ADD_ROOM_FORM, open: true });
  };

  const handleAddRoomSubmit = (e: Event): void => {
    e.preventDefault();
    touchedRef.current = true;
    const existing = new Set(draftRooms.map((r) => r.id));
    const id =
      addForm.id.trim().length > 0 ? addForm.id.trim() : newRoomId(addForm.name, existing);
    const name = addForm.name.trim().length > 0 ? addForm.name.trim() : id;
    const floor = addForm.floor.trim();
    const newRoom: Room = {
      id,
      name,
      priority: addForm.priority,
      targets: addForm.targets,
      signals: {},
      occupancyMode: 'always_priority',
      ...(floor.length > 0 ? { floor } : {}),
    };
    setDraftRooms((prev) => [...prev, newRoom]);
    setAddForm(INITIAL_ADD_ROOM_FORM);
  };

  const handleAddPreset = (preset: RoomPreset): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => {
      const existing = new Set(prev.map((r) => r.id));
      const id = newRoomId(preset.name, existing);
      const newRoom: Room = {
        id,
        name: preset.name,
        floor: preset.floor,
        priority: preset.priority,
        targets: { ...DEFAULT_TARGETS },
        signals: {},
        occupancyMode: 'always_priority',
      };
      return [...prev, newRoom];
    });
  };

  const windowsByRoom = useMemo<Map<string, WindowDef[]>>(() => {
    const out = new Map<string, WindowDef[]>();
    for (const w of draftWindows) {
      const assigned = windowAssignments[w.id] ?? w.roomId;
      const list = out.get(assigned) ?? [];
      list.push(w);
      out.set(assigned, list);
    }
    return out;
  }, [draftWindows, windowAssignments]);

  const roomNameById = useMemo<Map<string, string>>(() => {
    const out = new Map<string, string>();
    for (const r of draftRooms) {
      out.set(r.id, r.name);
    }
    return out;
  }, [draftRooms]);

  const handleRenameRoom = (roomId: string, name: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, name } : r)));
  };

  // Edit a room's free-form floor/level label. An empty value drops the
  // `floor` key entirely (the schema field is optional → room sorts into
  // "Sonstige"). Persisted via the shared auto-save path.
  const handleChangeFloor = (roomId: string, floor: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) {
          return r;
        }
        if (floor.trim().length === 0) {
          const { floor: _omit, ...rest } = r;
          return rest as Room;
        }
        return { ...r, floor };
      }),
    );
  };

  // Edit a room's quiet schedule (V1.5): `noMoveBeforeHour` / `noMoveAfterHour`.
  // `null` clears the bound (drops the optional key). Persisted via auto-save.
  const handleChangeRoomSchedule = (
    roomId: string,
    key: 'noMoveBeforeHour' | 'noMoveAfterHour',
    value: number | null,
  ): void => {
    touchedRef.current = true;
    setDraftRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) {
          return r;
        }
        const next = { ...r };
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      }),
    );
  };

  const handleToggleWindowBlock = (windowId: string, blocked: boolean): void => {
    touchedRef.current = true;
    setDraftWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, automationBlocked: blocked } : w)),
    );
  };

  const handleChangeOrientation = (windowId: string, deg: number): void => {
    touchedRef.current = true;
    setDraftWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, orientationDeg: deg } : w)),
    );
  };

  const handleDeleteRoom = (roomId: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.filter((r) => r.id !== roomId));
    // Drop the room's windows and their assignments so nothing dangles.
    setDraftWindows((prev) => prev.filter((w) => (windowAssignments[w.id] ?? w.roomId) !== roomId));
    setWindowAssignments((prev) => {
      const next = { ...prev };
      for (const [devId, assigned] of Object.entries(prev)) {
        if (assigned === roomId) {
          delete next[devId];
        }
      }
      return next;
    });
  };

  // Auto-save: whenever the draft diverges from the server-side config,
  // schedule a debounced PUT. Only fires after a real user action
  // (`touchedRef`) so the initial multi-setState hydration never saves.
  useEffect(() => {
    if (!touchedRef.current) {
      return;
    }
    const current = cfg.config.value;
    if (current === null) {
      return;
    }
    const persistableWindows = draftWindows.filter(
      (w) => windowAssignments[w.id] !== VIRTUAL_UNASSIGNED_ROOM_ID,
    );
    const next: Config = {
      ...current,
      rooms: draftRooms,
      windows: persistableWindows,
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      cfg.scheduleSave(next);
    }
  }, [draftRooms, draftWindows, windowAssignments]);

  return (
    <section class="tab-rooms" data-testid="tab-rooms">
      <header class="tab-rooms__header">
        <h2>Räume und Fenster</h2>
        <div class="tab-rooms__actions">
          <button
            type="button"
            data-testid="rooms-discover"
            onClick={(): void => {
              void runDiscovery();
            }}
          >
            {discovery.discovering.value ? 'Suche läuft…' : 'Geräte suchen'}
          </button>
          <button
            type="button"
            data-testid="rooms-add"
            onClick={handleAddRoom}
          >
            Raum hinzufügen
          </button>
          <span class="tab-rooms__autosave" data-testid="rooms-autosave">
            {cfg.loading.value ? 'Speichert…' : 'Automatisch gespeichert'}
          </span>
        </div>
      </header>

      <DiscoveryStatus discovery={discovery} />

      <div class="tab-rooms__presets" data-testid="rooms-presets">
        <span class="tab-rooms__presets-label">Schnell anlegen:</span>
        {ROOM_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            class="tab-rooms__preset-btn"
            data-testid={`rooms-preset-${p.name}`}
            title={`${p.floor} · Priorität ${p.priority}`}
            onClick={(): void => handleAddPreset(p)}
          >
            + {p.name} <small>({p.floor})</small>
          </button>
        ))}
      </div>

      {cfg.loadError.value !== null && (
        <p class="tab-rooms__error" data-testid="rooms-load-error">
          {cfg.loadError.value}
        </p>
      )}

      {cfg.saveError.value !== null && (
        <div class="tab-rooms__error" data-testid="rooms-save-error">
          <strong>{cfg.saveError.value.error.message}</strong>
          {cfg.saveError.value.error.issues && (
            <ul>
              {cfg.saveError.value.error.issues.map((iss, idx) => (
                <li key={idx}>
                  {iss.path.join('.')}: {iss.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cfg.saveOk.value && (
        <p class="tab-rooms__ok" data-testid="rooms-save-ok">
          Konfiguration gespeichert.
        </p>
      )}

      {addForm.open && (
        <form
          class="tab-rooms__add-form"
          data-testid="rooms-add-form"
          onSubmit={handleAddRoomSubmit}
        >
          <label>
            Id
            <input
              data-testid="rooms-add-id"
              value={addForm.id}
              onInput={(e): void =>
                setAddForm({ ...addForm, id: (e.currentTarget as HTMLInputElement).value })
              }
            />
          </label>
          <label>
            Name
            <input
              data-testid="rooms-add-name"
              value={addForm.name}
              onInput={(e): void =>
                setAddForm({ ...addForm, name: (e.currentTarget as HTMLInputElement).value })
              }
            />
          </label>
          <label>
            Stockwerk
            <input
              data-testid="rooms-add-floor"
              placeholder="z.B. OG / EG / KG"
              value={addForm.floor}
              onInput={(e): void =>
                setAddForm({ ...addForm, floor: (e.currentTarget as HTMLInputElement).value })
              }
            />
          </label>
          <label>
            Priorität
            <select
              data-testid="rooms-add-priority"
              value={addForm.priority}
              onChange={(e): void =>
                setAddForm({
                  ...addForm,
                  priority: (e.currentTarget as HTMLSelectElement).value as Room['priority'],
                })
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
            <label key={k}>
              {TARGET_LABELS[k]}
              <input
                type="number"
                step={0.1}
                data-testid={`rooms-add-${k}`}
                value={addForm.targets[k]}
                onInput={(e): void => {
                  const raw = (e.currentTarget as HTMLInputElement).value;
                  const next = Number.parseFloat(raw);
                  setAddForm({
                    ...addForm,
                    targets: {
                      ...addForm.targets,
                      [k]: Number.isFinite(next) ? next : addForm.targets[k],
                    },
                  });
                }}
              />
            </label>
          ))}
          <div class="tab-rooms__add-form-actions">
            <button type="submit" data-testid="rooms-add-submit">Hinzufügen</button>
            <button
              type="button"
              data-testid="rooms-add-cancel"
              onClick={(): void => setAddForm(INITIAL_ADD_ROOM_FORM)}
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}

      <div class="tab-rooms__grid">
        <div class="tab-rooms__col">
          <h3>Räume</h3>
          {draftRooms.length === 0 && (
            <p class="tab-rooms__hint">
              Noch keine Räume. „Raum hinzufügen" oder ein Preset oben nutzen.
            </p>
          )}
          {draftRooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              windows={windowsByRoom.get(room.id) ?? []}
              dragOver={dragHoverRoomId === room.id}
              hasIssue={issuePathsByRoom.has(room.id)}
              onDragOver={(e): void => onDragOverRoom(e, room.id)}
              onDragLeave={onDragLeaveRoom}
              onDrop={(e): void => onDropRoom(e, room.id)}
              issueWindowIds={issuePathsByWindow}
              shutters={discoveredShutters}
              tempSensors={discovery.temperatureSources.value}
              contacts={discovery.contactSources.value}
              onRename={(name): void => handleRenameRoom(room.id, name)}
              onChangeFloor={(floor): void => handleChangeFloor(room.id, floor)}
              onChangeSchedule={(key, value): void =>
                handleChangeRoomSchedule(room.id, key, value)
              }
              onToggleWindowBlock={handleToggleWindowBlock}
              onChangeOrientation={handleChangeOrientation}
              onDelete={(): void => handleDeleteRoom(room.id)}
              onAssignContact={assignContact}
              onClearContact={clearContact}
            />
          ))}
          <div
            class={`tab-rooms__unassigned ${
              dragHoverRoomId === VIRTUAL_UNASSIGNED_ROOM_ID ? 'tab-rooms__unassigned--over' : ''
            }`}
            data-testid="rooms-unassigned-target"
            onDragOver={(e): void => {
              e.preventDefault();
              setDragHoverRoomId(VIRTUAL_UNASSIGNED_ROOM_ID);
            }}
            onDragLeave={onDragLeaveRoom}
            onDrop={onDropUnassigned}
          >
            Hierher ziehen, um die Zuweisung aufzuheben
          </div>
        </div>

        <div class="tab-rooms__col">
          <h3>Gefundene Rollläden ({discoveredShutters.length})</h3>
          {discoveredShutters.length === 0 ? (
            <p class="tab-rooms__hint" data-testid="rooms-discover-empty">
              „Geräte suchen" ausführen, um HMIP-Rollläden (Geräte mit
              shutterLevel-Feature) auf der HCU zu finden.
            </p>
          ) : (
            <ul class="tab-rooms__device-list">
              {discoveredShutters.map((d) => {
                const assignedRoomId = windowAssignments[d.deviceId];
                const label =
                  assignedRoomId === undefined ||
                  assignedRoomId === VIRTUAL_UNASSIGNED_ROOM_ID
                    ? 'Nicht zugewiesen'
                    : roomNameById.get(assignedRoomId) ?? assignedRoomId;
                return (
                  <li
                    key={d.deviceId}
                    draggable={true}
                    data-testid={`rooms-device-${d.deviceId}`}
                    onDragStart={(e): void => onDragStart(e as DragEvent, d.deviceId)}
                  >
                    <strong>{deviceLabel(d)}</strong>
                    <small>Raum: {label}</small>
                  </li>
                );
              })}
            </ul>
          )}

          <h3>Temperatur-Sensoren ({discovery.temperatureSources.value.length})</h3>
          {discovery.temperatureSources.value.length === 0 ? (
            <p class="tab-rooms__hint" data-testid="rooms-tempsensors-empty">
              „Geräte suchen" ausführen, um Thermostate/Sensoren (mit
              actualTemperature-Feature) zu finden. Auf eine Raumkarte ziehen,
              um sie als Innentemperatur-Quelle zu setzen.
            </p>
          ) : (
            <ul class="tab-rooms__device-list">
              {discovery.temperatureSources.value.map((d) => (
                <li
                  key={d.deviceId}
                  draggable={true}
                  data-testid={`rooms-tempsensor-${d.deviceId}`}
                  onDragStart={(e): void => onDragStartTempSensor(e as DragEvent, d.deviceId)}
                >
                  <strong>{deviceLabel(d)}</strong>
                  <small>Auf Raum ziehen → Innentemperatur</small>
                </li>
              ))}
            </ul>
          )}

          <h3>Fensterkontakte ({discovery.contactSources.value.length})</h3>
          {discovery.contactSources.value.length === 0 ? (
            <p class="tab-rooms__hint" data-testid="rooms-contacts-empty">
              „Geräte suchen" ausführen, um Fensterkontakte (mit
              windowState-Feature) zu finden. Auf einen Rollladen ziehen, um
              ihn als Fenstersensor für die Lüften-Erkennung zuzuweisen.
            </p>
          ) : (
            <ul class="tab-rooms__device-list">
              {discovery.contactSources.value.map((d) => (
                <li
                  key={d.deviceId}
                  draggable={true}
                  data-testid={`rooms-contact-${d.deviceId}`}
                  onDragStart={(e): void => onDragStartContact(e as DragEvent, d.deviceId)}
                >
                  <strong>{deviceLabel(d)}</strong>
                  <small>Auf einen Rollladen ziehen → Fensterkontakt</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

interface RoomCardProps {
  room: Room;
  windows: WindowDef[];
  dragOver: boolean;
  hasIssue: boolean;
  issueWindowIds: ReadonlySet<string>;
  shutters: DiscoveredDevice[];
  tempSensors: DiscoveredDevice[];
  contacts: DiscoveredDevice[];
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onRename: (name: string) => void;
  onChangeFloor: (floor: string) => void;
  onChangeSchedule: (
    key: 'noMoveBeforeHour' | 'noMoveAfterHour',
    value: number | null,
  ) => void;
  onToggleWindowBlock: (windowId: string, blocked: boolean) => void;
  onChangeOrientation: (windowId: string, deg: number) => void;
  onDelete: () => void;
  onAssignContact: (windowId: string, deviceId: string) => void;
  onClearContact: (windowId: string) => void;
}

function RoomCard(props: RoomCardProps): JSX.Element {
  const { room, windows, dragOver, hasIssue } = props;
  const [contactHoverWin, setContactHoverWin] = useState<string | null>(null);
  // Resolve the bound indoorTemp source to a readable label.
  const indoorBinding = room.signals.indoorTemp;
  const indoorDeviceId =
    indoorBinding !== undefined && indoorBinding.primary.kind === 'hmip'
      ? indoorBinding.primary.deviceId
      : undefined;
  const indoorMeta =
    indoorDeviceId !== undefined
      ? props.tempSensors.find((d) => d.deviceId === indoorDeviceId)
      : undefined;
  const indoorLabel =
    indoorDeviceId !== undefined
      ? indoorMeta !== undefined
        ? deviceLabel(indoorMeta)
        : `Sensor (…${indoorDeviceId.slice(-4)})`
      : null;
  return (
    <article
      class={`room-card ${dragOver ? 'room-card--dragover' : ''} ${
        hasIssue ? 'room-card--issue' : ''
      }`}
      data-testid={`room-card-${room.id}`}
      data-drop-room-id={room.id}
      data-dragover={dragOver ? 'true' : 'false'}
      onDragOver={(e: Event): void => props.onDragOver(e as DragEvent)}
      onDragLeave={props.onDragLeave}
      onDrop={(e: Event): void => props.onDrop(e as DragEvent)}
    >
      <header>
        <input
          class="room-card__name"
          type="text"
          data-testid={`room-card-name-${room.id}`}
          value={room.name}
          onInput={(e): void => props.onRename((e.currentTarget as HTMLInputElement).value)}
        />
        {room.floor !== undefined && (
          <span class="room-card__floor">{room.floor}</span>
        )}
        <label class="room-card__floor-edit">
          <span class="room-card__floor-label">Stockwerk</span>
          <input
            class="room-card__floor-input"
            type="text"
            list={`floor-presets-${room.id}`}
            data-testid={`room-card-floor-${room.id}`}
            placeholder="KG / EG / OG / DG …"
            aria-label={`Stockwerk für ${room.name}`}
            value={room.floor ?? ''}
            onInput={(e): void =>
              props.onChangeFloor((e.currentTarget as HTMLInputElement).value)
            }
          />
          <datalist id={`floor-presets-${room.id}`}>
            {FLOOR_PRESETS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <span class="room-card__priority">{PRIORITY_LABELS[room.priority] ?? room.priority}</span>
        <button
          type="button"
          class="room-card__delete"
          data-testid={`room-card-delete-${room.id}`}
          title="Raum löschen"
          aria-label={`Raum ${room.name} löschen`}
          onClick={(): void => props.onDelete()}
        >
          ✕
        </button>
      </header>
      <dl class="room-card__targets">
        {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
          <Fragment key={k}>
            <dt>{TARGET_LABELS[k]}</dt>
            <dd>{room.targets[k].toFixed(1)} °C</dd>
          </Fragment>
        ))}
      </dl>
      <div class="room-card__schedule" data-testid={`room-card-schedule-${room.id}`}>
        <span class="room-card__schedule-label">Fahrten nur</span>
        <label class="room-card__schedule-field">
          ab
          <input
            type="number"
            min={0}
            max={23}
            placeholder="0"
            data-testid={`room-card-nomove-before-${room.id}`}
            value={room.noMoveBeforeHour ?? ''}
            onInput={(e): void => {
              const raw = (e.currentTarget as HTMLInputElement).value.trim();
              if (raw === '') {
                props.onChangeSchedule('noMoveBeforeHour', null);
                return;
              }
              const v = Number.parseInt(raw, 10);
              if (Number.isFinite(v)) {
                props.onChangeSchedule('noMoveBeforeHour', Math.min(23, Math.max(0, v)));
              }
            }}
          />
          Uhr
        </label>
        <label class="room-card__schedule-field">
          bis
          <input
            type="number"
            min={1}
            max={24}
            placeholder="24"
            data-testid={`room-card-nomove-after-${room.id}`}
            value={room.noMoveAfterHour ?? ''}
            onInput={(e): void => {
              const raw = (e.currentTarget as HTMLInputElement).value.trim();
              if (raw === '') {
                props.onChangeSchedule('noMoveAfterHour', null);
                return;
              }
              const v = Number.parseInt(raw, 10);
              if (Number.isFinite(v)) {
                props.onChangeSchedule('noMoveAfterHour', Math.min(24, Math.max(1, v)));
              }
            }}
          />
          Uhr
        </label>
        <span class="room-card__schedule-hint">Sturm ignoriert die Ruhezeit</span>
      </div>
      <p class="room-card__indoor" data-testid={`room-card-indoor-${room.id}`}>
        Innentemperatur:{' '}
        {indoorLabel !== null ? (
          <strong>{indoorLabel}</strong>
        ) : (
          <span class="room-card__indoor--none">
            kein Sensor (Thermostat hierher ziehen)
          </span>
        )}
      </p>
      {dragOver && (
        <div class="room-card__drop-hint" data-testid={`room-card-drop-hint-${room.id}`}>
          Loslassen zum Zuweisen
        </div>
      )}
      {windows.length > 0 && (
        <ul class="room-card__windows">
          {windows.map((w) => {
            const meta = props.shutters.find((d) => d.deviceId === w.shutterDeviceId);
            const name =
              meta !== undefined ? deviceLabel(meta) : `Rollladen (…${w.id.slice(-4)})`;
            const contactMeta =
              w.contactDeviceId !== undefined
                ? props.contacts.find((d) => d.deviceId === w.contactDeviceId)
                : undefined;
            const contactLabel =
              w.contactDeviceId !== undefined
                ? contactMeta !== undefined
                  ? deviceLabel(contactMeta)
                  : `Kontakt (…${w.contactDeviceId.slice(-4)})`
                : null;
            const contactHover = contactHoverWin === w.id;
            return (
              <li
                key={w.id}
                data-testid={`room-card-window-${w.id}`}
                class={`${props.issueWindowIds.has(w.id) ? 'room-card__window--issue' : ''} ${
                  contactHover ? 'room-card__window--contact-hover' : ''
                }`}
                onDragOver={(e: Event): void => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContactHoverWin(w.id);
                }}
                onDragLeave={(): void => setContactHoverWin(null)}
                onDrop={(e: Event): void => {
                  const ev = e as DragEvent;
                  ev.preventDefault();
                  ev.stopPropagation();
                  setContactHoverWin(null);
                  const payload = parseDnd(ev.dataTransfer?.getData('text/plain') ?? '');
                  if (payload !== null && payload.kind === 'contact') {
                    props.onAssignContact(w.id, payload.deviceId);
                  }
                }}
              >
                <span class="room-card__window-name">{name}</span>
                <small>
                  {WINDOW_TYPE_LABELS[w.type] ?? w.type} · {compassLabel(w.orientationDeg)}{' '}
                  ({w.orientationDeg}°)
                </small>
                <label class="room-card__window-orientation">
                  <span>Himmelsrichtung</span>
                  <select
                    data-testid={`room-card-window-orientation-${w.id}`}
                    value={String(nearestCompassDeg(w.orientationDeg))}
                    onChange={(e): void =>
                      props.onChangeOrientation(
                        w.id,
                        Number((e.currentTarget as HTMLSelectElement).value),
                      )
                    }
                  >
                    {COMPASS_OPTIONS.map((o) => (
                      <option key={o.deg} value={String(o.deg)}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span
                  class="room-card__window-contact"
                  data-testid={`room-card-window-contact-${w.id}`}
                >
                  {contactLabel !== null ? (
                    <Fragment>
                      <span class="room-card__contact-name">📭 {contactLabel}</span>
                      <button
                        type="button"
                        class="room-card__contact-clear"
                        data-testid={`room-card-window-contact-clear-${w.id}`}
                        title="Fensterkontakt entfernen"
                        onClick={(): void => props.onClearContact(w.id)}
                      >
                        ✕
                      </button>
                    </Fragment>
                  ) : (
                    <span class="room-card__contact-none">
                      kein Fensterkontakt (Sensor hierher ziehen)
                    </span>
                  )}
                </span>
                <label class="room-card__window-block">
                  <input
                    type="checkbox"
                    data-testid={`room-card-window-block-${w.id}`}
                    checked={w.automationBlocked === true}
                    onChange={(e): void =>
                      props.onToggleWindowBlock(
                        w.id,
                        (e.currentTarget as HTMLInputElement).checked,
                      )
                    }
                  />
                  <span>Automatik aus</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
