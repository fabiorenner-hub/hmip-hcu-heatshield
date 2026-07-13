/**
 * Heat Shield — "Liquid Glass V2" Räume & Fenster (route `/rooms`).
 *
 * lg2-native rework of the v1 `RoomsTab` (`tabs/rooms.tsx`). Reuses the v1 DATA
 * layer (`useConfig` auto-save, `runDiscovery`/`useDiscovery`) and the reusable
 * `DiscoveryStatus` + `CompassPicker` subcomponents, but is a fully own lg2
 * component with `--lg2-*` styling — it does NOT embed the v1 tab.
 *
 * Full v1 functional scope (kein Funktionsverlust):
 *   - Toolbar: „Geräte suchen" (discovery), „Raum hinzufügen", auto-save chip.
 *   - Quick-add room presets grouped by floor.
 *   - Per room: name, floor, priority, the four target temperatures, indoor
 *     temperature sensor binding, quiet hours (granular weekday+time schedules),
 *     „Aktiv gekühlt" marker, delete.
 *   - Per window: orientation via the 8×45° compass picker, window-contact
 *     binding, „Automatik aus", per-window block schedules.
 *   - Device assignment: discovered shutters / temperature sensors / window
 *     contacts, each with an inline dropdown.
 *
 * Legacy `noMoveBeforeHour`/`noMoveAfterHour` bounds are migrated into an
 * equivalent daily quiet schedule on load. Persistence is unchanged: a debounced
 * `PUT /api/config` (useConfig) with inline Zod error highlighting.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  Config,
  Room,
  RoomTargets,
  Window as WindowDef,
} from '../../../../../shared/types.js';
import { runDiscovery, useDiscovery, type DiscoveredDevice } from '../../hooks/useDiscovery.js';
import { DiscoveryStatus } from '../discoveryStatus.js';
import { CompassPicker } from '../compassPicker.js';
import { useConfig } from '../../hooks/useConfig.js';
import {
  deviceLabel,
  compassLabel,
  TARGET_LABELS,
  PRIORITY_LABELS,
  WINDOW_TYPE_LABELS,
} from '../../format.js';
import { t } from '../../i18n.js';
import { Icon } from '../icons.js';

interface RoutableProps { path?: string }

/** One weekday+clock-time block rule (shared by room quiet + window block). */
type Schedule = WindowDef['blockSchedules'][number];

const PRIORITIES: Room['priority'][] = ['very_high', 'high', 'medium', 'low'];

interface RoomPreset {
  nameDe: string;
  nameEn: string;
  floor: string;
  priority: Room['priority'];
}

const FLOOR_PRESETS: readonly string[] = ['KG', 'EG', 'OG', 'DG'];

const ROOM_PRESETS: readonly RoomPreset[] = [
  { nameDe: 'Schlafzimmer', nameEn: 'Bedroom', floor: 'OG', priority: 'very_high' },
  { nameDe: 'Arbeitszimmer', nameEn: 'Study', floor: 'OG', priority: 'high' },
  { nameDe: 'Gästezimmer', nameEn: 'Guest room', floor: 'OG', priority: 'medium' },
  { nameDe: 'Badezimmer', nameEn: 'Bathroom', floor: 'OG', priority: 'medium' },
  { nameDe: 'Küche', nameEn: 'Kitchen', floor: 'EG', priority: 'low' },
  { nameDe: 'Garderobe', nameEn: 'Cloakroom', floor: 'EG', priority: 'low' },
  { nameDe: 'Flur', nameEn: 'Hallway', floor: 'EG', priority: 'low' },
  { nameDe: 'Wohnzimmer', nameEn: 'Living room', floor: 'EG', priority: 'high' },
  { nameDe: 'Keller', nameEn: 'Basement', floor: 'KG', priority: 'low' },
];

const DEFAULT_TARGETS: RoomTargets = {
  target_c: 23.0,
  warning_c: 25.0,
  strong_shade_c: 26.0,
  critical_c: 27.0,
};

/** Sentinel for the assignment dropdowns meaning "detach from any room". */
const VIRTUAL_UNASSIGNED_ROOM_ID = '__unassigned__';

/** Weekday chips for the schedule editor (JS getDay order, Mon-first UI). */
const BLOCK_WEEKDAYS: ReadonlyArray<{ idx: number; de: string; en: string }> = [
  { idx: 1, de: 'Mo', en: 'Mon' },
  { idx: 2, de: 'Di', en: 'Tue' },
  { idx: 3, de: 'Mi', en: 'Wed' },
  { idx: 4, de: 'Do', en: 'Thu' },
  { idx: 5, de: 'Fr', en: 'Fri' },
  { idx: 6, de: 'Sa', en: 'Sat' },
  { idx: 0, de: 'So', en: 'Sun' },
];

