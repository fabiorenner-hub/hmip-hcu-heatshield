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

const GROUPS: HelpGroup[] = [
  {
    title: 'Beschattung (Hauptansicht)',
    items: [
      { name: 'Haus-Twin', desc: 'Lebendiges Hausmodell mit Tag/Nacht-Himmel, Sonnenbogen und Raum-Status.' },
      { name: 'Vorausschauende Steuerung', desc: 'Wählt je Raum die Rollladenstellung, die über 12 h komfortabel bleibt – mit möglichst wenigen Fahrten.' },
      { name: 'Heatmap & 12-h-Vorschau', desc: 'Zeigt Wärmelast je Raum und die geplante Rollladenstellung der nächsten Stunden.' },
      { name: 'Rollladen-Konvention', desc: '0 % = offen, 95 % = stärkstes automatisches Schließen (Stauschutz-Spalt), 100 % nur manuell/Dachfenster.' },
      { name: 'Manuelle Übersteuerung', desc: 'Eigene Stellung setzen; die Automatik pausiert für diesen Raum befristet.' },
    ],
  },
  {
    title: 'Betriebsmodi',
    items: [
      { name: 'NORMAL / SUMMER_WATCH', desc: 'Ruhebetrieb bzw. erhöhte Beobachtung bei aufkommender Hitze.' },
      { name: 'ACTIVE_HEAT_PROTECTION / HEATWAVE', desc: 'Aktiver Hitzeschutz bzw. verschärfter Modus bei Hitzewelle.' },
      { name: 'NIGHT_COOLING', desc: 'Nächtliches Auskühlen, wenn außen kühler als innen.' },
      { name: 'STORM', desc: 'Sturmschutz – höchste Priorität, überschreibt alles andere.' },
      { name: 'VACATION / MAINTENANCE', desc: 'Urlaubsbetrieb bzw. Wartung (Automatik ausgesetzt).' },
    ],
  },
  {
    title: 'Wetter',
    items: [
      { name: 'Aktuelle Werte', desc: 'UV, Niederschlag, Luftdruck, Luftfeuchte, Sonnenauf-/-untergang.' },
      { name: 'Wettervorhersage 24 h', desc: 'Stündliche Vorschau (Temperatur, Strahlung, Regenwahrscheinlichkeit).' },
      { name: 'Regenradar', desc: 'Animiertes Radar mit Play/Pause und Zeit-Slider (RainViewer).' },
      { name: 'Wind & Bewölkung', desc: 'Windrose mit Richtung, Geschwindigkeit, Böen und aktueller Bewölkung.' },
      { name: 'DWD-Warnungen', desc: 'Amtliche Unwetterwarnungen für deinen Standort, farbcodiert nach Stufe.' },
      { name: 'Diagramme (Dive-Deep)', desc: 'Interaktive Charts mit Fadenkreuz + Werte-Tooltip; per ⤢ im Großformat.' },
    ],
  },
  {
    title: 'Bewässerung',
    items: [
      { name: 'Automatik-Schalter', desc: 'Oben im Tab – schaltet die automatische Bewässerung global ein/aus.' },
      { name: 'ET-Wasserbilanz', desc: 'Gießt nach Bodenwasser-Defizit (FAO-56) statt nach Zeitplan – tief und selten.' },
      { name: 'Zonen', desc: 'Je Zone Pflanzen-/Boden-/Emitter-Profil, ein Gardena-Ventil und optional ein Feuchtesensor.' },
      { name: 'Manuell bewässern', desc: '„Bewässern" fragt die Dauer (5–60 min); „Kalibrieren" setzt den Bodenwasser-Stand.' },
      { name: 'Tagesplan-Editor', desc: 'Geplante Gaben per Drag verschieben, Dauer/An-Aus ändern, hinzufügen/löschen.' },
      { name: 'Sicherheit', desc: 'Immer nur ein Ventil offen; Regen-/Frost-/Wind-Verzicht; Budgets; PV-bevorzugt.' },
    ],
  },
  {
    title: 'Lüftung & Klima',
    items: [
      { name: 'Lüftungs-Empfehlung', desc: 'Wann Fenster auf/zu sinnvoll ist (außen vs. innen).' },
      { name: 'Kühl-Empfehlung', desc: 'Aktiv-Kühlen / Vorkühlen bei PV-Überschuss und Hitzeprognose.' },
    ],
  },
  {
    title: 'Automatik',
    items: [
      { name: 'Regeln & Schwellen', desc: 'Modus-Schwellen (°C/kW), Sturm-Windgrenze, Hysterese.' },
      { name: 'Live-Berechnung', desc: 'Zeigt die aktuelle Risiko-/Entscheidungsrechnung je Fenster.' },
      { name: 'Master-Schalter', desc: 'Der Schalter oben rechts armiert/entwaffnet die gesamte Automatik.' },
    ],
  },
  {
    title: 'Einstellungen',
    items: [
      { name: 'Räume & Fenster', desc: 'Räume, Stockwerke, Rollläden und Sensoren zuordnen.' },
      { name: 'Quellen', desc: 'Signale (HMIP, FusionSolar, Wetter) binden und testen.' },
      { name: 'Einrichtungs-Assistent', desc: 'Standort, Quellen und Räume Schritt für Schritt einrichten.' },
      { name: 'Bewässerung', desc: 'Gardena verbinden, Zonen anlegen, Ventile aktivieren/deaktivieren.' },
      { name: 'Benachrichtigungen', desc: 'Telegram-Bot, Morgen-Briefing, Abend-Rückblick, Wetter-Updates.' },
      { name: 'Diagnose', desc: 'Verbindungsstatus, Logs und Selbsttests.' },
      { name: 'Logs & Debug', desc: 'Alle Logs, Roh-Daten aller Endpunkte und umfangreiche Debug-Werkzeuge.' },
      { name: 'Updates', desc: 'Version, Build, Changelog und GitHub-Update-Hinweis.' },
    ],
  },
];

export function HelpTab(_props: RoutableProps): JSX.Element {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    if (q === '') return GROUPS;
    return GROUPS.map((g) => ({
      title: g.title,
      items: g.items.filter(
        (it) => it.name.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [q]);

  return (
    <section class="module-panel tab-help" data-testid="tab-help">
      <header class="module-panel__head">
        <h1>Hilfe</h1>
        <span class="module-panel__badge">Funktionen im Überblick</span>
      </header>
      <p class="module-panel__intro">
        Alle Funktionen im Überblick mit einer kurzen Erklärung. Suche nach einem
        Begriff, um schnell das Richtige zu finden.
      </p>

      <input
        type="search"
        class="help-search"
        data-testid="help-search"
        aria-label="In der Hilfe suchen"
        placeholder="Suchen (z. B. Sturm, PV, Bewässern, 95 %) …"
        value={query}
        onInput={(e): void => setQuery((e.currentTarget as HTMLInputElement).value)}
      />

      {groups.length === 0 ? (
        <p class="module-panel__hint">Kein Treffer für „{query}".</p>
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
