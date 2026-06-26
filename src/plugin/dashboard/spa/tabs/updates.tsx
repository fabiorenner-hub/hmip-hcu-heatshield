/**
 * Heat Shield — "Updates" tab (V1.8).
 *
 * Shows the running version/build and a human-readable changelog. The
 * changelog is kept as a static, typed list here (the SPA can't read the
 * repo CHANGELOG.md at runtime); it is bumped alongside `version.ts`.
 */

import { Fragment, h, type JSX } from 'preact';

import { APP_VERSION } from '../version.js';
import { useDiscovery } from '../hooks/useDiscovery.js';
import { useUpdateCheck, GITHUB_URL, GITHUB_RELEASES_URL } from '../hooks/useUpdateCheck.js';

interface ChangelogEntry {
  version: string;
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.16.8',
    items: [
      'Update-Hinweis: prüft GitHub auf eine neuere Version; das Versions-Badge oben zeigt dann einen Punkt und führt per Klick auf die Updates-Seite mit GitHub-Link.',
      'Neue Einstellungen-Kachel „Logs & Debug": Live-Connect-Protokoll, alle Diagnose-Endpunkte als Roh-JSON (Kopieren/Download) und Build-Infos.',
      'Hilfe ist jetzt ein kompakter Funktions-Überblick mit Kurzerklärungen und Suche statt eines langen Handbuchs.',
    ],
  },
  {
    version: '1.16.7',
    items: [
      'Fix: Neuladen/Direktaufruf eines Tabs (z. B. /forecast, /bewaesserung) zeigte einen 404-Fehler statt der App. Ein SPA-Fallback liefert jetzt index.html — Aktualisieren und Deep-Links funktionieren auf jedem Tab.',
    ],
  },
  {
    version: '1.16.6',
    items: [
      'Diagramme: Dive-Deep ist jetzt interaktiv (Fadenkreuz + Werte-Tooltip beim Überfahren) und wird nicht mehr verzerrt — Kurven und Beschriftungen rendern pixelgenau statt gestreckt.',
      'Einheitliche Karten-Titel über alle Tabs: kein großer Leerraum mehr über der Überschrift, angemessene Schriftgrößen.',
      'Wetter-Tab: Wind-Kachel füllt die Höhe des Regenradars und zeigt zusätzlich die Bewölkung.',
    ],
  },
  {
    version: '1.16.5',
    items: [
      'Planer reagiert sofort: Änderungen (Verschieben, Dauer, An/Aus, Hinzufügen, Löschen) werden optimistisch direkt angezeigt, statt auf die nächste Server-Aktualisierung zu warten.',
      'Dauer-Dropdown zeigt jetzt immer den korrekten Wert (auch krumme Auto-Dauern); Auto-Dauern werden auf 5-Minuten-Schritte gerundet.',
    ],
  },
  {
    version: '1.16.4',
    items: [
      'Fix: Der Bewässerungsplan wurde ausgeführt, obwohl die automatische Bewässerung ausgeschaltet war. Geplante Einträge werden jetzt nur bei eingeschalteter Automatik dispatcht; die Vorschau bleibt sichtbar.',
    ],
  },
  {
    version: '1.16.3',
    items: [
      'Wetter-Tab komplett überarbeitet: einheitliche Karten-Überschriften und sinnvolle Reihenfolge (Aktuelle Werte → 24-h-Vorhersage → Radar & Wind → Diagramme → Verlauf).',
      'Haus-bezogene Abschnitte (Innenraum-Prognose, Wirkung) stehen jetzt klar abgetrennt am Ende statt mitten im Wetter.',
    ],
  },
  {
    version: '1.16.2',
    items: [
      'Planer: geplante Bewässerungen dürfen sich nicht mehr überschneiden — nie mehr als ein Ventil gleichzeitig offen, jetzt auch im Plan erzwungen (Überschneidung beim Verschieben/Hinzufügen wird abgelehnt, Auto-Einträge weichen aus).',
      'Tagesplan-Drag spürbar flüssiger (Track-Geometrie wird gecacht, weniger Re-Renders).',
      'Die blaue Linie in den Zonen-Karten ist jetzt beschriftet: Bodenwasser-Prognose (verfügbares Wasser, nächste ~3 Tage).',
    ],
  },
  {
    version: '1.16.1',
    items: [
      'Fix: Der Bewässerung-Tab ließ sich nicht mehr öffnen („Something went wrong. Fragment is not defined") — fehlender Fragment-Import behoben (betraf auch den Updates-Tab).',
    ],
  },
  {
    version: '1.16.0',
    items: [
      'Automatische Bewässerung lässt sich jetzt direkt im Bewässerung-Tab oben ein- und ausschalten.',
      'Beim manuellen „Bewässern" fragt das Plugin nach der Dauer – wählbar von 5 bis 60 Minuten in 5-Minuten-Schritten.',
      'Editierbarer Tagesplan: geplante Bewässerungen pro Eintrag per Drag verschieben (Zeit), Dauer ändern, an/aus schalten, löschen und neue hinzufügen. Die Engine führt die Einträge zur geplanten Zeit aus (immer nur ein Ventil gleichzeitig).',
      'Boden-Kalibrierung pro Zone: der tatsächliche Bodenwasser-Stand lässt sich setzen, damit das Modell nach dem Anlegen nicht fälschlich „voll" annimmt.',
      'Eigene Gardena-Sensor-Kachel (Bodenfeuchte, Bodentemperatur, Licht, Batterie); die Mäher-Kachel ist entfallen.',
      'Ventile lassen sich in den Einstellungen deaktivieren – deaktivierte Ventile verschwinden aus der Bewässern-Ansicht und werden nie automatisch gesteuert.',
      'Der Betriebsmodus (Eco/Normal/Hitze/Anwuchs) verschiebt jetzt auch den Auslöse-Zeitpunkt der Bewässerung, nicht nur die Wassermenge.',
      'Durchgängig deutsche, konsistente Begriffe in allen Tabs (u. a. Diagnose, Automatik, Einrichtungs-Assistent).',
    ],
  },
  {
    version: '1.15.0',
    items: [
      'Bewässerung im Vollausbau: ET-basierte Wasserbilanz (FAO-56) pro Zone mit Open-Meteo-ET0 und Bodendaten – gegossen wird genau bedarfsgerecht bis Feldkapazität.',
      'Lern-Algorithmus: kalibriert pro Zone Pflanzenkoeffizient (Kc) und Emitter-Abgabe aus der gemessenen Bodenfeuchte und erkennt defekte Emitter.',
      'Forecast-Modell: projiziert die Bodenfeuchte über 72 h und zeigt die nächste Bewässerung (ETA) je Zone.',
      'Zonen mit Pflanzen-/Boden-/Emitter-Profil, Gardena-Ventil und Bodenfeuchte-Sensor; Gates für Regen, Frost, Wind, Zeitfenster, Budgets, Cycle-and-Soak, Sequenzierung, PV-Vorzug, Mäher-Koordination und Pumpe.',
      'Live-Zonen-Kacheln (Feuchte-Gauge, Wasserbilanz, „Warum", Forecast) im Bewässerung-Tab; neue Zonen-Verwaltung unter Einstellungen → Bewässerung.',
      'Gardena-Bodenfeuchtesensor wird jetzt zuverlässig erkannt (Dienste werden nicht mehr nach Typ verworfen); Sensor-Erkennung über die Messwerte.',
      'Es ist immer nur EIN Ventil gleichzeitig offen (gemeinsame Wasserversorgung) – fest erzwungen. Zeitfenster und „offen bis"-Zeit je Zone sichtbar. Ungenutzte Ventile lassen sich ausblenden. „Gardena verbinden" liegt unter Einstellungen → Bewässerung.',
    ],
  },
  {
    version: '1.14.0',
    items: [
      'Gardena ist jetzt direkt im Plugin integriert: Heat Shield verbindet sich mit deinem eigenen GARDENA-API-Zugang (Application Key + Secret) – kein separates Gardena-Plugin auf der HCU mehr nötig.',
      'Liest Bodenfeuchte, Boden-/Umgebungstemperatur und Licht der Gardena-Sensoren und steuert Ventile (Bewässern/Stopp) direkt über die Gardena-Cloud, mit Live-Updates per WebSocket.',
      'Einrichtung im Bewässerung-Tab unter „Gardena verbinden": Application Key/Secret, optionale Location-ID, Standard-Bewässerungsdauer und ein „Verbindung testen"-Button. Das Secret wird maskiert gespeichert.',
    ],
  },
  {
    version: '1.13.0',
    items: [
      'Benachrichtigungen (Telegram-Setup, Morgen-Briefing, Ereignisse, Abend-Rückblick, Wetter-Updates) sind eine eigene Kachel unter Einstellungen.',
      'Wetter-Tab: kompaktere Windrose mit einem „Wind-Ausblick" (max. Böen heute/morgen, Hauptwindrichtung) direkt darunter.',
      'Neuer Diagramm-Bereich „Wettervorhersage · Diagramme": Temperatur & gefühlt, Niederschlag, Regenwahrscheinlichkeit, Bewölkung, Wind & Böen, Globalstrahlung, UV-Index, Luftdruck, Luftfeuchte (24 h/48 h umschaltbar) plus 7-Tage-Temperatur — jedes Diagramm zum Vergrößern.',
      '„Forecast – Nächste 24 Stunden" heißt jetzt „Wettervorhersage – Nächste 24 Stunden".',
    ],
  },
  {
    version: '1.12.0',
    items: [
      'Wetter-Tab: „Aktuelle Werte" stehen jetzt über dem Regenradar.',
      'Regenradar mit dunkler Karte (CARTO „dark") passend zum UI; Regen wird mit kräftigem Farbschema deutlich sichtbar dargestellt, dazu ein zuschaltbarer Wolken-Layer (Button „Wolken").',
      'Bewässerung: volle Gardena-Anbindung — Bodenfeuchte, Bodentemperatur und Lichtintensität je Sensor werden live angezeigt, Ventile lassen sich direkt ein-/ausschalten (Bewässern/Stopp).',
      'Vorbereitung für die automatische Bewässerungsplanung anhand von Niederschlag, Bodenfeuchte, Sonne und Temperatur.',
    ],
  },
  {
    version: '1.11.0',
    items: [
      'Windgeschwindigkeit wird jetzt systemweit in km/h angezeigt (Windrose, KPIs, Automatik, Sturm-Schwelle).',
      'Wetter-Tab: „Forecast – Nächste 24 Stunden" steht jetzt über dem Regenradar; neue Karte „Aktuelle Werte" mit UV-Index, Niederschlag (jetzt/heute), Luftdruck, Luftfeuchte sowie Sonnenauf-/-untergang.',
      'DWD-Unwetterwarnungen werden nur noch angezeigt, wenn es tatsächlich Warnungen gibt.',
      'Neuer Tab „Bewässerung" (links von „Wetter") mit Fokus auf Regen, Niederschlagsmenge und Gewitter — KPIs und Diagramme (24 h + 7 Tage). Gardena-Anbindung ist vorbereitet (geplant).',
    ],
  },
  {
    version: '1.10.0',
    items: [
      'Neuer „Wetter"-Tab (vormals „Forecast"): animiertes Regenradar (Leaflet + RainViewer), Windrose mit Windrichtung und Böen (Open-Meteo) und amtliche DWD-Unwetterwarnungen für deinen Standort.',
      'Regenradar mit Play/Pause und Zeit-Slider; Windrose zeigt Richtung, m/s und Beaufort; DWD-Warnungen farbcodiert nach Warnstufe (1–4).',
      'Standort/Region für DWD-Warnungen in der Config einstellbar (Region-Name oder Warncell-ID); Standard „Beispielstadt".',
    ],
  },
  {
    version: '1.9.1',
    items: [
      'Fix: Das Schloss-Symbol über dem Twin wurde kaum/nicht angezeigt. Das Icon nutzt jetzt eine explizit weiße Stroke-Farbe, etwas mehr Größe und einen feinen Schatten.',
    ],
  },
  {
    version: '1.9.0',
    items: [
      'Vollständiges Hilfe-Handbuch: nach Kategorien gruppiert, mit Volltextsuche, allen Betriebsmodi inkl. Schwellwerten, kompletter Einstellwert-Referenz, Glossar und FAQ/Fehlerbehebung.',
      'Weitere eigene SVG-Icons: echtes Zahnrad für „Einstellungen" und ein Schloss-Symbol (auf/zu) über dem Twin statt Emoji.',
    ],
  },
  {
    version: '1.8.9',
    items: [
      'Test: eigene weiße Linien-SVG-Icons (transparenter Hintergrund) statt Emoji in den KPI-Kacheln — PV (⚡), Innen, Außen, Sonne und Hitze-Index.',
    ],
  },
  {
    version: '1.8.8',
    items: [
      'Sommer-Beobachtung wird früher aktiv: Schwellen auf Prognose ≥ 20 °C (statt 24) und Außen ≥ 18 °C (statt 22) gesenkt; PV unverändert > 2,0 kW. Bestehende Konfigurationen werden beim Laden automatisch aktualisiert.',
      'Automatik-Logik: doppelte Anzeige der Begründung entfernt — „Ausschlaggebend" steht jetzt nur einmal; die vollständige Herleitung bleibt hinter dem ⓘ.',
      '„Nächste Aktionen"-Zeilen nutzen jetzt die transparente Glas-Optik statt eines opaken Balkens.',
    ],
  },
  {
    version: '1.8.7',
    items: [
      'Einheitliches UI: alle Kacheln und Karten teilen jetzt EINE Glas-Oberfläche — gleicher Hintergrund, Rahmen, Eck-Radius (14 px) und Schatten über alle Tabs.',
      'Keine unterschiedlichen Ecken/Rahmen mehr (Fenster-, Raum-, KPI-, Analyse-, Forecast- und Automatik-Karten sind jetzt deckungsgleich).',
    ],
  },
  {
    version: '1.8.6',
    items: [
      'Modernes 3D-Glass-UI über alle Tabs: top-belichteter Glas-Schliff, mehrlagige Tiefen-Schatten und ein sanftes Anheben interaktiver Karten beim Überfahren.',
      'Glas-Icon-Buttons mit Hover-/Druck-Effekt; aktiver Tab mit Verlauf und Glow; Forecast-, Automatik- und Detail-Panels einheitlich aufpoliert.',
      'Respektiert „Reduced Motion" (keine Bewegungseffekte, wenn vom System gewünscht).',
    ],
  },
  {
    version: '1.8.5',
    items: [
      'Planner respektiert die Stauschutz-Grenze jetzt auch in der Vorschau: „Nächste Aktionen", Twin-Prognose und Heatmap zeigen für Fassaden max. 95 % (Dachfenster 100 %) statt fälschlich 100 %.',
      'Haus-Twin lässt sich per Knopf (↺) auf Standard zurücksetzen — Anordnung, Sperre, Wärme-Ansicht und Legende.',
      'Forecast-Panel „Nächste Stunden" mit großer, deutlicher Umrandung; die Kacheln darin sind transparent (Glas).',
    ],
  },
  {
    version: '1.8.4',
    items: [
      'Raum-Popup im Twin wird nicht mehr von der Kachel abgeschnitten — es rendert frei über dem Dashboard (Portal) und bleibt immer vollständig sichtbar.',
      'Popup positioniert sich automatisch ober-/unterhalb des Badges, klemmt sich in den sichtbaren Bereich und scrollt bei Bedarf.',
    ],
  },
  {
    version: '1.8.3',
    items: [
      'Twin-Rollo-Prognose an die echten Planner-Ziele gekoppelt (Stufenfunktion, gedeckelt auf 95/100 %).',
      'Fix: Vorschau zeigte fälschlich „0 % in 2–3 h" bei geschlossenen Rollläden (Rückkopplungsfalle der Wärmelast-Vorschau).',
    ],
  },
  {
    version: '1.8.2',
    items: [
      'Forecast-Leiste mit Glas-Panel; Hintergrund weicher (grober Noise entfernt).',
      'Rollo-Prognose im Twin nutzt die feine 8-Stufen-Leiter wie die Engine.',
    ],
  },
  {
    version: '1.8.1',
    items: ['Fix: Deep-Dive-Diagramme öffnen wieder korrekt zentriert/fast im Vollbild (Portal-Rendering der Overlays).'],
  },
  {
    version: '1.8.0',
    items: [
      'Regelung: konservatives Verhalten bei fehlenden Sensorwerten (Gewichte werden auf vorhandene Faktoren renormiert statt nach „nicht beschatten" zu kippen).',
      'Regelung: feinere 8-stufige Risiko→Rollo-Leiter.',
      'Regelung: PV-Faktor weich um die echte Anlagen-Ausrichtung statt harter 90–200°-Lobe.',
      'Regelung: richtungsabhängige Hysterese — schließt schneller zum Schutz, öffnet träger (Schließ-Eile-Faktor).',
      'Regelung: Modus-Schwellen (°C/kW) jetzt konfigurierbar.',
      'Klima: aktive Vorkühl-Empfehlung bei PV-Überschuss + Hitzeprognose.',
      'UI: helleres Standard-Theme mit stärkerem Farbverlauf und Noise; Ambient ist jetzt standardmäßig AUS.',
      'UI: Deep-Dive-Diagramme öffnen fast im Vollbild; Version steht im Kopf.',
      'UI: Automatik-Tab mit vollständiger technischer Live-Berechnung; Beschattungs-Erklärung nur noch über das ⓘ.',
      'UI: Einstellungen mit „Updates" und ausführlicher „Hilfe"; Forecast-Tab ohne „Nächste Aktionen".',
      'Einstellungen: Zyklusintervall bis 60 min, Mindestpause bis 6 h.',
    ],
  },
  {
    version: '1.7.0',
    items: ['Deep-Dive-Verläufe im Lüftung- und Klima-Tab.'],
  },
  {
    version: '1.6.0',
    items: [
      'Ausführliche Automatik-Erklärung, Versionsanzeige, scrollbarer 24-h-Forecast, KPI-Deep-Dive, Glas-/Glow-/3D-Feinschliff.',
    ],
  },
  {
    version: '1.5.0',
    items: ['Ruhezeiten & Zeitpläne, Voll-Backup/Restore, Pro-Raum-Detailansicht, Onboarding.'],
  },
  {
    version: '1.4.0',
    items: ['24-h-Forecast, kombinierte Verlaufs-/Prognose-Diagramme, Deep-Dive, dunkleres Glas.'],
  },
  {
    version: '1.3.0',
    items: ['Wirkungs-Dashboard, konfidenz-bewusste Steuerung, Unwetterwarnungen, manuelle Übersteuerung, mobiler Twin als Tabelle.'],
  },
  {
    version: '1.2.0',
    items: ['Ganzheitlicher Glas-/Ambient-UI-Rework.'],
  },
  {
    version: '1.1.0',
    items: ['Thermische Selbst-Kalibrierung, Forecast- & Automation-Tab neu.'],
  },
  {
    version: '1.0.0',
    items: ['Erste stabile Version: vorausschauende Beschattung, Haus-Twin, Lernmodul.'],
  },
];