const WEEKDAY_PRESETS: ReadonlyArray<{ de: string; en: string; days: number[] }> = [
  { de: 'Täglich', en: 'Daily', days: [] },
  { de: 'Werktags', en: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { de: 'Wochenende', en: 'Weekend', days: [0, 6] },
];

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

/**
 * Migrate legacy `noMoveBeforeHour`/`noMoveAfterHour` bounds into an equivalent
 * daily quiet schedule. Returns the room unchanged when there is nothing to
 * migrate (mirrors the v1 tab so no user setting is silently lost).
 */
function migrateLegacyQuiet(room: Room): Room {
  const before = room.noMoveBeforeHour;
  const after = room.noMoveAfterHour;
  const hasLegacy = before !== undefined || after !== undefined;
  const hasSchedules = (room.quietSchedules ?? []).length > 0;
  if (!hasLegacy || hasSchedules) return room;
  const pad = (hour: number): string => `${String(hour % 24).padStart(2, '0')}:00`;
  const start = pad(after ?? 24);
  const end = pad(before ?? 0);
  const migrated: Schedule = { days: [], start, end };
  const { noMoveBeforeHour: _b, noMoveAfterHour: _a, ...rest } = room;
  return { ...rest, quietSchedules: [migrated] };
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

/* -------------------------------------------------------------------------- */
/* Shared lg2-native schedule editor (room quiet hours + window block times)  */
/* -------------------------------------------------------------------------- */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** Is the given HH:MM within a (possibly midnight-wrapping) window right now? */
function scheduleActiveNow(s: Schedule, now: Date): boolean {
  if (!HHMM.test(s.start) || !HHMM.test(s.end) || s.start === s.end) return false;
  const day = now.getDay();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const a = toMin(s.start);
  const b = toMin(s.end);
  const inTime = a < b ? cur >= a && cur < b : cur >= a || cur < b;
  if (!inTime) return false;
  if (s.days.length === 0) return true;
  const ownerDay = a < b || cur >= a ? day : (day + 6) % 7;
  return s.days.includes(ownerDay);
}

function Lg2ScheduleEditor(props: {
  idPrefix: string;
  schedules: readonly Schedule[];
  addLabel: string;
  onChange: (schedules: Schedule[]) => void;
}): JSX.Element {
  const list = props.schedules ?? [];
  const now = new Date();
  const update = (i: number, patch: Partial<Schedule>): void => {
    props.onChange(list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const toggleDay = (i: number, day: number): void => {
    const cur = list[i];
    if (cur === undefined) return;
    const has = cur.days.includes(day);
    const days = has
      ? cur.days.filter((d) => d !== day)
      : [...cur.days, day].sort((a, b) => a - b);
    update(i, { days });
  };
  const setPreset = (i: number, days: number[]): void => update(i, { days: [...days] });
  return (
    <div class="lg2-rooms__sched" data-testid={`lg2-sched-${props.idPrefix}`}>
      {list.length === 0 && (
        <p class="lg2-rooms__sched-empty">{t('Keine Ruhezeiten — Automatik jederzeit.', 'No quiet hours — automation any time.')}</p>
      )}
      {list.map((s, i) => {
        const active = scheduleActiveNow(s, now);
        return (
          <div class="lg2-rooms__sched-row" key={i} data-testid={`lg2-sched-${props.idPrefix}-row-${i}`}>
            <div class="lg2-rooms__sched-days">
              {BLOCK_WEEKDAYS.map((d) => (
                <button
                  key={d.idx}
                  type="button"
                  class={`lg2-rooms__day${s.days.includes(d.idx) ? ' lg2-rooms__day--on' : ''}`}
                  title={t(d.de, d.en)}
                  aria-pressed={s.days.includes(d.idx)}
                  onClick={(): void => toggleDay(i, d.idx)}
                >
                  {t(d.de, d.en)}
                </button>
              ))}
            </div>
            <div class="lg2-rooms__sched-presets">
              {WEEKDAY_PRESETS.map((p) => (
                <button
                  key={p.de}
                  type="button"
                  class="lg2-rooms__sched-preset"
                  onClick={(): void => setPreset(i, p.days)}
                >
                  {t(p.de, p.en)}
                </button>
              ))}
            </div>
            <div class="lg2-rooms__sched-times">
              <label class="lg2-rooms__field lg2-rooms__field--inline">
                <span>{t('von', 'from')}</span>
                <input
                  type="time"
                  value={s.start}
                  data-testid={`lg2-sched-${props.idPrefix}-start-${i}`}
                  onInput={(e): void => update(i, { start: (e.currentTarget as HTMLInputElement).value })}
                />
              </label>
              <span aria-hidden="true" class="lg2-rooms__sched-dash">–</span>
              <label class="lg2-rooms__field lg2-rooms__field--inline">
                <span>{t('bis', 'to')}</span>
                <input
                  type="time"
                  value={s.end}
                  data-testid={`lg2-sched-${props.idPrefix}-end-${i}`}
                  onInput={(e): void => update(i, { end: (e.currentTarget as HTMLInputElement).value })}
                />
              </label>
              <button
                type="button"
                class="lg2-rooms__sched-del"
                title={t('Zeitfenster entfernen', 'Remove time window')}
                aria-label={t('Zeitfenster entfernen', 'Remove time window')}
                onClick={(): void => props.onChange(list.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            </div>
            <div class="lg2-rooms__sched-meta">
              {s.days.length === 0 && <span class="lg2-rooms__tag">{t('täglich', 'daily')}</span>}
              {active && <span class="lg2-rooms__tag lg2-rooms__tag--active">{t('jetzt aktiv', 'active now')}</span>}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        class="lg2-rooms__sched-add"
        data-testid={`lg2-sched-${props.idPrefix}-add`}
        onClick={(): void => props.onChange([...list, { days: [], start: '22:00', end: '06:00' }])}
      >
        + {props.addLabel}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Room card                                                                  */
/* -------------------------------------------------------------------------- */

interface RoomCardProps {
  room: Room;
  windows: WindowDef[];
  hasIssue: boolean;
  issueWindowIds: ReadonlySet<string>;
  shutters: DiscoveredDevice[];
  tempSensors: DiscoveredDevice[];
  contacts: DiscoveredDevice[];
  contactUsage: ReadonlyMap<string, string>;
  onRename: (name: string) => void;
  onChangeFloor: (floor: string) => void;
  onChangePriority: (p: Room['priority']) => void;
  onChangeTarget: (key: keyof RoomTargets, value: number) => void;
  onAssignTempSensor: (deviceId: string) => void;
  onClearTempSensor: () => void;
  onChangeQuietSchedules: (schedules: Schedule[]) => void;
  onToggleWindowBlock: (windowId: string, blocked: boolean) => void;
  onToggleActiveCooling: (on: boolean) => void;
  onChangeBlockSchedules: (windowId: string, schedules: Schedule[]) => void;
  onChangeOrientation: (windowId: string, deg: number) => void;
  onDelete: () => void;
  onAssignContact: (windowId: string, deviceId: string) => void;
  onClearContact: (windowId: string) => void;
}

function RoomCard(props: RoomCardProps): JSX.Element {
  const { room, windows, hasIssue } = props;
  const indoorBinding = room.signals.indoorTemp;
  const indoorDeviceId =
    indoorBinding !== undefined && indoorBinding.primary.kind === 'hmip'
      ? indoorBinding.primary.deviceId
      : undefined;
  return (
    <article
      class={`lg2-card lg2-rooms__room${hasIssue ? ' lg2-rooms__room--issue' : ''}`}
      data-testid={`lg2-room-card-${room.id}`}
    >
      <header class="lg2-rooms__room-head">
        <input
          class="lg2-rooms__room-name"
          type="text"
          data-testid={`lg2-room-name-${room.id}`}
          aria-label={t('Raumname', 'Room name')}
          value={room.name}
          onInput={(e): void => props.onRename((e.currentTarget as HTMLInputElement).value)}
        />
        <label class="lg2-rooms__field">
          <span>{t('Stockwerk', 'Floor')}</span>
          <input
            type="text"
            list={`lg2-floor-presets-${room.id}`}
            data-testid={`lg2-room-floor-${room.id}`}
            placeholder="KG / EG / OG / DG …"
            value={room.floor ?? ''}
            onInput={(e): void => props.onChangeFloor((e.currentTarget as HTMLInputElement).value)}
          />
          <datalist id={`lg2-floor-presets-${room.id}`}>
            {FLOOR_PRESETS.map((f) => (<option key={f} value={f} />))}
          </datalist>
        </label>
        <label class="lg2-rooms__field">
          <span>{t('Priorität', 'Priority')}</span>
          <select
            data-testid={`lg2-room-priority-${room.id}`}
            value={room.priority}
            onChange={(e): void => props.onChangePriority((e.currentTarget as HTMLSelectElement).value as Room['priority'])}
          >
            {PRIORITIES.map((p) => (<option key={p} value={p}>{PRIORITY_LABELS[p]}</option>))}
          </select>
        </label>
        <button
          type="button"
          class="lg2-rooms__room-del"
          data-testid={`lg2-room-delete-${room.id}`}
          title={t('Raum löschen', 'Delete room')}
          aria-label={t(`Raum ${room.name} löschen`, `Delete room ${room.name}`)}
          onClick={(): void => props.onDelete()}
        >✕</button>
      </header>

      <div class="lg2-rooms__section">
        <span class="lg2-rooms__section-label">{t('Zieltemperaturen', 'Target temperatures')}</span>
        <div class="lg2-rooms__targets">
          {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
            <label key={k} class="lg2-rooms__target">
              <span>{TARGET_LABELS[k]}</span>
              <span class="lg2-rooms__target-input">
                <input
                  type="number"
                  step={0.1}
                  data-testid={`lg2-room-target-${k}-${room.id}`}
                  value={room.targets[k]}
                  onInput={(e): void => {
                    const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(v)) props.onChangeTarget(k, v);
                  }}
                />
                <em>°C</em>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div class="lg2-rooms__section">
        <span class="lg2-rooms__section-label">{t('Innentemperatur-Sensor', 'Indoor temperature sensor')}</span>
        <select
          class="lg2-rooms__wide-select"
          data-testid={`lg2-room-indoor-select-${room.id}`}
          value={indoorDeviceId ?? ''}
          onChange={(e): void => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            if (v === '') props.onClearTempSensor();
            else props.onAssignTempSensor(v);
          }}
        >
          <option value="">{t('— kein Sensor —', '— no sensor —')}</option>
          {indoorDeviceId !== undefined && !props.tempSensors.some((d) => d.deviceId === indoorDeviceId) && (
            <option value={indoorDeviceId}>{t(`Sensor (…${indoorDeviceId.slice(-4)})`, `Sensor (…${indoorDeviceId.slice(-4)})`)}</option>
          )}
          {props.tempSensors.map((d) => (<option key={d.deviceId} value={d.deviceId}>{deviceLabel(d)}</option>))}
        </select>
      </div>

      <div class="lg2-rooms__section">
        <span class="lg2-rooms__section-label">{t('Ruhezeiten', 'Quiet hours')}</span>
        <Lg2ScheduleEditor
          idPrefix={`room-${room.id}`}
          schedules={room.quietSchedules ?? []}
          addLabel={t('Ruhezeit', 'Quiet window')}
          onChange={props.onChangeQuietSchedules}
        />
        <span class="lg2-rooms__hint">{t('Keine automatischen Fahrten in diesen Zeiten. Sturm ignoriert die Ruhezeit.', 'No automatic moves during these times. Storm ignores the quiet hours.')}</span>
      </div>

      <label class="lg2-rooms__cooling" data-testid={`lg2-room-cooling-${room.id}`}>
        <button
          type="button"
          role="switch"
          aria-checked={room.activeCooling === true}
          class={`lg2-toggle${room.activeCooling === true ? ' lg2-toggle--on' : ''}`}
          onClick={(): void => props.onToggleActiveCooling(!(room.activeCooling === true))}
        />
        <span>
          {t('Aktiv gekühlt (mobile Klimaanlage)', 'Actively cooled (mobile AC)')}
          <small class="lg2-rooms__hint">{t('vom Lernen ausgenommen', 'excluded from learning')}</small>
        </span>
      </label>

      <div class="lg2-rooms__section">
        <span class="lg2-rooms__section-label">
          {t('Rollläden / Fenster', 'Shutters / windows')} ({windows.length})
        </span>
        {windows.length === 0 ? (
          <p class="lg2-rooms__hint">{t('Noch kein Rollladen zugewiesen — unten unter „Geräte" zuweisen.', 'No shutter assigned yet — assign one below under "Devices".')}</p>
        ) : (
          <ul class="lg2-rooms__windows">
            {windows.map((w) => {
              const meta = props.shutters.find((d) => d.deviceId === w.shutterDeviceId);
              const name = meta !== undefined ? deviceLabel(meta) : t(`Rollladen (…${w.id.slice(-4)})`, `Shutter (…${w.id.slice(-4)})`);
              const contactMeta = w.contactDeviceId !== undefined ? props.contacts.find((d) => d.deviceId === w.contactDeviceId) : undefined;
              const contactLabel = w.contactDeviceId !== undefined
                ? (contactMeta !== undefined ? deviceLabel(contactMeta) : t(`Kontakt (…${w.contactDeviceId.slice(-4)})`, `Contact (…${w.contactDeviceId.slice(-4)})`))
                : null;
              return (
                <li key={w.id} data-testid={`lg2-room-window-${w.id}`}
                  class={`lg2-rooms__window${props.issueWindowIds.has(w.id) ? ' lg2-rooms__window--issue' : ''}`}>
                  <div class="lg2-rooms__window-head">
                    <span class="lg2-rooms__window-name">{name}</span>
                    <small>{WINDOW_TYPE_LABELS[w.type] ?? w.type} · {compassLabel(w.orientationDeg)} ({w.orientationDeg}°)</small>
                  </div>
                  <div class="lg2-rooms__window-controls">
                    <div class="lg2-rooms__window-compass" data-testid={`lg2-room-window-orientation-${w.id}`}>
                      <span class="lg2-rooms__field-label">{t('Himmelsrichtung', 'Orientation')}</span>
                      <CompassPicker
                        value={w.orientationDeg}
                        size={124}
                        onChange={(deg): void => props.onChangeOrientation(w.id, deg)}
                      />
                    </div>
                    <label class="lg2-rooms__field" data-testid={`lg2-room-window-contact-${w.id}`}>
                      <span>{t('Fensterkontakt', 'Window contact')}</span>
                      <select
                        data-testid={`lg2-room-window-contact-select-${w.id}`}
                        value={w.contactDeviceId ?? ''}
                        onChange={(e): void => {
                          const v = (e.currentTarget as HTMLSelectElement).value;
                          if (v === '') props.onClearContact(w.id);
                          else props.onAssignContact(w.id, v);
                        }}
                      >
                        <option value="">{t('— keiner —', '— none —')}</option>
                        {w.contactDeviceId !== undefined && !props.contacts.some((c) => c.deviceId === w.contactDeviceId) && (
                          <option value={w.contactDeviceId}>{contactLabel}</option>
                        )}
                        {props.contacts.map((c) => {
                          const usedBy = props.contactUsage.get(c.deviceId);
                          const usedElsewhere = usedBy !== undefined && c.deviceId !== w.contactDeviceId;
                          return (
                            <option key={c.deviceId} value={c.deviceId}>
                              {deviceLabel(c)}{usedElsewhere ? t(` (belegt: ${usedBy})`, ` (in use: ${usedBy})`) : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>
                  <label class="lg2-rooms__window-block">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={w.automationBlocked === true}
                      class={`lg2-toggle${w.automationBlocked === true ? ' lg2-toggle--on' : ''}`}
                      data-testid={`lg2-room-window-block-${w.id}`}
                      onClick={(): void => props.onToggleWindowBlock(w.id, !(w.automationBlocked === true))}
                    />
                    <span>{t('Automatik aus (dieses Fenster)', 'Automation off (this window)')}</span>
                  </label>
                  <div class="lg2-rooms__section">
                    <span class="lg2-rooms__section-label">{t('Blockzeiten (nur dieses Fenster)', 'Block times (this window only)')}</span>
                    <Lg2ScheduleEditor
                      idPrefix={`win-${w.id}`}
                      schedules={w.blockSchedules ?? []}
                      addLabel={t('Zeitfenster', 'Time window')}
                      onChange={(s): void => props.onChangeBlockSchedules(w.id, s)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Rooms(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();

  const [draftRooms, setDraftRooms] = useState<Room[]>([]);
  const [draftWindows, setDraftWindows] = useState<WindowDef[]>([]);
  const [windowAssignments, setWindowAssignments] = useState<Record<string, string>>({});
  const [addForm, setAddForm] = useState<AddRoomFormState>(INITIAL_ADD_ROOM_FORM);

  const hydratedRef = useRef<boolean>(false);
  const touchedRef = useRef<boolean>(false);

  useEffect(() => {
    const c = cfg.config.value;
    if (c === null || hydratedRef.current) return;
    hydratedRef.current = true;
    setDraftRooms(c.rooms.map(migrateLegacyQuiet));
    setDraftWindows(c.windows);
    const initial: Record<string, string> = {};
    for (const w of c.windows) initial[w.id] = w.roomId;
    setWindowAssignments(initial);
  }, [cfg.config.value]);

  useEffect(() => {
    if (discovery.inventory.value.length === 0 && !discovery.discovering.value) {
      void runDiscovery();
    }
  }, []);

  const discoveredShutters = useMemo<DiscoveredDevice[]>(
    () => discovery.shutterSources.value,
    [discovery.shutterSources.value],
  );

  const issuePathsByWindow = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const i of cfg.saveError.value?.error.issues ?? []) {
      if (i.path[0] === 'windows' && typeof i.path[1] === 'number') {
        const w = draftWindows[i.path[1]];
        if (w) out.add(w.id);
      }
    }
    return out;
  }, [cfg.saveError.value, draftWindows]);

  const issuePathsByRoom = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const i of cfg.saveError.value?.error.issues ?? []) {
      if (i.path[0] === 'rooms' && typeof i.path[1] === 'number') {
        const r = draftRooms[i.path[1]];
        if (r) out.add(r.id);
      }
    }
    return out;
  }, [cfg.saveError.value, draftRooms]);

  const assignContact = (windowId: string, deviceId: string): void => {
    touchedRef.current = true;
    setDraftWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, contactDeviceId: deviceId } : w)));
  };
  const clearContact = (windowId: string): void => {
    touchedRef.current = true;
    setDraftWindows((prev) => prev.map((w) => {
      if (w.id !== windowId) return w;
      const { contactDeviceId: _omit, ...rest } = w;
      return rest as WindowDef;
    }));
  };
  const assignTempSensor = (roomId: string, deviceId: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.map((r) => {
      if (r.id !== roomId) return r;
      const existing = r.signals.indoorTemp;
      const primary = { kind: 'hmip' as const, deviceId, feature: 'actualTemperature' };
      const indoorTemp = existing !== undefined ? { ...existing, primary } : { staleAfterSec: 600, primary };
      return { ...r, signals: { ...r.signals, indoorTemp } };
    }));
  };
  const clearTempSensor = (roomId: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.map((r) => {
      if (r.id !== roomId) return r;
      const { indoorTemp: _omit, ...restSignals } = r.signals;
      return { ...r, signals: restSignals };
    }));
  };
  const assignShutterToRoom = (deviceId: string, roomId: string): void => {
    touchedRef.current = true;
    setWindowAssignments((prev) => ({ ...prev, [deviceId]: roomId }));
    if (roomId === VIRTUAL_UNASSIGNED_ROOM_ID) return;
    setDraftWindows((prev) => {
      const existing = prev.find((w) => w.id === deviceId || w.shutterDeviceId === deviceId);
      if (existing !== undefined) {
        return prev.map((w) => (w.id === deviceId || w.shutterDeviceId === deviceId ? { ...w, roomId } : w));
      }
      const meta = discoveredShutters.find((d) => d.deviceId === deviceId);
      const friendly = (meta?.friendlyName ?? '').toLowerCase();
      const isRoof = /dach|velux|roto/.test(friendly);
      const newWindow: WindowDef = {
        id: deviceId, roomId, shutterDeviceId: deviceId, automationBlocked: false,
        orientationDeg: 180, type: isRoof ? 'roof_window' : 'facade', isDoor: false,
        canMoveWhenOpen: true, maxPositionWhenOpenPct: 60, maxHeatProtectionLevel01: isRoof ? 1 : 0.95,
        sunPrelookMinutes: 60, lockoutProtection: true, blockSchedules: [],
      };
      return [...prev, newWindow];
    });
  };

  const handleAddRoomSubmit = (e: Event): void => {
    e.preventDefault();
    touchedRef.current = true;
    const existing = new Set(draftRooms.map((r) => r.id));
    const id = addForm.id.trim().length > 0 ? addForm.id.trim() : newRoomId(addForm.name, existing);
    const name = addForm.name.trim().length > 0 ? addForm.name.trim() : id;
    const floor = addForm.floor.trim();
    const newRoom: Room = {
      id, name, priority: addForm.priority, targets: addForm.targets, signals: {},
      occupancyMode: 'always_priority', activeCooling: false, quietSchedules: [],
      ...(floor.length > 0 ? { floor } : {}),
    };
    setDraftRooms((prev) => [...prev, newRoom]);
    setAddForm(INITIAL_ADD_ROOM_FORM);
  };

  const handleAddPreset = (preset: RoomPreset): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => {
      const existing = new Set(prev.map((r) => r.id));
      const name = t(preset.nameDe, preset.nameEn);
      const id = newRoomId(name, existing);
      const newRoom: Room = {
        id, name, floor: preset.floor, priority: preset.priority, targets: { ...DEFAULT_TARGETS },
        signals: {}, occupancyMode: 'always_priority', activeCooling: false, quietSchedules: [],
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
    for (const r of draftRooms) out.set(r.id, r.name);
    return out;
  }, [draftRooms]);

  const contactUsage = useMemo<Map<string, string>>(() => {
    const out = new Map<string, string>();
    for (const w of draftWindows) {
      if (w.contactDeviceId !== undefined) {
        const assignedRoom = windowAssignments[w.id] ?? w.roomId;
        out.set(w.contactDeviceId, roomNameById.get(assignedRoom) ?? assignedRoom);
      }
    }
    return out;
  }, [draftWindows, windowAssignments, roomNameById]);

  const patchRoom = (roomId: string, fn: (r: Room) => Room): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.map((r) => (r.id === roomId ? fn(r) : r)));
  };
  const handleRenameRoom = (roomId: string, name: string): void => patchRoom(roomId, (r) => ({ ...r, name }));
  const handleChangePriority = (roomId: string, p: Room['priority']): void => patchRoom(roomId, (r) => ({ ...r, priority: p }));
  const handleChangeTarget = (roomId: string, key: keyof RoomTargets, value: number): void =>
    patchRoom(roomId, (r) => ({ ...r, targets: { ...r.targets, [key]: value } }));
  const handleChangeQuietSchedules = (roomId: string, schedules: Schedule[]): void =>
    patchRoom(roomId, (r) => {
      const { noMoveBeforeHour: _b, noMoveAfterHour: _a, ...rest } = r;
      return { ...rest, quietSchedules: schedules };
    });
  const handleToggleActiveCooling = (roomId: string, on: boolean): void => patchRoom(roomId, (r) => ({ ...r, activeCooling: on }));
  const handleChangeFloor = (roomId: string, floor: string): void =>
    patchRoom(roomId, (r) => {
      if (floor.trim().length === 0) {
        const { floor: _omit, ...rest } = r;
        return rest as Room;
      }
      return { ...r, floor };
    });

  const handleToggleWindowBlock = (windowId: string, blocked: boolean): void => {
    touchedRef.current = true;
    setDraftWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, automationBlocked: blocked } : w)));
  };
  const handleChangeBlockSchedules = (windowId: string, schedules: Schedule[]): void => {
    touchedRef.current = true;
    setDraftWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, blockSchedules: schedules } : w)));
  };
  const handleChangeOrientation = (windowId: string, deg: number): void => {
    touchedRef.current = true;
    setDraftWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, orientationDeg: deg } : w)));
  };
  const handleDeleteRoom = (roomId: string): void => {
    touchedRef.current = true;
    setDraftRooms((prev) => prev.filter((r) => r.id !== roomId));
    setDraftWindows((prev) => prev.filter((w) => (windowAssignments[w.id] ?? w.roomId) !== roomId));
    setWindowAssignments((prev) => {
      const next = { ...prev };
      for (const [devId, assigned] of Object.entries(prev)) if (assigned === roomId) delete next[devId];
      return next;
    });
  };

  useEffect(() => {
    if (!touchedRef.current) return;
    const current = cfg.config.value;
    if (current === null) return;
    const persistableWindows = draftWindows.filter((w) => windowAssignments[w.id] !== VIRTUAL_UNASSIGNED_ROOM_ID);
    const next: Config = { ...current, rooms: draftRooms, windows: persistableWindows };
    if (JSON.stringify(next) !== JSON.stringify(current)) cfg.scheduleSave(next);
  }, [draftRooms, draftWindows, windowAssignments]);

  return (
    <main class="lg2-main lg2-rooms" data-testid="liquid-glass2-rooms">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Räume und Fenster', 'Rooms and windows')}</h1>
          <p class="lg2-header__sub">{t('Geräte, Zieltemperaturen, Ruhezeiten und Ausrichtung', 'Devices, target temperatures, quiet hours and orientation')}</p>
        </div>
        <div class="lg2-rooms__actions">
          <button type="button" class="lg2-btn lg2-btn--ghost" data-testid="lg2-rooms-discover"
            disabled={discovery.discovering.value}
            onClick={(): void => { void runDiscovery(); }}>
            <Icon name="forecast" size={16} />
            {discovery.discovering.value ? t('Suche läuft…', 'Searching…') : t('Geräte suchen', 'Discover devices')}
          </button>
          <button type="button" class="lg2-btn" data-testid="lg2-rooms-add"
            onClick={(): void => setAddForm({ ...INITIAL_ADD_ROOM_FORM, open: true })}>
            <Icon name="haus" size={16} />
            {t('Raum hinzufügen', 'Add room')}
          </button>
          <span class="lg2-rooms__autosave" data-testid="lg2-rooms-autosave">
            {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
          </span>
        </div>
      </header>

      <section class="lg2-card lg2-rooms__discovery">
        <DiscoveryStatus discovery={discovery} />
        {discovery.error.value !== null && (
          <p class="lg2-rooms__error" data-testid="lg2-rooms-discover-error">{discovery.error.value}</p>
        )}
        <div class="lg2-rooms__presets" data-testid="lg2-rooms-presets">
          <span class="lg2-rooms__presets-label">{t('Schnell anlegen:', 'Quick add:')}</span>
          {ROOM_PRESETS.map((p) => (
            <button key={p.nameDe} type="button" class="lg2-rooms__preset-btn" data-testid={`lg2-rooms-preset-${p.nameDe}`}
              title={t(`${p.floor} · Priorität ${p.priority}`, `${p.floor} · priority ${p.priority}`)}
              onClick={(): void => handleAddPreset(p)}>
              + {t(p.nameDe, p.nameEn)} <small>({p.floor})</small>
            </button>
          ))}
        </div>
      </section>

      {cfg.loadError.value !== null && (
        <div class="lg2-card lg2-rooms__error-card" data-testid="lg2-rooms-load-error">{cfg.loadError.value}</div>
      )}
      {cfg.saveError.value !== null && (
        <div class="lg2-card lg2-rooms__error-card" data-testid="lg2-rooms-save-error">
          <strong>{cfg.saveError.value.error.message}</strong>
          {cfg.saveError.value.error.issues && (
            <ul>{cfg.saveError.value.error.issues.map((iss, idx) => (<li key={idx}>{iss.path.join('.')}: {iss.message}</li>))}</ul>
          )}
        </div>
      )}
      {cfg.saveOk.value && (
        <p class="lg2-rooms__ok" data-testid="lg2-rooms-save-ok">{t('Konfiguration gespeichert.', 'Configuration saved.')}</p>
      )}

      {addForm.open && (
        <form class="lg2-card lg2-rooms__add-form" data-testid="lg2-rooms-add-form" onSubmit={handleAddRoomSubmit}>
          <h2 class="lg2-card__title">{t('Neuer Raum', 'New room')}</h2>
          <div class="lg2-rooms__add-grid">
            <label class="lg2-rooms__field">
              <span>{t('Id', 'ID')}</span>
              <input data-testid="lg2-rooms-add-id" value={addForm.id}
                onInput={(e): void => setAddForm({ ...addForm, id: (e.currentTarget as HTMLInputElement).value })} />
            </label>
            <label class="lg2-rooms__field">
              <span>{t('Name', 'Name')}</span>
              <input data-testid="lg2-rooms-add-name" value={addForm.name}
                onInput={(e): void => setAddForm({ ...addForm, name: (e.currentTarget as HTMLInputElement).value })} />
            </label>
            <label class="lg2-rooms__field">
              <span>{t('Stockwerk', 'Floor')}</span>
              <input data-testid="lg2-rooms-add-floor" placeholder={t('z.B. OG / EG / KG', 'e.g. OG / EG / KG')} value={addForm.floor}
                onInput={(e): void => setAddForm({ ...addForm, floor: (e.currentTarget as HTMLInputElement).value })} />
            </label>
            <label class="lg2-rooms__field">
              <span>{t('Priorität', 'Priority')}</span>
              <select data-testid="lg2-rooms-add-priority" value={addForm.priority}
                onChange={(e): void => setAddForm({ ...addForm, priority: (e.currentTarget as HTMLSelectElement).value as Room['priority'] })}>
                {PRIORITIES.map((p) => (<option key={p} value={p}>{PRIORITY_LABELS[p]}</option>))}
              </select>
            </label>
            {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
              <label key={k} class="lg2-rooms__field">
                <span>{TARGET_LABELS[k]}</span>
                <input type="number" step={0.1} data-testid={`lg2-rooms-add-${k}`} value={addForm.targets[k]}
                  onInput={(e): void => {
                    const next = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                    setAddForm({ ...addForm, targets: { ...addForm.targets, [k]: Number.isFinite(next) ? next : addForm.targets[k] } });
                  }} />
              </label>
            ))}
          </div>
          <div class="lg2-rooms__add-actions">
            <button type="submit" class="lg2-btn" data-testid="lg2-rooms-add-submit">{t('Hinzufügen', 'Add')}</button>
            <button type="button" class="lg2-btn lg2-btn--ghost" data-testid="lg2-rooms-add-cancel" onClick={(): void => setAddForm(INITIAL_ADD_ROOM_FORM)}>{t('Abbrechen', 'Cancel')}</button>
          </div>
        </form>
      )}

      <div class="lg2-rooms__list">
        {draftRooms.length === 0 && (
          <p class="lg2-card lg2-rooms__hint" data-testid="lg2-rooms-empty">{t('Noch keine Räume. „Raum hinzufügen" oder ein Preset oben nutzen.', 'No rooms yet. Use "Add room" or a preset above.')}</p>
        )}
        {draftRooms.map((room) => (
          <RoomCard
            key={room.id}
            room={room}
            windows={windowsByRoom.get(room.id) ?? []}
            hasIssue={issuePathsByRoom.has(room.id)}
            issueWindowIds={issuePathsByWindow}
            shutters={discoveredShutters}
            tempSensors={discovery.temperatureSources.value}
            contacts={discovery.contactSources.value}
            contactUsage={contactUsage}
            onRename={(name): void => handleRenameRoom(room.id, name)}
            onChangeFloor={(floor): void => handleChangeFloor(room.id, floor)}
            onChangePriority={(p): void => handleChangePriority(room.id, p)}
            onChangeTarget={(k, v): void => handleChangeTarget(room.id, k, v)}
            onAssignTempSensor={(id): void => assignTempSensor(room.id, id)}
            onClearTempSensor={(): void => clearTempSensor(room.id)}
            onChangeQuietSchedules={(s): void => handleChangeQuietSchedules(room.id, s)}
            onToggleWindowBlock={handleToggleWindowBlock}
            onToggleActiveCooling={(on): void => handleToggleActiveCooling(room.id, on)}
            onChangeBlockSchedules={handleChangeBlockSchedules}
            onChangeOrientation={handleChangeOrientation}
            onDelete={(): void => handleDeleteRoom(room.id)}
            onAssignContact={assignContact}
            onClearContact={clearContact}
          />
        ))}
      </div>

      <section class="lg2-card lg2-rooms__devices">
        <h2 class="lg2-card__title">{t('Geräte', 'Devices')}</h2>

        <h3 class="lg2-rooms__devices-head">{t('Gefundene Rollläden', 'Discovered shutters')} ({discoveredShutters.length})</h3>
        {discoveredShutters.length === 0 ? (
          <p class="lg2-rooms__hint" data-testid="lg2-rooms-discover-empty">
            {t('„Geräte suchen" ausführen, um HMIP-Rollläden und Beschattungsmodule (z. B. HmIP-HDM1) zu finden.', 'Run "Discover devices" to find HMIP shutters and shading modules (e.g. HmIP-HDM1).')}
          </p>
        ) : (
          <ul class="lg2-rooms__device-list">
            {discoveredShutters.map((d) => {
              const assignedRoomId = windowAssignments[d.deviceId];
              const selectValue = assignedRoomId === undefined || assignedRoomId === VIRTUAL_UNASSIGNED_ROOM_ID ? '' : assignedRoomId;
              return (
                <li key={d.deviceId} class="lg2-rooms__device" data-testid={`lg2-rooms-device-${d.deviceId}`}>
                  <strong>{deviceLabel(d)}</strong>
                  <label class="lg2-rooms__field lg2-rooms__field--inline">
                    <span>{t('Raum', 'Room')}</span>
                    <select data-testid={`lg2-rooms-device-assign-${d.deviceId}`} value={selectValue}
                      onChange={(e): void => {
                        const v = (e.currentTarget as HTMLSelectElement).value;
                        assignShutterToRoom(d.deviceId, v === '' ? VIRTUAL_UNASSIGNED_ROOM_ID : v);
                      }}>
                      <option value="">{t('— nicht zugewiesen —', '— unassigned —')}</option>
                      {draftRooms.map((r) => (<option key={r.id} value={r.id}>{r.name}{r.floor !== undefined ? ` (${r.floor})` : ''}</option>))}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <h3 class="lg2-rooms__devices-head">{t('Temperatur-Sensoren', 'Temperature sensors')} ({discovery.temperatureSources.value.length})</h3>
        {discovery.temperatureSources.value.length === 0 ? (
          <p class="lg2-rooms__hint" data-testid="lg2-rooms-tempsensors-empty">
            {t('„Geräte suchen" ausführen. Zuweisung erfolgt je Raum über „Innentemperatur-Sensor".', 'Run "Discover devices". Assign per room via "Indoor temperature sensor".')}
          </p>
        ) : (
          <ul class="lg2-rooms__device-list">
            {discovery.temperatureSources.value.map((d) => (
              <li key={d.deviceId} class="lg2-rooms__device" data-testid={`lg2-rooms-tempsensor-${d.deviceId}`}>
                <strong>{deviceLabel(d)}</strong>
                <small>{t('Im Raum unter „Innentemperatur-Sensor" wählen', 'Choose it per room under "Indoor temperature sensor"')}</small>
              </li>
            ))}
          </ul>
        )}

        <h3 class="lg2-rooms__devices-head">{t('Fensterkontakte', 'Window contacts')} ({discovery.contactSources.value.length})</h3>
        {discovery.contactSources.value.length === 0 ? (
          <p class="lg2-rooms__hint" data-testid="lg2-rooms-contacts-empty">
            {t('„Geräte suchen" ausführen. Zuweisung erfolgt je Rollladen über „Fensterkontakt".', 'Run "Discover devices". Assign per shutter via "Window contact".')}
          </p>
        ) : (
          <ul class="lg2-rooms__device-list">
            {discovery.contactSources.value.map((d) => {
              const usedBy = contactUsage.get(d.deviceId);
              return (
                <li key={d.deviceId} class="lg2-rooms__device" data-testid={`lg2-rooms-contact-${d.deviceId}`}>
                  <strong>{deviceLabel(d)}</strong>
                  <small>{usedBy !== undefined ? t(`belegt: ${usedBy}`, `in use: ${usedBy}`) : t('am Rollladen unter „Fensterkontakt" zuweisen', 'assign per shutter under "Window contact"')}</small>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
