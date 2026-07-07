/**
 * Räume & Fenster — configuration page (rebuilt v2.1, no drag-and-drop).
 *
 * A calm, sectioned layout instead of the old two-column drag surface:
 *
 *   1. Toolbar   — discover devices, add room, auto-save status.
 *   2. Presets   — one-click room templates grouped by floor.
 *   3. Rooms     — one expandable card per room. Every assignment is a
 *                  DROPDOWN (shutter → room, thermostat → room, contact →
 *                  window), so the page works on iOS where HTML5 drag-and-drop
 *                  is unreliable. Per-room: name, floor, priority, the four
 *                  target temperatures (now editable inline), indoor sensor,
 *                  quiet schedules, active-cooling marker; per-window:
 *                  orientation, contact, "Automatik aus", block schedules.
 *   4. Devices   — discovered shutters / thermostats / window contacts, each
 *                  with an inline "assign to …" dropdown.
 *
 * Quiet hours are now GRANULAR: a shared {weekdays + clock-time} schedule
 * editor drives both a room's `quietSchedules` and a window's `blockSchedules`.
 * Legacy `noMoveBeforeHour`/`noMoveAfterHour` bounds are migrated into an
 * equivalent daily quiet schedule on load (the engine still honours both).
 * STORM always overrides every block.
 *
 * Persistence is unchanged: a debounced `PUT /api/config` (useConfig), with
 * inline Zod error highlighting from `saveError.issues`.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  Config,
  Room,
  RoomTargets,
  Window as WindowDef,
} from '../../../../shared/types.js';
import { runDiscovery, useDiscovery, type DiscoveredDevice } from '../hooks/useDiscovery.js';
import { DiscoveryStatus } from '../components/discoveryStatus.js';
import { useConfig } from '../hooks/useConfig.js';
import {
  deviceLabel,
  compassLabel,
  TARGET_LABELS,
  PRIORITY_LABELS,
  WINDOW_TYPE_LABELS,
} from '../format.js';
import { t } from '../i18n.js';

/** One weekday+clock-time block rule (shared by room quiet + window block). */
type Schedule = WindowDef['blockSchedules'][number];

const PRIORITIES: Room['priority'][] = ['very_high', 'high', 'medium', 'low'];

/** Compass directions for the window orientation selector (0=N … clockwise). */
const COMPASS_OPTIONS: ReadonlyArray<{ deg: number; labelDe: string; labelEn: string }> = [
  { deg: 0, labelDe: 'Nord', labelEn: 'North' },
  { deg: 45, labelDe: 'Nordost', labelEn: 'Northeast' },
  { deg: 90, labelDe: 'Ost', labelEn: 'East' },
  { deg: 135, labelDe: 'Südost', labelEn: 'Southeast' },
  { deg: 180, labelDe: 'Süd', labelEn: 'South' },
  { deg: 225, labelDe: 'Südwest', labelEn: 'Southwest' },
  { deg: 270, labelDe: 'West', labelEn: 'West' },
  { deg: 315, labelDe: 'Nordwest', labelEn: 'Northwest' },
];

/** Snap an arbitrary orientation to the nearest 45° compass option. */
function nearestCompassDeg(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  const snapped = Math.round(norm / 45) * 45;
  return snapped === 360 ? 0 : snapped;
}

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
 * daily quiet schedule. "moves only from B until A" ⇒ quiet (no move) wraps
 * A:00 → B:00. Returns the room unchanged when there is nothing to migrate.
 */
