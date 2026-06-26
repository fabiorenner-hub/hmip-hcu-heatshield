/**
 * Heat Shield — "Hilfe" tab.
 *
 * All functions at a glance, each with a short explanation — grouped by area
 * and filterable via a search box. Deliberately concise (an overview, not a
 * deep manual); the detailed behaviour lives in the respective tabs and the
 * README on GitHub.
 */

import { h, type JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';

import { t, lang } from '../i18n.js';

interface RoutableProps {
  path?: string;
}

interface HelpItem {
  name: string;
  desc: string;
}
interface HelpGroup {
  title: string;
  items: HelpItem[];
}

function buildGroups(): HelpGroup[] {
  return [
  {
    title: t('Beschattung (Hauptansicht)', 'Shading (main view)'),
    items: [
      { name: t('Haus-Twin', 'House twin'), desc: t('Lebendiges Hausmodell mit Tag/Nacht-Himmel, Sonnenbogen und Raum-Status.', 'Living house model with day/night sky, sun arc and room status.') },
      { name: t('Vorausschauende Steuerung', 'Predictive control'), desc: t('Wählt je Raum die Rollladenstellung, die über 12 h komfortabel bleibt – mit möglichst wenigen Fahrten.', 'Picks the shutter position per room that stays comfortable over 12 h – with as few moves as possible.') },
      { name: t('Heatmap & 12-h-Vorschau', 'Heatmap & 12 h preview'), desc: t('Zeigt Wärmelast je Raum und die geplante Rollladenstellung der nächsten Stunden.', 'Shows the heat load per room and the planned shutter position for the coming hours.') },
      { name: t('Rollladen-Konvention', 'Shutter convention'), desc: t('0 % = offen, 95 % = stärkstes automatisches Schließen (Stauschutz-Spalt), 100 % nur manuell/Dachfenster.', '0 % = open, 95 % = strongest automatic closing (heat-trap gap), 100 % only manual/roof window.') },
      { name: t('Manuelle Übersteuerung', 'Manual override'), desc: t('Eigene Stellung setzen; die Automatik pausiert für diesen Raum befristet.', 'Set your own position; the automation pauses for this room temporarily.') },
    ],
  },
  {
    title: t('Betriebsmodi', 'Operating modes'),
    items: [
      { name: 'NORMAL / SUMMER_WATCH', desc: t('Ruhebetrieb bzw. erhöhte Beobachtung bei aufkommender Hitze.', 'Idle operation or heightened monitoring as heat builds up.') },
      { name: 'ACTIVE_HEAT_PROTECTION / HEATWAVE', desc: t('Aktiver Hitzeschutz bzw. verschärfter Modus bei Hitzewelle.', 'Active heat protection or an intensified mode during a heatwave.') },
      { name: 'NIGHT_COOLING', desc: t('Nächtliches Auskühlen, wenn außen kühler als innen.', 'Night-time cooling when it is cooler outside than inside.') },
      { name: 'STORM', desc: t('Sturmschutz – höchste Priorität, überschreibt alles andere.', 'Storm protection – highest priority, overrides everything else.') },
      { name: 'VACATION / MAINTENANCE', desc: t('Urlaubsbetrieb bzw. Wartung (Automatik ausgesetzt).', 'Vacation mode or maintenance (automation suspended).') },
    ],
  },
  {
    title: t('Wetter', 'Weather'),
    items: [
      { name: t('Aktuelle Werte', 'Current values'), desc: t('UV, Niederschlag, Luftdruck, Luftfeuchte, Sonnenauf-/-untergang.', 'UV, precipitation, air pressure, humidity, sunrise/sunset.') },
      { name: t('Wettervorhersage 24 h', 'Weather forecast 24 h'), desc: t('Stündliche Vorschau (Temperatur, Strahlung, Regenwahrscheinlichkeit).', 'Hourly preview (temperature, radiation, rain probability).') },
      { name: t('Regenradar', 'Rain radar'), desc: t('Animiertes Radar mit Play/Pause und Zeit-Slider (RainViewer).', 'Animated radar with play/pause and a time slider (RainViewer).') },
      { name: t('Wind & Bewölkung', 'Wind & cloud cover'), desc: t('Windrose mit Richtung, Geschwindigkeit, Böen und aktueller Bewölkung.', 'Wind rose with direction, speed, gusts and current cloud cover.') },
      { name: t('DWD-Warnungen', 'DWD warnings'), desc: t('Amtliche Unwetterwarnungen für deinen Standort, farbcodiert nach Stufe.', 'Official severe-weather warnings for your location, colour-coded by level.') },
      { name: t('Diagramme (Dive-Deep)', 'Charts (dive deep)'), desc: t('Interaktive Charts mit Fadenkreuz + Werte-Tooltip; per ⤢ im Großformat.', 'Interactive charts with crosshair + value tooltip; enlarge via ⤢.') },
    ],
  },
  {
    title: t('Bewässerung', 'Irrigation'),
    items: [
      { name: t('Automatik-Schalter', 'Automation switch'), desc: t('Oben im Tab – schaltet die automatische Bewässerung global ein/aus.', 'At the top of the tab – turns automatic irrigation on/off globally.') },
      { name: t('ET-Wasserbilanz', 'ET water balance'), desc: t('Gießt nach Bodenwasser-Defizit (FAO-56) statt nach Zeitplan – tief und selten.', 'Waters by soil-water deficit (FAO-56) instead of a schedule – deep and infrequent.') },
      { name: t('Zonen', 'Zones'), desc: t('Je Zone Pflanzen-/Boden-/Emitter-Profil, ein Gardena-Ventil und optional ein Feuchtesensor.', 'Per zone a plant/soil/emitter profile, a Gardena valve and an optional moisture sensor.') },
      { name: t('Manuell bewässern', 'Water manually'), desc: t('„Bewässern" fragt die Dauer (5–60 min); „Kalibrieren" setzt den Bodenwasser-Stand.', '"Water" asks for the duration (5–60 min); "Calibrate" sets the soil-water level.') },
      { name: t('Tagesplan-Editor', 'Daily-plan editor'), desc: t('Geplante Gaben per Drag verschieben, Dauer/An-Aus ändern, hinzufügen/löschen.', 'Move scheduled waterings by drag, change duration/on-off, add/delete.') },
      { name: t('Sicherheit', 'Safety'), desc: t('Immer nur ein Ventil offen; Regen-/Frost-/Wind-Verzicht; Budgets; PV-bevorzugt.', 'Only one valve open at a time; rain/frost/wind skip; budgets; PV-preferred.') },
    ],
  },
  {
    title: t('Lüftung & Klima', 'Ventilation & climate'),
    items: [
      { name: t('Lüftungs-Empfehlung', 'Ventilation recommendation'), desc: t('Wann Fenster auf/zu sinnvoll ist (außen vs. innen).', 'When opening/closing windows makes sense (outside vs. inside).') },
      { name: t('Kühl-Empfehlung', 'Cooling recommendation'), desc: t('Aktiv-Kühlen / Vorkühlen bei PV-Überschuss und Hitzeprognose.', 'Active cooling / pre-cooling on PV surplus and a heat forecast.') },
    ],
  },
  {
    title: t('Automatik', 'Automation'),
    items: [
      { name: t('Regeln & Schwellen', 'Rules & thresholds'), desc: t('Modus-Schwellen (°C/kW), Sturm-Windgrenze, Hysterese.', 'Mode thresholds (°C/kW), storm wind limit, hysteresis.') },
      { name: t('Live-Berechnung', 'Live calculation'), desc: t('Zeigt die aktuelle Risiko-/Entscheidungsrechnung je Fenster.', 'Shows the current risk/decision calculation per window.') },
      { name: t('Master-Schalter', 'Master switch'), desc: t('Der Schalter oben rechts armiert/entwaffnet die gesamte Automatik.', 'The switch at the top right arms/disarms the entire automation.') },
    ],
  },
  {
    title: t('Einstellungen', 'Settings'),
    items: [
      { name: t('Räume & Fenster', 'Rooms & windows'), desc: t('Räume, Stockwerke, Rollläden und Sensoren zuordnen.', 'Assign rooms, floors, shutters and sensors.') },
      { name: t('Quellen', 'Sources'), desc: t('Signale (HMIP, FusionSolar, Wetter) binden und testen.', 'Bind and test signals (HMIP, FusionSolar, weather).') },
      { name: t('Einrichtungs-Assistent', 'Setup wizard'), desc: t('Standort, Quellen und Räume Schritt für Schritt einrichten.', 'Set up location, sources and rooms step by step.') },
      { name: t('Bewässerung', 'Irrigation'), desc: t('Gardena verbinden, Zonen anlegen, Ventile aktivieren/deaktivieren.', 'Connect Gardena, create zones, enable/disable valves.') },
      { name: t('Benachrichtigungen', 'Notifications'), desc: t('Telegram-Bot, Morgen-Briefing, Abend-Rückblick, Wetter-Updates.', 'Telegram bot, morning briefing, evening summary, weather updates.') },
      { name: t('Diagnose', 'Diagnostics'), desc: t('Verbindungsstatus, Logs und Selbsttests.', 'Connection status, logs and self-tests.') },
      { name: t('Logs & Debug', 'Logs & debug'), desc: t('Alle Logs, Roh-Daten aller Endpunkte und umfangreiche Debug-Werkzeuge.', 'All logs, raw data of every endpoint and extensive debug tools.') },
      { name: t('Updates', 'Updates'), desc: t('Version, Build, Changelog und GitHub-Update-Hinweis.', 'Version, build, changelog and GitHub update notice.') },
    ],
  },
  ];
}

export function HelpTab(_props: RoutableProps): JSX.Element {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const all = buildGroups();
    if (q === '') return all;
    return all.map((g) => ({
      title: g.title,
      items: g.items.filter(
        (it) => it.name.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [q, lang.value]);

  return (
    <section class="module-panel tab-help" data-testid="tab-help">
      <header class="module-panel__head">
        <h1>{t('Hilfe', 'Help')}</h1>
        <span class="module-panel__badge">{t('Funktionen im Überblick', 'Features at a glance')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Alle Funktionen im Überblick mit einer kurzen Erklärung. Suche nach einem Begriff, um schnell das Richtige zu finden.',
          'All features at a glance with a short explanation. Search for a term to quickly find the right one.',
        )}
      </p>

      <input
        type="search"
        class="help-search"
        data-testid="help-search"
        aria-label={t('In der Hilfe suchen', 'Search the help')}
        placeholder={t('Suchen (z. B. Sturm, PV, Bewässern, 95 %) …', 'Search (e.g. storm, PV, watering, 95 %) …')}
        value={query}
        onInput={(e): void => setQuery((e.currentTarget as HTMLInputElement).value)}
      />

      {groups.length === 0 ? (
        <p class="module-panel__hint">{t(`Kein Treffer für „${query}".`, `No match for "${query}".`)}</p>
      ) : (
        <div class="help-groups">
          {groups.map((g) => (
            <article key={g.title} class="module-panel__card help-group" data-testid="help-group">
              <h3>{g.title}</h3>
              <dl class="help-group__list">
                {g.items.map((it) => (
                  <div key={it.name} class="help-group__row">
                    <dt>{it.name}</dt>
                    <dd>{it.desc}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
