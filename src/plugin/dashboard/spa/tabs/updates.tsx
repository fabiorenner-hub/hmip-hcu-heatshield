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
import { t } from '../i18n.js';

interface ChangelogEntry {
  version: string;
  items: string[];
}

function getChangelog(): ChangelogEntry[] {
  return [
  {
    version: '1.18.2',
    items: [
      t(
        'Regenradar: die Bedien-Elemente der Karte (Zoom-Buttons, Quellenangabe) waren hell und passen sich jetzt dem dunklen UI an.',
        'Rain radar: the map controls (zoom buttons, attribution) were light and now match the dark UI.',
      ),
    ],
  },
  {
    version: '1.18.1',
    items: [
      t(
        'Logs & Debug: neuer Button „Alle Informationen" — ein 360°-Diagnose-Export, der alle Status-/Diagnose-Endpunkte, API-Werkzeuge und das Connect-Protokoll plus Browser- und System-Infos in einer einzigen .txt-Datei bündelt (ideal für Bug-Reports).',
        'Logs & Debug: new "All information" button — a 360° diagnostics export bundling all status/diagnostic endpoints, API tools and the Connect log plus browser and system info into a single .txt file (ideal for bug reports).',
      ),
    ],
  },
  {
    version: '1.18.0',
    items: [
      t(
        'Premium-UI-Politur: durchgehend einheitliche Karten-Radien, Schatten und Abstände, eine klare Typo-Skala für Überschriften/Karten-Titel und einheitliche Form-Elemente (Eingaben, Buttons, Chips).',
        'Premium UI polish: consistent card radii, shadows and spacing throughout, a clear type scale for headings/card titles and unified form controls (inputs, buttons, chips).',
      ),
      t(
        'Bessere Lesbarkeit: zu kleine Mikro-Beschriftungen auf eine lesbare Mindestgröße angehoben.',
        'Better readability: tiny micro-labels raised to a legible minimum size.',
      ),
      t(
        'Mobile-Fix: breite Tabellen (Quellen, Diagnose) sprengen den Bildschirm nicht mehr, sondern scrollen sauber horizontal.',
        'Mobile fix: wide tables (sources, diagnostics) no longer overflow the screen but scroll horizontally within their card.',
      ),
    ],
  },
  {
    version: '1.17.2',
    items: [
      t(
        'Wetter-Tab kompakter: Wind als kompakte Zeile (volle Breite, nur so hoch wie nötig) über dem Regenradar, das Regenradar darunter über die ganze Breite — keine ungenutzte Fläche mehr.',
        'More compact weather tab: wind as a compact full-width row (only as tall as needed) above the rain radar, with the rain radar full-width below — no more wasted space.',
      ),
      t(
        'Fix: Pflanzentyp auf den Bewässerungs-Zonenkarten wird lokalisiert angezeigt (Rasen, Hecke …) statt als roher englischer Wert.',
        'Fix: the plant type on the irrigation zone cards is shown localized (Lawn, Hedge …) instead of as a raw value.',
      ),
    ],
  },
  {
    version: '1.17.1',
    items: [
      t(
        'Einheitlicher Dark-Look: Bereiche mit hellen Stilresten aus einem früheren Design (Lern-Vorschläge, Geräte-Suche-Status, Szenen-/Schnellzugriff-Buttons, Sicherung importieren) nutzen jetzt durchgängig die dunkle Palette.',
        'Consistent dark look: areas that still had light leftovers from an earlier design (learning suggestions, device-discovery status, scene/quick-action buttons, backup import) now consistently use the dark palette.',
      ),
    ],
  },
  {
    version: '1.17.0',
    items: [
      t(
        'Mehrsprachigkeit: das komplette Dashboard gibt es jetzt auf Deutsch und Englisch. Die Sprache folgt automatisch dem Browser (Deutsch als Fallback).',
        'Multilingual: the entire dashboard is now available in German and English. The language follows the browser automatically (German as fallback).',
      ),
      t(
        'Sprachwahl pro Gerät unter Einstellungen → Darstellung & Sprache (AUTO / Deutsch / English). Zahlen folgen dem jeweiligen Sprachformat.',
        'Per-device language choice under Settings → Appearance & Language (AUTO / German / English). Numbers follow the respective locale format.',
      ),
      t(
        'Alle Tabs, Diagramme, Empfehlungen und Engine-Hinweise sind übersetzt. Telegram-Benachrichtigungen haben eine eigene, installationsweite Sprachwahl.',
        'All tabs, charts, recommendations and engine messages are translated. Telegram notifications have their own installation-wide language choice.',
      ),
      t(
        'Windrose vergrößert und überarbeitet (inkl. Bewölkungsanzeige); der Ambient-Hintergrund-Schalter ist von der Kopfzeile in die Einstellungen gewandert.',
        'Wind rose enlarged and reworked (incl. cloud cover); the ambient background toggle moved from the header into the settings.',
      ),
    ],
  },
  {
    version: '1.16.8',
    items: [
      t(
        'Update-Hinweis: prüft GitHub auf eine neuere Version; das Versions-Badge oben zeigt dann einen Punkt und führt per Klick auf die Updates-Seite mit GitHub-Link.',
        'Update notice: checks GitHub for a newer version; the version badge at the top then shows a dot and, when clicked, leads to the Updates page with a GitHub link.',
      ),
      t(
        'Neue Einstellungen-Kachel „Logs & Debug": Live-Connect-Protokoll, alle Diagnose-Endpunkte als Roh-JSON (Kopieren/Download) und Build-Infos.',
        'New settings tile "Logs & Debug": live Connect log, all diagnostic endpoints as raw JSON (copy/download) and build info.',
      ),
      t(
        'Hilfe ist jetzt ein kompakter Funktions-Überblick mit Kurzerklärungen und Suche statt eines langen Handbuchs.',
        'Help is now a compact feature overview with short explanations and search instead of a long manual.',
      ),
    ],
  },
  {
    version: '1.16.7',
    items: [
      t(
        'Fix: Neuladen/Direktaufruf eines Tabs (z. B. /forecast, /bewaesserung) zeigte einen 404-Fehler statt der App. Ein SPA-Fallback liefert jetzt index.html — Aktualisieren und Deep-Links funktionieren auf jedem Tab.',
        'Fix: reloading/directly opening a tab (e.g. /forecast, /bewaesserung) showed a 404 error instead of the app. An SPA fallback now serves index.html — refresh and deep links work on every tab.',
      ),
    ],
  },
  {
    version: '1.16.6',
    items: [
      t(
        'Diagramme: Dive-Deep ist jetzt interaktiv (Fadenkreuz + Werte-Tooltip beim Überfahren) und wird nicht mehr verzerrt — Kurven und Beschriftungen rendern pixelgenau statt gestreckt.',
        'Charts: dive-deep is now interactive (crosshair + value tooltip on hover) and is no longer distorted — curves and labels render pixel-perfect instead of stretched.',
      ),
      t(
        'Einheitliche Karten-Titel über alle Tabs: kein großer Leerraum mehr über der Überschrift, angemessene Schriftgrößen.',
        'Consistent card titles across all tabs: no more large gap above the heading, appropriate font sizes.',
      ),
      t(
        'Wetter-Tab: Wind-Kachel füllt die Höhe des Regenradars und zeigt zusätzlich die Bewölkung.',
        'Weather tab: the wind tile fills the height of the rain radar and additionally shows the cloud cover.',
      ),
    ],
  },
  {
    version: '1.16.5',
    items: [
      t(
        'Planer reagiert sofort: Änderungen (Verschieben, Dauer, An/Aus, Hinzufügen, Löschen) werden optimistisch direkt angezeigt, statt auf die nächste Server-Aktualisierung zu warten.',
        'Planner responds instantly: changes (move, duration, on/off, add, delete) are shown optimistically right away instead of waiting for the next server update.',
      ),
      t(
        'Dauer-Dropdown zeigt jetzt immer den korrekten Wert (auch krumme Auto-Dauern); Auto-Dauern werden auf 5-Minuten-Schritte gerundet.',
        'The duration dropdown now always shows the correct value (even odd auto-durations); auto-durations are rounded to 5-minute steps.',
      ),
    ],
  },
  {
    version: '1.16.4',
    items: [
      t(
        'Fix: Der Bewässerungsplan wurde ausgeführt, obwohl die automatische Bewässerung ausgeschaltet war. Geplante Einträge werden jetzt nur bei eingeschalteter Automatik dispatcht; die Vorschau bleibt sichtbar.',
        'Fix: the irrigation plan ran even though automatic irrigation was off. Scheduled entries are now only dispatched when automation is on; the preview stays visible.',
      ),
    ],
  },
  {
    version: '1.16.3',
    items: [
      t(
        'Wetter-Tab komplett überarbeitet: einheitliche Karten-Überschriften und sinnvolle Reihenfolge (Aktuelle Werte → 24-h-Vorhersage → Radar & Wind → Diagramme → Verlauf).',
        'Weather tab completely reworked: consistent card headings and a sensible order (current values → 24 h forecast → radar & wind → charts → history).',
      ),
      t(
        'Haus-bezogene Abschnitte (Innenraum-Prognose, Wirkung) stehen jetzt klar abgetrennt am Ende statt mitten im Wetter.',
        'House-related sections (indoor forecast, impact) are now clearly separated at the end instead of in the middle of the weather.',
      ),
    ],
  },
  {
    version: '1.16.2',
    items: [
      t(
        'Planer: geplante Bewässerungen dürfen sich nicht mehr überschneiden — nie mehr als ein Ventil gleichzeitig offen, jetzt auch im Plan erzwungen (Überschneidung beim Verschieben/Hinzufügen wird abgelehnt, Auto-Einträge weichen aus).',
        'Planner: scheduled waterings may no longer overlap — never more than one valve open at a time, now also enforced in the plan (an overlap when moving/adding is rejected, auto entries move aside).',
      ),
      t(
        'Tagesplan-Drag spürbar flüssiger (Track-Geometrie wird gecacht, weniger Re-Renders).',
        'Daily-plan drag noticeably smoother (track geometry is cached, fewer re-renders).',
      ),
      t(
        'Die blaue Linie in den Zonen-Karten ist jetzt beschriftet: Bodenwasser-Prognose (verfügbares Wasser, nächste ~3 Tage).',
        'The blue line in the zone cards is now labelled: soil-water forecast (available water, next ~3 days).',
      ),
    ],
  },
  {
    version: '1.16.1',
    items: [
      t(
        'Fix: Der Bewässerung-Tab ließ sich nicht mehr öffnen („Something went wrong. Fragment is not defined") — fehlender Fragment-Import behoben (betraf auch den Updates-Tab).',
        'Fix: the irrigation tab could no longer be opened ("Something went wrong. Fragment is not defined") — missing Fragment import fixed (also affected the Updates tab).',
      ),
    ],
  },
  {
    version: '1.16.0',
    items: [
      t(
        'Automatische Bewässerung lässt sich jetzt direkt im Bewässerung-Tab oben ein- und ausschalten.',
        'Automatic irrigation can now be turned on and off directly at the top of the irrigation tab.',
      ),
      t(
        'Beim manuellen „Bewässern" fragt das Plugin nach der Dauer – wählbar von 5 bis 60 Minuten in 5-Minuten-Schritten.',
        'When watering manually, the plugin asks for the duration – selectable from 5 to 60 minutes in 5-minute steps.',
      ),
      t(
        'Editierbarer Tagesplan: geplante Bewässerungen pro Eintrag per Drag verschieben (Zeit), Dauer ändern, an/aus schalten, löschen und neue hinzufügen. Die Engine führt die Einträge zur geplanten Zeit aus (immer nur ein Ventil gleichzeitig).',
        'Editable daily plan: move scheduled waterings per entry by drag (time), change the duration, toggle on/off, delete and add new ones. The engine runs the entries at the scheduled time (only one valve at a time).',
      ),
      t(
        'Boden-Kalibrierung pro Zone: der tatsächliche Bodenwasser-Stand lässt sich setzen, damit das Modell nach dem Anlegen nicht fälschlich „voll" annimmt.',
        'Soil calibration per zone: the actual soil-water level can be set so the model does not wrongly assume "full" after creation.',
      ),
      t(
        'Eigene Gardena-Sensor-Kachel (Bodenfeuchte, Bodentemperatur, Licht, Batterie); die Mäher-Kachel ist entfallen.',
        'Dedicated Gardena sensor tile (soil moisture, soil temperature, light, battery); the mower tile has been removed.',
      ),
      t(
        'Ventile lassen sich in den Einstellungen deaktivieren – deaktivierte Ventile verschwinden aus der Bewässern-Ansicht und werden nie automatisch gesteuert.',
        'Valves can be disabled in the settings – disabled valves disappear from the watering view and are never controlled automatically.',
      ),
      t(
        'Der Betriebsmodus (Eco/Normal/Hitze/Anwuchs) verschiebt jetzt auch den Auslöse-Zeitpunkt der Bewässerung, nicht nur die Wassermenge.',
        'The operating mode (Eco/Normal/Heat/Establishment) now also shifts the trigger time of irrigation, not just the water amount.',
      ),
      t(
        'Durchgängig deutsche, konsistente Begriffe in allen Tabs (u. a. Diagnose, Automatik, Einrichtungs-Assistent).',
        'Consistent terminology throughout all tabs (e.g. Diagnostics, Automation, Setup wizard).',
      ),
    ],
  },
  {
    version: '1.15.0',
    items: [
      t(
        'Bewässerung im Vollausbau: ET-basierte Wasserbilanz (FAO-56) pro Zone mit Open-Meteo-ET0 und Bodendaten – gegossen wird genau bedarfsgerecht bis Feldkapazität.',
        'Full-scale irrigation: ET-based water balance (FAO-56) per zone with Open-Meteo ET0 and soil data – watered exactly on demand up to field capacity.',
      ),
      t(
        'Lern-Algorithmus: kalibriert pro Zone Pflanzenkoeffizient (Kc) und Emitter-Abgabe aus der gemessenen Bodenfeuchte und erkennt defekte Emitter.',
        'Learning algorithm: calibrates the crop coefficient (Kc) and emitter output per zone from the measured soil moisture and detects faulty emitters.',
      ),
      t(
        'Forecast-Modell: projiziert die Bodenfeuchte über 72 h und zeigt die nächste Bewässerung (ETA) je Zone.',
        'Forecast model: projects the soil moisture over 72 h and shows the next watering (ETA) per zone.',
      ),
      t(
        'Zonen mit Pflanzen-/Boden-/Emitter-Profil, Gardena-Ventil und Bodenfeuchte-Sensor; Gates für Regen, Frost, Wind, Zeitfenster, Budgets, Cycle-and-Soak, Sequenzierung, PV-Vorzug, Mäher-Koordination und Pumpe.',
        'Zones with a plant/soil/emitter profile, a Gardena valve and a soil-moisture sensor; gates for rain, frost, wind, time windows, budgets, cycle-and-soak, sequencing, PV preference, mower coordination and pump.',
      ),
      t(
        'Live-Zonen-Kacheln (Feuchte-Gauge, Wasserbilanz, „Warum", Forecast) im Bewässerung-Tab; neue Zonen-Verwaltung unter Einstellungen → Bewässerung.',
        'Live zone tiles (moisture gauge, water balance, "why", forecast) in the irrigation tab; new zone management under Settings → Irrigation.',
      ),
      t(
        'Gardena-Bodenfeuchtesensor wird jetzt zuverlässig erkannt (Dienste werden nicht mehr nach Typ verworfen); Sensor-Erkennung über die Messwerte.',
        'Gardena soil-moisture sensor is now reliably detected (services are no longer discarded by type); sensor detection via the measured values.',
      ),
      t(
        'Es ist immer nur EIN Ventil gleichzeitig offen (gemeinsame Wasserversorgung) – fest erzwungen. Zeitfenster und „offen bis"-Zeit je Zone sichtbar. Ungenutzte Ventile lassen sich ausblenden. „Gardena verbinden" liegt unter Einstellungen → Bewässerung.',
        'Only ONE valve is ever open at a time (shared water supply) – hard-enforced. Time window and "open until" time visible per zone. Unused valves can be hidden. "Connect Gardena" is under Settings → Irrigation.',
      ),
    ],
  },
  {
    version: '1.14.0',
    items: [
      t(
        'Gardena ist jetzt direkt im Plugin integriert: Heat Shield verbindet sich mit deinem eigenen GARDENA-API-Zugang (Application Key + Secret) – kein separates Gardena-Plugin auf der HCU mehr nötig.',
        'Gardena is now integrated directly into the plugin: Heat Shield connects to your own GARDENA API access (Application Key + Secret) – no separate Gardena plugin on the HCU needed anymore.',
      ),
      t(
        'Liest Bodenfeuchte, Boden-/Umgebungstemperatur und Licht der Gardena-Sensoren und steuert Ventile (Bewässern/Stopp) direkt über die Gardena-Cloud, mit Live-Updates per WebSocket.',
        'Reads soil moisture, soil/ambient temperature and light from the Gardena sensors and controls valves (water/stop) directly via the Gardena cloud, with live updates over WebSocket.',
      ),
      t(
        'Einrichtung im Bewässerung-Tab unter „Gardena verbinden": Application Key/Secret, optionale Location-ID, Standard-Bewässerungsdauer und ein „Verbindung testen"-Button. Das Secret wird maskiert gespeichert.',
        'Setup in the irrigation tab under "Connect Gardena": Application Key/Secret, optional location ID, default watering duration and a "Test connection" button. The secret is stored masked.',
      ),
    ],
  },
  {
    version: '1.13.0',
    items: [
      t(
        'Benachrichtigungen (Telegram-Setup, Morgen-Briefing, Ereignisse, Abend-Rückblick, Wetter-Updates) sind eine eigene Kachel unter Einstellungen.',
        'Notifications (Telegram setup, morning briefing, events, evening summary, weather updates) are their own tile under Settings.',
      ),
      t(
        'Wetter-Tab: kompaktere Windrose mit einem „Wind-Ausblick" (max. Böen heute/morgen, Hauptwindrichtung) direkt darunter.',
        'Weather tab: a more compact wind rose with a "wind outlook" (max gusts today/tomorrow, main wind direction) right below it.',
      ),
      t(
        'Neuer Diagramm-Bereich „Wettervorhersage · Diagramme": Temperatur & gefühlt, Niederschlag, Regenwahrscheinlichkeit, Bewölkung, Wind & Böen, Globalstrahlung, UV-Index, Luftdruck, Luftfeuchte (24 h/48 h umschaltbar) plus 7-Tage-Temperatur — jedes Diagramm zum Vergrößern.',
        'New chart area "Weather forecast · Charts": temperature & feels-like, precipitation, rain probability, cloud cover, wind & gusts, global radiation, UV index, air pressure, humidity (switchable 24 h/48 h) plus 7-day temperature — every chart can be enlarged.',
      ),
      t(
        '„Forecast – Nächste 24 Stunden" heißt jetzt „Wettervorhersage – Nächste 24 Stunden".',
        '"Forecast – Next 24 hours" is now called "Weather forecast – Next 24 hours".',
      ),
    ],
  },
  {
    version: '1.12.0',
    items: [
      t(
        'Wetter-Tab: „Aktuelle Werte" stehen jetzt über dem Regenradar.',
        'Weather tab: "Current values" are now shown above the rain radar.',
      ),
      t(
        'Regenradar mit dunkler Karte (CARTO „dark") passend zum UI; Regen wird mit kräftigem Farbschema deutlich sichtbar dargestellt, dazu ein zuschaltbarer Wolken-Layer (Button „Wolken").',
        'Rain radar with a dark map (CARTO "dark") matching the UI; rain is shown clearly with a strong colour scheme, plus a toggleable cloud layer (button "Clouds").',
      ),
      t(
        'Bewässerung: volle Gardena-Anbindung — Bodenfeuchte, Bodentemperatur und Lichtintensität je Sensor werden live angezeigt, Ventile lassen sich direkt ein-/ausschalten (Bewässern/Stopp).',
        'Irrigation: full Gardena integration — soil moisture, soil temperature and light intensity per sensor are shown live, valves can be switched on/off directly (water/stop).',
      ),
      t(
        'Vorbereitung für die automatische Bewässerungsplanung anhand von Niederschlag, Bodenfeuchte, Sonne und Temperatur.',
        'Groundwork for automatic irrigation planning based on precipitation, soil moisture, sun and temperature.',
      ),
    ],
  },
  {
    version: '1.11.0',
    items: [
      t(
        'Windgeschwindigkeit wird jetzt systemweit in km/h angezeigt (Windrose, KPIs, Automatik, Sturm-Schwelle).',
        'Wind speed is now shown system-wide in km/h (wind rose, KPIs, automation, storm threshold).',
      ),
      t(
        'Wetter-Tab: „Forecast – Nächste 24 Stunden" steht jetzt über dem Regenradar; neue Karte „Aktuelle Werte" mit UV-Index, Niederschlag (jetzt/heute), Luftdruck, Luftfeuchte sowie Sonnenauf-/-untergang.',
        'Weather tab: "Forecast – Next 24 hours" is now above the rain radar; new "Current values" card with UV index, precipitation (now/today), air pressure, humidity and sunrise/sunset.',
      ),
      t(
        'DWD-Unwetterwarnungen werden nur noch angezeigt, wenn es tatsächlich Warnungen gibt.',
        'DWD severe-weather warnings are only shown when there actually are warnings.',
      ),
      t(
        'Neuer Tab „Bewässerung" (links von „Wetter") mit Fokus auf Regen, Niederschlagsmenge und Gewitter — KPIs und Diagramme (24 h + 7 Tage). Gardena-Anbindung ist vorbereitet (geplant).',
        'New "Irrigation" tab (left of "Weather") focusing on rain, rainfall amount and thunderstorms — KPIs and charts (24 h + 7 days). Gardena integration is prepared (planned).',
      ),
    ],
  },
  {
    version: '1.10.0',
    items: [
      t(
        'Neuer „Wetter"-Tab (vormals „Forecast"): animiertes Regenradar (Leaflet + RainViewer), Windrose mit Windrichtung und Böen (Open-Meteo) und amtliche DWD-Unwetterwarnungen für deinen Standort.',
        'New "Weather" tab (formerly "Forecast"): animated rain radar (Leaflet + RainViewer), wind rose with wind direction and gusts (Open-Meteo) and official DWD severe-weather warnings for your location.',
      ),
      t(
        'Regenradar mit Play/Pause und Zeit-Slider; Windrose zeigt Richtung, m/s und Beaufort; DWD-Warnungen farbcodiert nach Warnstufe (1–4).',
        'Rain radar with play/pause and a time slider; the wind rose shows direction, m/s and Beaufort; DWD warnings colour-coded by warning level (1–4).',
      ),
      t(
        'Standort/Region für DWD-Warnungen in der Config einstellbar (Region-Name oder Warncell-ID); Standard „Beispielstadt".',
        'Location/region for DWD warnings configurable in the config (region name or warn-cell ID); default "Beispielstadt".',
      ),
    ],
  },
  {
    version: '1.9.1',
    items: [
      t(
        'Fix: Das Schloss-Symbol über dem Twin wurde kaum/nicht angezeigt. Das Icon nutzt jetzt eine explizit weiße Stroke-Farbe, etwas mehr Größe und einen feinen Schatten.',
        'Fix: the lock icon above the twin was barely/not shown. The icon now uses an explicitly white stroke colour, a slightly larger size and a subtle shadow.',
      ),
    ],
  },
  {
    version: '1.9.0',
    items: [
      t(
        'Vollständiges Hilfe-Handbuch: nach Kategorien gruppiert, mit Volltextsuche, allen Betriebsmodi inkl. Schwellwerten, kompletter Einstellwert-Referenz, Glossar und FAQ/Fehlerbehebung.',
        'Complete help manual: grouped by category, with full-text search, all operating modes incl. thresholds, a complete settings reference, glossary and FAQ/troubleshooting.',
      ),
      t(
        'Weitere eigene SVG-Icons: echtes Zahnrad für „Einstellungen" und ein Schloss-Symbol (auf/zu) über dem Twin statt Emoji.',
        'More custom SVG icons: a real cog for "Settings" and a lock icon (open/closed) above the twin instead of emoji.',
      ),
    ],
  },
  {
    version: '1.8.9',
    items: [
      t(
        'Test: eigene weiße Linien-SVG-Icons (transparenter Hintergrund) statt Emoji in den KPI-Kacheln — PV (⚡), Innen, Außen, Sonne und Hitze-Index.',
        'Test: custom white line SVG icons (transparent background) instead of emoji in the KPI tiles — PV (⚡), indoor, outdoor, sun and heat index.',
      ),
    ],
  },
  {
    version: '1.8.8',
    items: [
      t(
        'Sommer-Beobachtung wird früher aktiv: Schwellen auf Prognose ≥ 20 °C (statt 24) und Außen ≥ 18 °C (statt 22) gesenkt; PV unverändert > 2,0 kW. Bestehende Konfigurationen werden beim Laden automatisch aktualisiert.',
        'Summer watch becomes active earlier: thresholds lowered to forecast ≥ 20 °C (instead of 24) and outdoor ≥ 18 °C (instead of 22); PV unchanged at > 2.0 kW. Existing configurations are updated automatically on load.',
      ),
      t(
        'Automatik-Logik: doppelte Anzeige der Begründung entfernt — „Ausschlaggebend" steht jetzt nur einmal; die vollständige Herleitung bleibt hinter dem ⓘ.',
        'Automation logic: duplicate display of the reasoning removed — "decisive" now appears only once; the full derivation stays behind the ⓘ.',
      ),
      t(
        '„Nächste Aktionen"-Zeilen nutzen jetzt die transparente Glas-Optik statt eines opaken Balkens.',
        'The "Next actions" rows now use the transparent glass look instead of an opaque bar.',
      ),
    ],
  },
  {
    version: '1.8.7',
    items: [
      t(
        'Einheitliches UI: alle Kacheln und Karten teilen jetzt EINE Glas-Oberfläche — gleicher Hintergrund, Rahmen, Eck-Radius (14 px) und Schatten über alle Tabs.',
        'Unified UI: all tiles and cards now share ONE glass surface — same background, border, corner radius (14 px) and shadow across all tabs.',
      ),
      t(
        'Keine unterschiedlichen Ecken/Rahmen mehr (Fenster-, Raum-, KPI-, Analyse-, Forecast- und Automatik-Karten sind jetzt deckungsgleich).',
        'No more differing corners/borders (window, room, KPI, analysis, forecast and automation cards are now identical).',
      ),
    ],
  },
  {
    version: '1.8.6',
    items: [
      t(
        'Modernes 3D-Glass-UI über alle Tabs: top-belichteter Glas-Schliff, mehrlagige Tiefen-Schatten und ein sanftes Anheben interaktiver Karten beim Überfahren.',
        'Modern 3D glass UI across all tabs: top-lit glass bevel, multi-layer depth shadows and a gentle lift of interactive cards on hover.',
      ),
      t(
        'Glas-Icon-Buttons mit Hover-/Druck-Effekt; aktiver Tab mit Verlauf und Glow; Forecast-, Automatik- und Detail-Panels einheitlich aufpoliert.',
        'Glass icon buttons with hover/press effect; active tab with gradient and glow; forecast, automation and detail panels uniformly polished.',
      ),
      t(
        'Respektiert „Reduced Motion" (keine Bewegungseffekte, wenn vom System gewünscht).',
        'Respects "Reduced Motion" (no motion effects when requested by the system).',
      ),
    ],
  },
  {
    version: '1.8.5',
    items: [
      t(
        'Planner respektiert die Stauschutz-Grenze jetzt auch in der Vorschau: „Nächste Aktionen", Twin-Prognose und Heatmap zeigen für Fassaden max. 95 % (Dachfenster 100 %) statt fälschlich 100 %.',
        'The planner now respects the heat-trap limit in the preview too: "Next actions", twin forecast and heatmap show max. 95 % for facades (roof windows 100 %) instead of wrongly 100 %.',
      ),
      t(
        'Haus-Twin lässt sich per Knopf (↺) auf Standard zurücksetzen — Anordnung, Sperre, Wärme-Ansicht und Legende.',
        'The house twin can be reset to default with a button (↺) — layout, lock, heat view and legend.',
      ),
      t(
        'Forecast-Panel „Nächste Stunden" mit großer, deutlicher Umrandung; die Kacheln darin sind transparent (Glas).',
        'Forecast panel "Next hours" with a large, clear border; the tiles inside are transparent (glass).',
      ),
    ],
  },
  {
    version: '1.8.4',
    items: [
      t(
        'Raum-Popup im Twin wird nicht mehr von der Kachel abgeschnitten — es rendert frei über dem Dashboard (Portal) und bleibt immer vollständig sichtbar.',
        'The room popup in the twin is no longer clipped by the tile — it renders freely above the dashboard (portal) and always stays fully visible.',
      ),
      t(
        'Popup positioniert sich automatisch ober-/unterhalb des Badges, klemmt sich in den sichtbaren Bereich und scrollt bei Bedarf.',
        'The popup positions itself automatically above/below the badge, clamps into the visible area and scrolls when needed.',
      ),
    ],
  },
  {
    version: '1.8.3',
    items: [
      t(
        'Twin-Rollo-Prognose an die echten Planner-Ziele gekoppelt (Stufenfunktion, gedeckelt auf 95/100 %).',
        'Twin shutter forecast coupled to the real planner targets (step function, capped at 95/100 %).',
      ),
      t(
        'Fix: Vorschau zeigte fälschlich „0 % in 2–3 h" bei geschlossenen Rollläden (Rückkopplungsfalle der Wärmelast-Vorschau).',
        'Fix: the preview wrongly showed "0 % in 2–3 h" for closed shutters (feedback trap in the heat-load preview).',
      ),
    ],
  },
  {
    version: '1.8.2',
    items: [
      t(
        'Forecast-Leiste mit Glas-Panel; Hintergrund weicher (grober Noise entfernt).',
        'Forecast bar with a glass panel; softer background (coarse noise removed).',
      ),
      t(
        'Rollo-Prognose im Twin nutzt die feine 8-Stufen-Leiter wie die Engine.',
        'The shutter forecast in the twin uses the fine 8-step ladder like the engine.',
      ),
    ],
  },
  {
    version: '1.8.1',
    items: [
      t(
        'Fix: Deep-Dive-Diagramme öffnen wieder korrekt zentriert/fast im Vollbild (Portal-Rendering der Overlays).',
        'Fix: deep-dive charts open correctly centred/almost full-screen again (portal rendering of the overlays).',
      ),
    ],
  },
  {
    version: '1.8.0',
    items: [
      t(
        'Regelung: konservatives Verhalten bei fehlenden Sensorwerten (Gewichte werden auf vorhandene Faktoren renormiert statt nach „nicht beschatten" zu kippen).',
        'Control: conservative behaviour when sensor values are missing (weights are renormalized to the available factors instead of defaulting to "no shading").',
      ),
      t('Regelung: feinere 8-stufige Risiko→Rollo-Leiter.', 'Control: finer 8-step risk→shutter ladder.'),
      t(
        'Regelung: PV-Faktor weich um die echte Anlagen-Ausrichtung statt harter 90–200°-Lobe.',
        'Control: PV factor smooth around the real system orientation instead of a hard 90–200° lobe.',
      ),
      t(
        'Regelung: richtungsabhängige Hysterese — schließt schneller zum Schutz, öffnet träger (Schließ-Eile-Faktor).',
        'Control: direction-dependent hysteresis — closes faster for protection, opens more slowly (closing-urgency factor).',
      ),
      t('Regelung: Modus-Schwellen (°C/kW) jetzt konfigurierbar.', 'Control: mode thresholds (°C/kW) are now configurable.'),
      t(
        'Klima: aktive Vorkühl-Empfehlung bei PV-Überschuss + Hitzeprognose.',
        'Climate: active pre-cooling recommendation on PV surplus + heat forecast.',
      ),
      t(
        'UI: helleres Standard-Theme mit stärkerem Farbverlauf und Noise; Ambient ist jetzt standardmäßig AUS.',
        'UI: brighter default theme with a stronger gradient and noise; ambient is now OFF by default.',
      ),
      t(
        'UI: Deep-Dive-Diagramme öffnen fast im Vollbild; Version steht im Kopf.',
        'UI: deep-dive charts open almost full-screen; the version is shown in the header.',
      ),
      t(
        'UI: Automatik-Tab mit vollständiger technischer Live-Berechnung; Beschattungs-Erklärung nur noch über das ⓘ.',
        'UI: automation tab with a full technical live calculation; the shading explanation only via the ⓘ now.',
      ),
      t(
        'UI: Einstellungen mit „Updates" und ausführlicher „Hilfe"; Forecast-Tab ohne „Nächste Aktionen".',
        'UI: settings with "Updates" and a detailed "Help"; forecast tab without "Next actions".',
      ),
      t('Einstellungen: Zyklusintervall bis 60 min, Mindestpause bis 6 h.', 'Settings: cycle interval up to 60 min, cooldown up to 6 h.'),
    ],
  },
  {
    version: '1.7.0',
    items: [t('Deep-Dive-Verläufe im Lüftung- und Klima-Tab.', 'Deep-dive history in the ventilation and climate tab.')],
  },
  {
    version: '1.6.0',
    items: [
      t(
        'Ausführliche Automatik-Erklärung, Versionsanzeige, scrollbarer 24-h-Forecast, KPI-Deep-Dive, Glas-/Glow-/3D-Feinschliff.',
        'Detailed automation explanation, version display, scrollable 24 h forecast, KPI deep-dive, glass/glow/3D polish.',
      ),
    ],
  },
  {
    version: '1.5.0',
    items: [t('Ruhezeiten & Zeitpläne, Voll-Backup/Restore, Pro-Raum-Detailansicht, Onboarding.', 'Quiet hours & schedules, full backup/restore, per-room detail view, onboarding.')],
  },
  {
    version: '1.4.0',
    items: [t('24-h-Forecast, kombinierte Verlaufs-/Prognose-Diagramme, Deep-Dive, dunkleres Glas.', '24 h forecast, combined history/forecast charts, deep-dive, darker glass.')],
  },
  {
    version: '1.3.0',
    items: [t('Wirkungs-Dashboard, konfidenz-bewusste Steuerung, Unwetterwarnungen, manuelle Übersteuerung, mobiler Twin als Tabelle.', 'Impact dashboard, confidence-aware control, severe-weather warnings, manual override, mobile twin as a table.')],
  },
  {
    version: '1.2.0',
    items: [t('Ganzheitlicher Glas-/Ambient-UI-Rework.', 'Holistic glass/ambient UI rework.')],
  },
  {
    version: '1.1.0',
    items: [t('Thermische Selbst-Kalibrierung, Forecast- & Automation-Tab neu.', 'Thermal self-calibration, new forecast & automation tab.')],
  },
  {
    version: '1.0.0',
    items: [t('Erste stabile Version: vorausschauende Beschattung, Haus-Twin, Lernmodul.', 'First stable version: predictive shading, house twin, learning module.')],
  },
  ];
}

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
        <h1>{t('Updates', 'Updates')}</h1>
        <span class="module-panel__badge">v{APP_VERSION}</span>
      </header>
      <p class="module-panel__intro">
        {t('Aktuelle Version', 'Current version')} <strong>v{APP_VERSION}</strong>
        {build !== null ? <Fragment> · {t('Build', 'Build')} <code>{build}</code></Fragment> : null}.{' '}
        {t(
          'Neue Builds lädst du in HCUweb hoch; diese Version-Nummer und die Build-Kennung helfen beim Abgleich.',
          'You upload new builds in HCUweb; this version number and the build identifier help with matching.',
        )}
      </p>

      {upd.value.updateAvailable ? (
        <article class="module-panel__card updates-banner updates-banner--new" data-testid="updates-available">
          <h3>{t(`Update verfügbar: v${upd.value.latest}`, `Update available: v${upd.value.latest}`)}</h3>
          <p class="module-panel__hint">
            {t(
              `Auf GitHub ist eine neuere Version als deine installierte (v${APP_VERSION}). Lade das .tar.gz aus dem Release und installiere es in HCUweb.`,
              `A newer version than your installed one (v${APP_VERSION}) is available on GitHub. Download the .tar.gz from the release and install it in HCUweb.`,
            )}
          </p>
          <a class="irr-btn" href={upd.value.url} target="_blank" rel="noopener noreferrer">
            {t(`Release v${upd.value.latest} öffnen`, `Open release v${upd.value.latest}`)}
          </a>
        </article>
      ) : (
        <article class="module-panel__card updates-banner" data-testid="updates-current">
          <h3>{upd.value.checked ? t('Du nutzt die neueste Version.', 'You are using the latest version.') : t('Prüfe auf Updates…', 'Checking for updates…')}</h3>
          <p class="module-panel__hint">
            {t('Quelle & Releases auf GitHub:', 'Source & releases on GitHub:')}{' '}
            <a href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              {GITHUB_URL}
            </a>
          </p>
        </article>
      )}

      <ol class="updates-list">
        {getChangelog().map((e) => (
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