function migrateLegacyQuiet(room: Room): Room {
  const before = room.noMoveBeforeHour;
  const after = room.noMoveAfterHour;
  const hasLegacy = before !== undefined || after !== undefined;
  const hasSchedules = (room.quietSchedules ?? []).length > 0;
  if (!hasLegacy || hasSchedules) return room;
  const pad = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;
  const start = pad(after ?? 24); // quiet begins at the "no move after" hour
  const end = pad(before ?? 0); // quiet ends at the "no move before" hour
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
/* Shared schedule editor (room quiet hours + window block schedules)         */
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

/**
 * A list of {weekdays + clock-time window} rules. Reused for a room's quiet
 * hours and a window's block schedules. Empty weekday selection = every day.
 * STORM always overrides — surfaced as a hint by the caller.
 */
function ScheduleEditor(props: {
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
    <div class="rsched" data-testid={`sched-${props.idPrefix}`}>
      {list.length === 0 && (
        <p class="rsched__empty">{t('Keine Ruhezeiten — Automatik jederzeit.', 'No quiet hours — automation any time.')}</p>
      )}
      {list.map((s, i) => {
        const active = scheduleActiveNow(s, now);
        return (
          <div class="rsched__row" key={i} data-testid={`sched-${props.idPrefix}-row-${i}`}>
            <div class="rsched__days">
              {BLOCK_WEEKDAYS.map((d) => (
                <button
                  key={d.idx}
                  type="button"
                  class={`rsched__day${s.days.includes(d.idx) ? ' rsched__day--on' : ''}`}
                  title={t(d.de, d.en)}
                  aria-pressed={s.days.includes(d.idx)}
                  onClick={(): void => toggleDay(i, d.idx)}
                >
                  {t(d.de, d.en)}
                </button>
              ))}
            </div>
            <div class="rsched__presets">
              {WEEKDAY_PRESETS.map((p) => (
                <button
                  key={p.de}
                  type="button"
                  class="rsched__preset"
                  onClick={(): void => setPreset(i, p.days)}
                >
                  {t(p.de, p.en)}
                </button>
              ))}
            </div>
            <div class="rsched__times">
              <label>
                {t('von', 'from')}
                <input
                  type="time"
                  value={s.start}
                  data-testid={`sched-${props.idPrefix}-start-${i}`}
                  onInput={(e): void => update(i, { start: (e.currentTarget as HTMLInputElement).value })}
                />
              </label>
              <span aria-hidden="true">–</span>
              <label>
                {t('bis', 'to')}
                <input
                  type="time"
                  value={s.end}
                  data-testid={`sched-${props.idPrefix}-end-${i}`}
                  onInput={(e): void => update(i, { end: (e.currentTarget as HTMLInputElement).value })}
                />
              </label>
              <button
                type="button"
                class="rsched__del"
                title={t('Zeitfenster entfernen', 'Remove time window')}
                aria-label={t('Zeitfenster entfernen', 'Remove time window')}
                onClick={(): void => props.onChange(list.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            </div>
            <div class="rsched__meta">
              {s.days.length === 0 && <span class="rsched__tag">{t('täglich', 'daily')}</span>}
              {active && <span class="rsched__tag rsched__tag--active">{t('jetzt aktiv', 'active now')}</span>}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        class="rsched__add"
        data-testid={`sched-${props.idPrefix}-add`}
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
      class={`room-card ${hasIssue ? 'room-card--issue' : ''}`}
      data-testid={`room-card-${room.id}`}
    >
      <header class="room-card__head">
        <input
          class="room-card__name"
          type="text"
          data-testid={`room-card-name-${room.id}`}
          aria-label={t('Raumname', 'Room name')}
          value={room.name}
          onInput={(e): void => props.onRename((e.currentTarget as HTMLInputElement).value)}
        />
        <label class="room-card__floor-edit">
          <span>{t('Stockwerk', 'Floor')}</span>
          <input
            type="text"
            list={`floor-presets-${room.id}`}
            data-testid={`room-card-floor-${room.id}`}
            placeholder="KG / EG / OG / DG …"
            value={room.floor ?? ''}
            onInput={(e): void => props.onChangeFloor((e.currentTarget as HTMLInputElement).value)}
          />
          <datalist id={`floor-presets-${room.id}`}>
            {FLOOR_PRESETS.map((f) => (<option key={f} value={f} />))}
          </datalist>
        </label>
        <label class="room-card__prio-edit">
          <span>{t('Priorität', 'Priority')}</span>
          <select
            data-testid={`room-card-priority-${room.id}`}
            value={room.priority}
            onChange={(e): void => props.onChangePriority((e.currentTarget as HTMLSelectElement).value as Room['priority'])}
          >
            {PRIORITIES.map((p) => (<option key={p} value={p}>{PRIORITY_LABELS[p]}</option>))}
          </select>
        </label>
        <button
          type="button"
          class="room-card__delete"
          data-testid={`room-card-delete-${room.id}`}
          title={t('Raum löschen', 'Delete room')}
          aria-label={t(`Raum ${room.name} löschen`, `Delete room ${room.name}`)}
          onClick={(): void => props.onDelete()}
        >✕</button>
      </header>

      <div class="room-card__section">
        <span class="room-card__section-label">{t('Zieltemperaturen', 'Target temperatures')}</span>
        <div class="room-card__targets">
          {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
            <label key={k} class="room-card__target">
              <span>{TARGET_LABELS[k]}</span>
              <input
                type="number"
                step={0.1}
                data-testid={`room-card-target-${k}-${room.id}`}
                value={room.targets[k]}
                onInput={(e): void => {
                  const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(v)) props.onChangeTarget(k, v);
                }}
              />
              <small>°C</small>
            </label>
          ))}
        </div>
      </div>

      <div class="room-card__section">
        <span class="room-card__section-label">{t('Innentemperatur-Sensor', 'Indoor temperature sensor')}</span>
        <select
          class="room-card__indoor-select"
          data-testid={`room-card-indoor-select-${room.id}`}
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

      <div class="room-card__section">
        <span class="room-card__section-label">{t('Ruhezeiten', 'Quiet hours')}</span>
        <ScheduleEditor
          idPrefix={`room-${room.id}`}
          schedules={room.quietSchedules ?? []}
          addLabel={t('Ruhezeit', 'Quiet window')}
          onChange={props.onChangeQuietSchedules}
        />
        <span class="room-card__hint">{t('Keine automatischen Fahrten in diesen Zeiten. Sturm ignoriert die Ruhezeit.', 'No automatic moves during these times. Storm ignores the quiet hours.')}</span>
      </div>

      <label class="room-card__cooling" data-testid={`room-card-cooling-${room.id}`}>
        <input
          type="checkbox"
          checked={room.activeCooling === true}
          onChange={(e): void => props.onToggleActiveCooling((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          {t('Aktiv gekühlt (mobile Klimaanlage)', 'Actively cooled (mobile AC)')}
          <small class="room-card__hint">{t('vom Lernen ausgenommen', 'excluded from learning')}</small>
        </span>
      </label>

      <div class="room-card__section">
        <span class="room-card__section-label">
          {t('Rollläden / Fenster', 'Shutters / windows')} ({windows.length})
        </span>
        {windows.length === 0 ? (
          <p class="room-card__hint">{t('Noch kein Rollladen zugewiesen — unten unter „Geräte" zuweisen.', 'No shutter assigned yet — assign one below under "Devices".')}</p>
        ) : (
          <ul class="room-card__windows">
            {windows.map((w) => {
              const meta = props.shutters.find((d) => d.deviceId === w.shutterDeviceId);
              const name = meta !== undefined ? deviceLabel(meta) : t(`Rollladen (…${w.id.slice(-4)})`, `Shutter (…${w.id.slice(-4)})`);
              const contactMeta = w.contactDeviceId !== undefined ? props.contacts.find((d) => d.deviceId === w.contactDeviceId) : undefined;
              const contactLabel = w.contactDeviceId !== undefined
                ? (contactMeta !== undefined ? deviceLabel(contactMeta) : t(`Kontakt (…${w.contactDeviceId.slice(-4)})`, `Contact (…${w.contactDeviceId.slice(-4)})`))
                : null;
              return (
                <li key={w.id} data-testid={`room-card-window-${w.id}`}
                  class={props.issueWindowIds.has(w.id) ? 'room-card__window--issue' : ''}>
                  <div class="room-card__window-head">
                    <span class="room-card__window-name">{name}</span>
                    <small>{WINDOW_TYPE_LABELS[w.type] ?? w.type} · {compassLabel(w.orientationDeg)} ({w.orientationDeg}°)</small>
                  </div>
                  <div class="room-card__window-controls">
                    <label>
                      <span>{t('Himmelsrichtung', 'Orientation')}</span>
                      <select
                        data-testid={`room-card-window-orientation-${w.id}`}
                        value={String(nearestCompassDeg(w.orientationDeg))}
                        onChange={(e): void => props.onChangeOrientation(w.id, Number((e.currentTarget as HTMLSelectElement).value))}
                      >
                        {COMPASS_OPTIONS.map((o) => (<option key={o.deg} value={String(o.deg)}>{t(o.labelDe, o.labelEn)}</option>))}
                      </select>
                    </label>
                    <label data-testid={`room-card-window-contact-${w.id}`}>
                      <span>{t('Fensterkontakt', 'Window contact')}</span>
                      <select
                        data-testid={`room-card-window-contact-select-${w.id}`}
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
                  <label class="room-card__window-block">
                    <input
                      type="checkbox"
                      data-testid={`room-card-window-block-${w.id}`}
                      checked={w.automationBlocked === true}
                      onChange={(e): void => props.onToggleWindowBlock(w.id, (e.currentTarget as HTMLInputElement).checked)}
                    />
                    <span>{t('Automatik aus (dieses Fenster)', 'Automation off (this window)')}</span>
                  </label>
                  <div class="room-card__window-sched">
                    <span class="room-card__section-label">{t('Blockzeiten (nur dieses Fenster)', 'Block times (this window only)')}</span>
                    <ScheduleEditor
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
/* Rooms tab                                                                  */
/* -------------------------------------------------------------------------- */

export function RoomsTab(): JSX.Element {
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
    <section class="tab-rooms" data-testid="tab-rooms">
      <header class="tab-rooms__header">
        <h2>{t('Räume und Fenster', 'Rooms and windows')}</h2>
        <div class="tab-rooms__actions">
          <button type="button" data-testid="rooms-discover" onClick={(): void => { void runDiscovery(); }}>
            {discovery.discovering.value ? t('Suche läuft…', 'Searching…') : t('Geräte suchen', 'Discover devices')}
          </button>
          <button type="button" data-testid="rooms-add" onClick={(): void => setAddForm({ ...INITIAL_ADD_ROOM_FORM, open: true })}>
            {t('Raum hinzufügen', 'Add room')}
          </button>
          <span class="tab-rooms__autosave" data-testid="rooms-autosave">
            {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
          </span>
        </div>
      </header>

      <DiscoveryStatus discovery={discovery} />

      <div class="tab-rooms__presets" data-testid="rooms-presets">
        <span class="tab-rooms__presets-label">{t('Schnell anlegen:', 'Quick add:')}</span>
        {ROOM_PRESETS.map((p) => (
          <button key={p.nameDe} type="button" class="tab-rooms__preset-btn" data-testid={`rooms-preset-${p.nameDe}`}
            title={t(`${p.floor} · Priorität ${p.priority}`, `${p.floor} · priority ${p.priority}`)}
            onClick={(): void => handleAddPreset(p)}>
            + {t(p.nameDe, p.nameEn)} <small>({p.floor})</small>
          </button>
        ))}
      </div>

      {cfg.loadError.value !== null && (
        <p class="tab-rooms__error" data-testid="rooms-load-error">{cfg.loadError.value}</p>
      )}
      {cfg.saveError.value !== null && (
        <div class="tab-rooms__error" data-testid="rooms-save-error">
          <strong>{cfg.saveError.value.error.message}</strong>
          {cfg.saveError.value.error.issues && (
            <ul>{cfg.saveError.value.error.issues.map((iss, idx) => (<li key={idx}>{iss.path.join('.')}: {iss.message}</li>))}</ul>
          )}
        </div>
      )}
      {cfg.saveOk.value && (
        <p class="tab-rooms__ok" data-testid="rooms-save-ok">{t('Konfiguration gespeichert.', 'Configuration saved.')}</p>
      )}

      {addForm.open && (
        <form class="tab-rooms__add-form" data-testid="rooms-add-form" onSubmit={handleAddRoomSubmit}>
          <label>{t('Id', 'ID')}
            <input data-testid="rooms-add-id" value={addForm.id}
              onInput={(e): void => setAddForm({ ...addForm, id: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label>{t('Name', 'Name')}
            <input data-testid="rooms-add-name" value={addForm.name}
              onInput={(e): void => setAddForm({ ...addForm, name: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label>{t('Stockwerk', 'Floor')}
            <input data-testid="rooms-add-floor" placeholder={t('z.B. OG / EG / KG', 'e.g. OG / EG / KG')} value={addForm.floor}
              onInput={(e): void => setAddForm({ ...addForm, floor: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label>{t('Priorität', 'Priority')}
            <select data-testid="rooms-add-priority" value={addForm.priority}
              onChange={(e): void => setAddForm({ ...addForm, priority: (e.currentTarget as HTMLSelectElement).value as Room['priority'] })}>
              {PRIORITIES.map((p) => (<option key={p} value={p}>{PRIORITY_LABELS[p]}</option>))}
            </select>
          </label>
          {(['target_c', 'warning_c', 'strong_shade_c', 'critical_c'] as const).map((k) => (
            <label key={k}>{TARGET_LABELS[k]}
              <input type="number" step={0.1} data-testid={`rooms-add-${k}`} value={addForm.targets[k]}
                onInput={(e): void => {
                  const next = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                  setAddForm({ ...addForm, targets: { ...addForm.targets, [k]: Number.isFinite(next) ? next : addForm.targets[k] } });
                }} />
            </label>
          ))}
          <div class="tab-rooms__add-form-actions">
            <button type="submit" data-testid="rooms-add-submit">{t('Hinzufügen', 'Add')}</button>
            <button type="button" data-testid="rooms-add-cancel" onClick={(): void => setAddForm(INITIAL_ADD_ROOM_FORM)}>{t('Abbrechen', 'Cancel')}</button>
          </div>
        </form>
      )}

      <div class="tab-rooms__rooms">
        {draftRooms.length === 0 && (
          <p class="tab-rooms__hint">{t('Noch keine Räume. „Raum hinzufügen" oder ein Preset oben nutzen.', 'No rooms yet. Use "Add room" or a preset above.')}</p>
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

      <div class="tab-rooms__devices">
        <h3>{t('Geräte', 'Devices')}</h3>
        <h4>{t('Gefundene Rollläden', 'Discovered shutters')} ({discoveredShutters.length})</h4>
        {discoveredShutters.length === 0 ? (
          <p class="tab-rooms__hint" data-testid="rooms-discover-empty">
            {t('„Geräte suchen" ausführen, um HMIP-Rollläden und Beschattungsmodule (z. B. HmIP-HDM1) zu finden.', 'Run "Discover devices" to find HMIP shutters and shading modules (e.g. HmIP-HDM1).')}
          </p>
        ) : (
          <ul class="tab-rooms__device-list">
            {discoveredShutters.map((d) => {
              const assignedRoomId = windowAssignments[d.deviceId];
              const selectValue = assignedRoomId === undefined || assignedRoomId === VIRTUAL_UNASSIGNED_ROOM_ID ? '' : assignedRoomId;
              return (
                <li key={d.deviceId} data-testid={`rooms-device-${d.deviceId}`}>
                  <strong>{deviceLabel(d)}</strong>
                  <label class="tab-rooms__assign">
                    <span>{t('Raum', 'Room')}</span>
                    <select class="tab-rooms__assign-select" data-testid={`rooms-device-assign-${d.deviceId}`} value={selectValue}
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

        <h4>{t('Temperatur-Sensoren', 'Temperature sensors')} ({discovery.temperatureSources.value.length})</h4>
        {discovery.temperatureSources.value.length === 0 ? (
          <p class="tab-rooms__hint" data-testid="rooms-tempsensors-empty">
            {t('„Geräte suchen" ausführen. Zuweisung erfolgt je Raum über „Innentemperatur-Sensor".', 'Run "Discover devices". Assign per room via "Indoor temperature sensor".')}
          </p>
        ) : (
          <ul class="tab-rooms__device-list">
            {discovery.temperatureSources.value.map((d) => (
              <li key={d.deviceId} data-testid={`rooms-tempsensor-${d.deviceId}`}>
                <strong>{deviceLabel(d)}</strong>
                <small>{t('Im Raum unter „Innentemperatur-Sensor" wählen', 'Choose it per room under "Indoor temperature sensor"')}</small>
              </li>
            ))}
          </ul>
        )}

        <h4>{t('Fensterkontakte', 'Window contacts')} ({discovery.contactSources.value.length})</h4>
        {discovery.contactSources.value.length === 0 ? (
          <p class="tab-rooms__hint" data-testid="rooms-contacts-empty">
            {t('„Geräte suchen" ausführen. Zuweisung erfolgt je Rollladen über „Fensterkontakt".', 'Run "Discover devices". Assign per shutter via "Window contact".')}
          </p>
        ) : (
          <ul class="tab-rooms__device-list">
            {discovery.contactSources.value.map((d) => {
              const usedBy = contactUsage.get(d.deviceId);
              return (
                <li key={d.deviceId} data-testid={`rooms-contact-${d.deviceId}`}>
                  <strong>{deviceLabel(d)}</strong>
                  <small>{usedBy !== undefined ? t(`belegt: ${usedBy}`, `in use: ${usedBy}`) : t('am Rollladen unter „Fensterkontakt" zuweisen', 'assign per shutter under "Window contact"')}</small>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