interface RoutableProps {
  path?: string;
}

export function UpdatesTab(_props: RoutableProps): JSX.Element {
  const discovery = useDiscovery();
  const build = discovery.pluginBuild.value;
  const upd = useUpdateCheck();
  return (
    <section class="module-panel tab-updates" data-testid="tab-updates">
      <header class="module-panel__head">
        <h1>Updates</h1>
        <span class="module-panel__badge">v{APP_VERSION}</span>
      </header>
      <p class="module-panel__intro">
        Aktuelle Version <strong>v{APP_VERSION}</strong>
        {build !== null ? <Fragment> · Build <code>{build}</code></Fragment> : null}. Neue Builds
        lädst du in HCUweb hoch; diese Version-Nummer und die Build-Kennung helfen
        beim Abgleich.
      </p>

      {upd.value.updateAvailable ? (
        <article class="module-panel__card updates-banner updates-banner--new" data-testid="updates-available">
          <h3>Update verfügbar: v{upd.value.latest}</h3>
          <p class="module-panel__hint">
            Auf GitHub ist eine neuere Version als deine installierte (v{APP_VERSION}).
            Lade das <code>.tar.gz</code> aus dem Release und installiere es in HCUweb.
          </p>
          <a class="irr-btn" href={upd.value.url} target="_blank" rel="noopener noreferrer">
            Release v{upd.value.latest} öffnen
          </a>
        </article>
      ) : (
        <article class="module-panel__card updates-banner" data-testid="updates-current">
          <h3>{upd.value.checked ? 'Du nutzt die neueste Version.' : 'Prüfe auf Updates…'}</h3>
          <p class="module-panel__hint">
            Quelle &amp; Releases auf GitHub:{' '}
            <a href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              {GITHUB_URL}
            </a>
          </p>
        </article>
      )}

      <ol class="updates-list">
        {CHANGELOG.map((e) => (
          <li key={e.version} class="updates-entry">
            <h2 class="updates-entry__version">v{e.version}</h2>
            <ul class="updates-entry__items">
              {e.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
