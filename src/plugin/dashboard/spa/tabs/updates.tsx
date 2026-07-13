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
import { OtaPanel } from '../components/OtaPanel.js';
import { t } from '../i18n.js';

export interface ChangelogEntry {
  version: string;
  items: string[];
}

export function getChangelog(): ChangelogEntry[] {
  return [
  {
    version: '2.0.25',
    items: [
      t(
        'OTA-Installation repariert: ein neu geladenes OTA-Update wurde bisher beim Neustart fälschlich als beschädigt eingestuft und automatisch zurückgerollt (der Bootstrap-Loader prüfte den Bundle-Gesamt-Hash gegen die entpackte main.js). Der Loader verifiziert jetzt exakt die entpackte main.js. Dieser Fix steckt im Image — er greift erst nach einmaliger Installation dieses .tar.gz über HCUweb; danach funktionieren OTA-Updates.',
        'OTA install fixed: a freshly downloaded OTA update was wrongly flagged as corrupt on restart and rolled back automatically (the bootstrap loader compared the whole-bundle hash to the extracted main.js). The loader now verifies exactly the extracted main.js. This fix lives in the image — it takes effect after installing this .tar.gz once via HCUweb; OTA updates work from then on.',
      ),
    ],
  },
  {
    version: '2.0.24',
    items: [
      t(
        'OTA-taugliche Updates: ab dieser Version können Aktualisierungen over-the-air bereitgestellt werden.',
        'OTA-capable updates: from this version on, updates can be delivered over the air.',
      ),
    ],
  },
  {
    version: '2.0.23',
    items: [
      t(
        'OTA-Updates werden jetzt standardmäßig automatisch installiert: verifizierte, zum Kern passende Payloads werden ohne Nachfrage geladen, aktiviert und per Neustart übernommen. Im Tab „Updates" jederzeit auf „Manuell" umstellbar. Schutznetze unverändert (nur verifizierte Bundles, Crash-Loop-Rollback aufs Image).',
        'OTA updates now install automatically by default: verified, core-compatible payloads are downloaded, activated and applied via restart without asking. Switchable to "Manual" anytime in the Updates tab. Safety nets unchanged (only verified bundles, crash-loop rollback to the image).',
      ),
    ],
  },
  {
    version: '2.0.22',
    items: [
      t(
        'OTA-Updates: Oberfläche und reines-JS-Backend können jetzt over-the-air aus GitHub Releases installiert werden (Tab „Updates", automatisch oder manuell), wenn das Dashboard Internet hat — Kern-Updates (Image/native Abhängigkeiten) laufen weiterhin per .tar.gz über HCUweb.',
        'OTA updates: the UI and pure-JS backend can now be installed over the air from GitHub Releases (Updates tab, automatic or manual) when the dashboard has internet — core updates (image/native deps) still go via the .tar.gz in HCUweb.',
      ),
      t(
        'Es werden zwei Versionen angezeigt: Kern (Image) und OTA (Payload). Nur verifizierte Bundles (sha256, Mindest-Kernversion) werden aktiviert; bei Problemen fällt das Plugin automatisch auf das Image zurück (Crash-Loop-Schutz).',
        'Two versions are shown: Core (image) and OTA (payload). Only verified bundles (sha256, minimum core version) are activated; on trouble the plugin automatically rolls back to the image (crash-loop protection).',
      ),
    ],
  },
  {
    version: '2.0.21',
    items: [
      t(
        'Trend-basierter Hitze-Schutz: an heißen, sonnigen Tagen schließt ein Fenster jetzt auch dann früher/stärker, wenn die direkte Sonne noch nicht bündig auf der Fassade steht — aber nur, wenn die Prognosekurve dadurch den erwarteten Innen-Peak spürbar senkt (sonst bleibt es beim tageslicht-freundlichen Verhalten).',
        'Trend-based heat protection: on hot, sunny days a window now closes earlier/harder even before the direct sun is square on the facade — but only when the forecast curve shows it meaningfully lowers the expected indoor peak (otherwise the daylight-friendly behaviour stays).',
      ),
      t(
        'Bewegungen liegen nicht mehr zwangsweise auf der vollen Stunde: der Zeitpunkt jeder Fahrt wird auf den echten Umschaltpunkt verfeinert, den die Modelle liefern (auf 5 Minuten gerundet). Das Bewegungsbudget (2–4 Fahrten/Tag) bleibt gleich.',
        'Moves are no longer forced onto the full hour: each move time is refined to the real switch point the models indicate (rounded to 5 minutes). The movement budget (2–4 moves/day) stays the same.',
      ),
    ],
  },
  {
    version: '2.0.20',
    items: [
      t(
        'Mobile-Navigationsleiste jetzt auch in der neuen Oberfläche (v2): die Apple-Style-Leiste unten mit „Mehr"-Menü und Basis/Experte-Umschalter — im v2-Glas-/Amber-Theme. Aktivierung unter Darstellung → „Mobile Touch-Navigation".',
        'Mobile navigation bar now in the new UI (v2) too: the Apple-style bottom bar with a "More" menu and Basic/Expert switch — themed for v2 glass/amber. Enable under Appearance → "Mobile touch navigation".',
      ),
      t(
        'Weniger Telegram-Spam: „Manuelle Bedienung erkannt" wird pro manueller Verstellung nur noch einmal gemeldet (nicht mehr bei jeder erneuten Statusmeldung des Rollladens); das Halten der Position wird still verlängert.',
        'Less Telegram spam: "Manual operation detected" is now sent once per manual change (no longer on every repeated shutter status broadcast); holding the position is refreshed silently.',
      ),
      t(
        'Hitzetag-Schutz ist jetzt mehrstufig und frei konfigurierbar: z. B. ab 30 °C → 30 % Beschattung, ab 35 °C → 50 %. Es gilt die höchste erreichte Stufe (nur bei Sonne/PV; Sturm & Nachtauskühlung ausgenommen). Regeln → Hitzetag-Schutz.',
        'Hot-day protection is now multi-stage and freely configurable: e.g. from 30 °C → 30 % shading, from 35 °C → 50 %. The highest reached stage wins (only with sun/PV; storm & night cooling exempt). Rules → Hot-day protection.',
      ),
    ],
  },
  {
    version: '2.0.18',
    items: [
      t(
        'PV-Boost: Fenster in Anlagen-Richtung (z. B. SW) werden bei sehr hoher PV-Leistung stärker geschlossen (bis voll) und bleiben zu, solange die Anlage viel liefert — die PV-Anlage schaut ja selbst in diese Richtung. Anlagen-Ausrichtung und die PV-Schwelle „sehr hoch" sind konfigurierbar (Regeln → Beschattungs-Strategie); nie über den jeweiligen Fenster-Deckel hinaus, Sturm behält Vorrang.',
        'PV boost: windows facing the PV array (e.g. SW) close harder (up to fully) at very high PV output and stay closed while the array keeps delivering — the array itself faces that way. The array azimuth and the "very high" PV threshold are configurable (Rules → Shading strategy); never beyond each window\u2019s cap, storm keeps priority.',
      ),
    ],
  },
  {
    version: '2.0.17',
    items: [
      t(
        'Bugfix „das Rollo geht direkt auf 95 %": die Verschattung fährt jetzt graduell hoch (z. B. 30 → 50 → 75 %) und folgt der tatsächlichen direkten Sonne auf dem jeweiligen Fenster — voll geschlossen erst nahe dem Sonnen-Peak. Ein sonniges Fenster bleibt bei kühlem Raum für Tageslicht offen.',
        'Fix for "the shutter jumps straight to 95 %": shading now ramps up gradually (e.g. 30 → 50 → 75 %) following the actual direct sun on each window — fully closed only near the window\u2019s solar peak. A sunny window stays open for daylight while the room is cool.',
      ),
    ],
  },
  {
    version: '2.0.16',
    items: [
      t(
        'Prognoseverlauf: die Rollläden-Zeile reicht wieder über den ganzen Tag (keine leeren Werte ab 08:00 mehr). Neue Zeile „Sonne auf Fassade" zeigt die Himmelsrichtung der Sonne im Tagesverlauf (NO → O → SO → S → SW → W).',
        'Forecast timeline: the shutter row spans the whole day again (no more empty values from 08:00). New "Sun on facade" row shows the sun\u2019s direction over the day (NE → E → SE → S → SW → W).',
      ),
      t(
        'Geplante Bewegungen und die Diagramm-Skala liegen jetzt auf vollen Stunden (kein „08:20" mehr). Das Tagesplan-Diagramm ist interaktiv: Fadenkreuz beim Überfahren, anklickbare Punkte, Tooltips. Doppelte Einträge werden zusammengefasst.',
        'Planned moves and the chart scale are now on full hours (no more "08:20"). The day-plan chart is interactive: hover crosshair, clickable points, tooltips. Duplicate entries are merged.',
      ),
      t(
        'Rollläden können einen eigenen Namen tragen (statt nur „Fenster SW"). Ein Fenster wird nicht mehr geöffnet, solange direkte Sonne darauf liegt (behebt zu frühes Öffnen). Passenderes Symbol bei „Alle Aktionen anzeigen".',
        'Shutters can carry their own name (instead of just "Window SW"). A window is no longer opened while direct sun is still on it (fixes opening too early). More fitting icon on "Show all actions".',
      ),
    ],
  },
  {
    version: '2.0.15',
    items: [
      t(
        'Neue Beschattungs-Strategie als ein Regler (Regeln → Beschattungs-Strategie): Tageslicht / Ausgewogen / Wärmeschutz. Dazu ein Abend-Öffnen-Gate — Fenster öffnen abends erst, wenn keine direkte Sonne mehr auf dem Fenster liegt (behebt „NW öffnet zu früh"). Pro Raum und Fenster überschreibbar.',
        'New shading strategy as a single dial (Rules → Shading strategy): Daylight / Balanced / Heat protection. Plus an evening-open gate — windows only open in the evening once no direct sun is left on them (fixes "NW opens too early"). Overridable per room and window.',
      ),
      t(
        'Alle bisher fest verdrahteten Engine-Konstanten sind jetzt einstellbar (Verschattungs-Schwellen, Off-Sun-Caps, „Solar stark"-Schwelle, Segment/Vorausblick, Thermomodell); im Profil „Benutzerdefiniert" sind die Risikogewichte frei editierbar. Standardwerte unverändert.',
        'Every previously hard-coded engine constant is now configurable (shading thresholds, off-sun caps, "strong solar" threshold, segment/look-ahead, thermal model); in the "Custom" profile the risk weights are freely editable. Defaults unchanged.',
      ),
      t(
        'Seite „Regeln & Grenzwerte" aufgeräumt: Karten haben jetzt Innenabstand (nichts wird mehr am Rand abgeschnitten), die Schwellwerte sind in Gruppen sortiert.',
        'The "Rules & thresholds" page is tidied up: cards now have inner padding (nothing is clipped at the edge), and the thresholds are sorted into groups.',
      ),
    ],
  },
  {
    version: '2.0.14',
    items: [
      t(
        'Großer Engine-Overhaul der Verschattung: direktsonnen-bewusst — ein Fenster wird nur so stark verschattet, wie wirklich direkte Sonne darauf steht. Nebenfassaden ohne direkten Sonneneinfall (z. B. NW nachmittags) werden nur mild beschattet (bis 30 %, bei starker Solarlast bis 70 %) statt fälschlich auf 95 % — und nie voll geschlossen.',
        'Big shading engine overhaul: direct-sun aware — a window is only shaded as much as direct sun actually hits it. Off-sun facades (e.g. NW in the afternoon) are only mildly shaded (up to 30 %, up to 70 % under strong solar load) instead of wrongly 95 % — and never fully closed.',
      ),
      t(
        'Dachfenster (stärkster Wärmeeintrag) bleiben an Hitzetagen ganztags geschlossen und öffnen erst, wenn Sonne und PV klar nachlassen. Der 24-Stunden-Plan zeigt jetzt genau das tatsächliche Verhalten schon vorab.',
        'Roof windows (strongest heat entry) stay closed all day on hot days and open only once sun and PV clearly decline. The 24-hour plan now shows exactly the real behaviour in advance.',
      ),
      t(
        'Bewegungs-Deckel: höchstens 2–4 Fahrten pro Rollladen und Tag. Reagiert auf Forecast-Abweichung: läuft der Raum wärmer als vorhergesagt, wird früher verschattet. Sanftes Beschatten ist jetzt ein harter Teil-Deckel.',
        'Movement cap: at most 2–4 moves per shutter per day. Reacts to forecast deviation: if a room runs warmer than predicted it shades earlier. Gentle shading is now a hard partial cap.',
      ),
    ],
  },
  {
    version: '2.0.13',
    items: [
      t(
        'Neue Mobil-Navigation im Apple-Stil: eine schwebende Liquid-Glass-Leiste unten (Blur + Transparenz) mit vier Haupt-Tabs und einem animierten Aktiv-Indikator.',
        'New Apple-style mobile navigation: a floating Liquid-Glass bar at the bottom (blur + transparency) with four primary tabs and an animated active indicator.',
      ),
      t(
        'Das „Mehr"-Menü öffnet ein Glas-Sheet mit Kachel-Grid (Automatik, Einstellungen, Nachrichten mit Ungelesen-Badge, Hilfe, Darstellung, Updates) und einem Basis/Experte-Umschalter. Große Touch-Ziele, Safe-Area und reduzierte Bewegung werden beachtet. Aktivierbar unter Darstellung → „Mobile Touch-Navigation".',
        'The "More" menu opens a glass sheet with a tile grid (Automation, Settings, Messages with unread badge, Help, Appearance, Updates) and a Basic/Expert toggle. Large touch targets, safe-area insets and reduced motion are respected. Enable it under Appearance → "Mobile touch navigation".',
      ),
    ],
  },
  {
    version: '2.0.12',
    items: [
      t(
        'Rollläden hingen fälschlich auf 95 %, obwohl keine Sonne am Fenster lag. Die Vorschau öffnet jetzt für Tageslicht, wenn Beschatten dem Fenster keinen Kühl-Nutzen bringt (ein geschlossener Rollo kühlt einen warmen Raum ohne Sonne nicht) – und schließt automatisch, sobald wieder Sonnenlast auftritt.',
        'Shutters were wrongly stuck at 95 % although no sun was on the window. The preview now opens for daylight when shading brings no cooling benefit at that window (a closed shutter cannot cool a warm room without sun) — and closes again automatically once solar load returns.',
      ),
      t(
        'Der Tagesplan zeigt jetzt einen echten, zeitlich gestaffelten 24-Stunden-Fahrplan (wann welcher Rollladen schließt und wieder öffnet) statt nur einer Aktion „jetzt".',
        'The day-ahead plan now shows a real, time-phased 24-hour schedule (when each shutter closes and re-opens) instead of only a single "now" action.',
      ),
      t(
        'Die Rollläden-Zeile im Prognoseverlauf reicht jetzt über den ganzen Planungshorizont statt nach 12 Stunden mit „–" abzubrechen. Tagesplan-Karte: Inhalt wird oben links nicht mehr abgeschnitten.',
        'The shutter row in the forecast timeline now spans the full planning horizon instead of cutting off with "–" after 12 hours. Day-plan card: content is no longer clipped at the top-left.',
      ),
    ],
  },
  {
    version: '2.0.11',
    items: [
      t(
        'Tagesplan (24-Stunden-Plan) im Vorhersage-Tab lädt wieder: der Fehler „O.find is not a function" ist behoben (die Antwort von /api/forecast wird jetzt korrekt als Objekt mit forecasts-Liste gelesen).',
        'The day-ahead (24h) plan in the Forecast tab loads again: the "O.find is not a function" error is fixed (the /api/forecast response is now correctly read as an object with a forecasts list).',
      ),
    ],
  },
  {
    version: '2.0.10',
    items: [
      t(
        'Alle zuletzt noch im klassischen Design verbliebenen Seiten (System, Räume, Quellen, Diagnose, Benachrichtigungen, Bewässerung-Einstellungen, Nachrichten, Updates, Hilfe, Logs & Debug, Gebäude-Studio) sind jetzt durchgängig in der neuen Liquid-Glass-Optik gestaltet: einheitliche Glas-Karten, Akzentfarben, Tabellen, Typografie, Formulare und Buttons — ohne Funktionsverlust.',
        'Every page that was still in the classic design (System, Rooms, Sources, Diagnostics, Notifications, Irrigation settings, Messages, Updates, Help, Logs & Debug, Building studio) is now consistently styled in the new Liquid Glass look: unified glass cards, accent colours, tables, typography, forms and buttons — with no loss of function.',
      ),
    ],
  },
  {
    version: '2.0.9',
    items: [
      t(
        'Regeln & Grenzwerte sind in der neuen Oberfläche (v2) jetzt erreichbar und neu gestaltet: eigene lg2-Seite mit Profil, allen 16 Schwellwert-Reglern und Automatik-Erweiterungen, Live-Vorschau und echtem Probelauf/Simulation (fährt keinen Rollladen).',
        'Rules & thresholds are now reachable and reworked in the new UI (v2): a dedicated lg2 page with profile, all 16 threshold sliders and automation extensions, live preview and a real dry-run simulation (moves no shutter).',
      ),
      t(
        'Der Entscheidungsverlauf zeigt jetzt den echten historischen Verlauf (Zeit, Modus, gefahren/blockiert, Ursache) statt nur geplanter Aktionen — mit Filter und JSON-Export im Experten-Modus.',
        'The decision log now shows the real historical log (time, mode, moved/blocked, reason) instead of just planned actions — with filters and JSON export in expert mode.',
      ),
    ],
  },
  {
    version: '2.0.8',
    items: [
      t(
        'Vorhersage-Tab-Absturz behoben (im Experten-Modus mit Niederschlags-Nowcast). Sturmschutz jetzt auch in der neuen Oberfläche (Automatik) abschaltbar; eine hängende Sturm-Haltezeit wird beim Deaktivieren sofort aufgehoben.',
        'Fixed the Forecast tab crash (expert mode with precipitation nowcast). Storm protection can now be toggled in the new UI (Automation) too; a lingering storm hold is released immediately when disabled.',
      ),
      t(
        'Manuelles Verstellen eines Rollladens in App/WebApp wird respektiert – die Automatik fährt nicht mehr kurz danach zurück und fragt optional per Telegram (/ja oder /nein), ob wieder geschlossen werden soll.',
        'Manually moving a shutter in the app/WebApp is respected — automation no longer drives it back shortly after and optionally asks via Telegram (/ja or /nein) whether to close again.',
      ),
      t(
        'Neuer 24-Stunden-Plan pro Raum im Vorhersage-Tab: erwartete Temperaturkurve plus jede geplante Rollladen-Fahrt mit Ziel und Begründung; Horizont 12/24/48 h wählbar.',
        'New 24-hour per-room plan on the Forecast tab: expected temperature curve plus every planned shutter move with target and reason; horizon 12/24/48 h selectable.',
      ),
      t(
        'Neues „sanftes Beschatten" (optional): beschattet erst teilweise (30/50/70 %) und beobachtet, statt bei milder Wärme voll zu schließen – echte Hitzewelle und Sturm bleiben ausgenommen.',
        'New “gentle shading” (optional): shades partially first (30/50/70 %) and observes instead of fully closing on mild-warm days — a real heatwave and storm stay exempt.',
      ),
    ],
  },
  {
    version: '2.0.7',
    items: [
      t(
        'Sturmschutz lässt sich in den Einstellungen deaktivieren (Standard bleibt an). Neues virtuelles HCU-Gerät „Hitzeschutz Automatik" (SWITCH) schaltet die Automatik ein/aus – auch in HCU-Automationen und der HmIP-App nutzbar.',
        'Storm protection can be disabled in the settings (default stays on). New virtual HCU device “Heat Shield Automation” (SWITCH) turns automation on/off — usable in HCU automations and the HmIP app.',
      ),
      t(
        'Kompass-Rose im Gebäude-Studio ein-/ausblendbar. Neuer Parameter „Kühl-Soll-Temperatur": gibt eine Ziel-Innentemperatur für alle Räume vor.',
        'Compass rose in the Building Studio can be shown/hidden. New “cooling target temperature” parameter: sets a target indoor temperature for all rooms.',
      ),
    ],
  },
  {
    version: '2.0.6',
    items: [
      t(
        'Gebäude-Studio 3D: Die 3D-Ansicht war gespiegelt (Nord/Süd) und ist jetzt korrekt wie die 2D-Ansicht. Wandecken (L) werden im 3D-Modell sauber (gehrt) dargestellt.',
        'Building Studio 3D: the 3D view was mirrored (north/south) and now matches the 2D view. Wall corners (L) are rendered cleanly (mitred) in the 3D model.',
      ),
      t(
        'Fenster, Türen und Durchgänge haben jetzt Namen (editierbar); ein Klick auf ein Fenster im Plan springt direkt zu dessen Einstellungen. Neue Kompass-Rose zeigt und stellt die Gebäudeausrichtung (Norden) ein.',
        'Windows, doors and passages now have names (editable); clicking a window in the plan jumps straight to its settings. A new compass rose shows and sets the building orientation (north).',
      ),
    ],
  },
  {
    version: '2.0.5',
    items: [
      t(
        'Gebäude-Studio: Stockwerke lassen sich wieder löschen (Inline-Bestätigung 🗑 → „Löschen?", da der native Dialog im HCU-Webview blockiert ist). Das letzte Stockwerk bleibt geschützt.',
        'Building Studio: storeys can be deleted again (inline confirm 🗑 → “Delete?”, since the native dialog is blocked in the HCU webview). The last remaining storey stays protected.',
      ),
      t(
        'Fenster, Türen und Durchgänge werden per zwei Klicks auf der Wand platziert (Ort + Größe = Distanz) mit Live-Vorschau. An der Öffnung entsteht eine echte Aussparung in der Wand samt Tür-/Fenster-Symbol – nichts wird mehr überlagert.',
        'Windows, doors and passages are placed with two clicks on the wall (position + size = distance) with a live preview. Each opening cuts a real gap in the wall with the door/window symbol drawn inside — nothing is painted on top anymore.',
      ),
    ],
  },
  {
    version: '2.0.4f2',
    items: [
      t(
        'Hausübersicht: Die farbige Temperatur-Kante der Raum-Kacheln ist wieder deutlich als Farbband sichtbar und färbt sich immer nach dem Messwert (grün < 24 °C, blau 24–26 °C, rot > 26 °C), sobald ein Messwert vorliegt.',
        'House overview: the coloured temperature edge of the room tiles is clearly visible again as a colour band and always reflects the reading (green < 24 °C, blue 24–26 °C, red > 26 °C) whenever a reading exists.',
      ),
    ],
  },
  {
    version: '2.0.4f1',
    items: [
      t(
        'Gebäude-Studio 3D: Das Dach beschneidet jetzt immer die Räume – keine Wände mehr, die durchs Dach stoßen. Dächer haben nur noch Schrägflächen; Giebel, Krüppelwalm-Giebel und Kniestock entstehen aus der obersten Wand, die bis zum Dach aufgefüllt wird.',
        'Building Studio 3D: the roof now always clips the rooms – no walls poking through. Roofs are sloped surfaces only; gables, half-hip gablets and the knee wall are formed by the top wall, which fills up to the roof.',
      ),
      t(
        'Dachüberstand wirkt in 3D (Standard 1 m). Dachfenster sitzen im Dach und lassen PV-Aussparungen; PV liegt auf der Dachschräge statt auf dem Deckel. Wand-Bezugskante (Mitte/Außen/Innen) und Snapping auf Wandkanten; Räume/Fenster mit der Konfiguration verknüpfbar.',
        'Roof overhang works in 3D (default 1 m). Roof windows sit in the roof and leave PV cut-outs; PV lies on the roof slope, not the storey lid. Wall reference edge (centre/outer/inner) and snapping to wall faces; rooms/windows can be linked to the configuration.',
      ),
    ],
  },
  {
    version: '2.0.4',
    items: [
      t(
        'Gebäude-Studio stark erweitert: Grundriss zeichnen mit Auto-Schluss (Wand/Raum schließt am Startpunkt), feineres Raster (1–10 cm) und starkes Snapping auf vorhandene Ecken. Punkte lassen sich nachträglich verschieben (ziehen) und löschen (Alt+Klick).',
        'Building Studio greatly expanded: draw floor plans with auto-close (wall/room closes on the start point), a finer grid (1–10 cm) and strong snapping to existing corners. Points can be moved (drag) and deleted (Alt-click) afterwards.',
      ),
      t(
        'Fenster & Türen mit Höhe, Breite, Verglasung (1-/2-/3-fach) und Dachfenster-Option – jetzt auch im 2D-Plan sichtbar. Wände mit Standard-Dicke (Innen/Außen). Raumliste mit Namen und m². Keller anlegbar. 2D- und 3D-Ansicht im selben Bereich.',
        'Windows & doors with height, width, glazing (single/double/triple) and a roof-window option — now shown in the 2D plan too. Walls with a default thickness (interior/exterior). Room list with names and m². Basement supported. 2D and 3D view in the same area.',
      ),
      t(
        'Kompaktere, platzsparende Oberfläche (Projekt in der Kopfzeile, „Mehr"-Menü, schließbare Hilfe-Kachel). Hausübersicht: Kachel-Flächen färben nach Raumtemperatur (grün/blau/rot), Fenster-Symbol in Textfarbe.',
        'More compact, space-saving UI (project in the header, a "More" menu, dismissible help card). House overview: tile faces coloured by room temperature (green/blue/red), window icon in text colour.',
      ),
    ],
  },
  {
    version: '2.0.3f2',
    items: [
      t(
        'Pull-to-Refresh (Mobile): am Seitenanfang nach unten ziehen lädt die Seite neu — für iOS, wo es keine native Geste gibt. Ein Glas-Indikator folgt dem Zug.',
        'Pull-to-refresh (mobile): pulling down at the top of the page reloads it — for iOS, which has no native gesture. A glass indicator follows the pull.',
      ),
    ],
  },
  {
    version: '2.0.3f1',
    items: [
      t(
        'Mobile-Feinschliff: Wetter-Chip rechtsbündig im gestapelten Header; Automatik-Schalter mit gleicher Glas-Transparenz wie der Wetter-Chip.',
        'Mobile polish: weather chip right-aligned in the stacked header; automation switch with the same glass transparency as the weather chip.',
      ),
      t(
        'Doppelte Scrollbalken behoben (overflow-x: clip statt hidden); Mobile scrollt natürlich über den Body. Bottom-Navigation verteilt sich flexibel und passt vollständig.',
        'Fixed double scrollbars (overflow-x: clip instead of hidden); mobile scrolls naturally via the body. Bottom navigation distributes flexibly and fits fully.',
      ),
    ],
  },
  {
    version: '2.0.3',
    items: [
      t(
        'Mobile-Oberfläche überarbeitet: neue iPhone-taugliche Bottom-Navigation mit Beschriftung — alle Bereiche (auch Nachrichten, Hilfe, Darstellung, Ansicht) sind auf dem Handy erreichbar; respektiert die iOS Safe-Areas.',
        'Mobile UI reworked: new iPhone-friendly bottom navigation with labels — every area (incl. messages, help, appearance, view) is reachable on the phone; respects iOS safe areas.',
      ),
      t(
        'Wetter-Chip zeigt den Ort, der Automatik-Schalter trägt auf dem Handy wieder seinen Text, und der Titel wird nicht mehr unter der Notch abgeschnitten.',
        'Weather chip shows the location, the automation switch shows its text again on mobile, and the title is no longer clipped under the notch.',
      ),
      t(
        'Einstellungs-Kacheln jetzt exakt im Liquid-Glass-Look (volle Glas-Rezeptur wie alle V2-Karten). Symbol-Schatten und Kachel-Rahmen (Stärke und Farbe) sind konfigurierbar.',
        'Settings tiles now exactly in the Liquid Glass look (full glass recipe like all V2 cards). Icon shadow and tile border (strength and colour) are configurable.',
      ),
      t(
        'Layout-Fix: die kompakte Icon-Leiste bricht schmale Fenster nicht mehr (kein gequetschter Inhalt, keine doppelten Scrollbalken).',
        'Layout fix: the compact icon rail no longer breaks narrow windows (no squeezed content, no double scrollbars).',
      ),
    ],
  },
  {
    version: '2.0.2',
    items: [
      t(
        'Hausübersicht neu: Raum-Kacheln im klaren 4×3-Raster mit reichem Klick-Popup samt manueller Steuerung (Auf/50 %/Zu) – ohne 3D-Haus im Hintergrund; der obere Bereich füllt den freien Platz.',
        'New house overview: room tiles in a clean 4×3 grid with a rich click popup incl. manual control (open/50 %/closed) — without the 3D house behind it; the hero above fills the free space.',
      ),
      t(
        'Popup und Detailansicht jetzt im Liquid-Glass-Design; Kacheln im Glas-Look passend zu den Räumen. Einstellungs-Seiten durchgängig im V2-Glas-Design (inkl. High-FPS-Optionen).',
        'Popup and detail view now in Liquid Glass design; tiles in a glass look matching the rooms. Settings pages consistently in V2 glass design (incl. high-FPS options).',
      ),
      t(
        'Darstellung erweitert: konfigurierbare Status-Farbpalette, Theme-Import/-Export und Überspeichern eigener Presets.',
        'Appearance extended: configurable status colour palette, theme import/export and overwriting your own presets.',
      ),
      t(
        'Unterstützung für HmIP-HDM1 Beschattungsmodule (Hunter Douglas / erfal).',
        'Support for HmIP-HDM1 shading modules (Hunter Douglas / erfal).',
      ),
    ],
  },
  {
    version: '2.0.1',
    items: [
      t(
        'Hausübersicht zeigt jederzeit alle Räume – ohne Scrollen. Das Kachelraster teilt sich die Kartenhöhe und verdichtet sich bei vielen Räumen, sodass die Basis-Ansicht auf einen Blick sichtbar bleibt (volle Details je Raum im Popup).',
        'House overview shows all rooms at all times — without scrolling. The tile grid shares the card height and condenses when there are many rooms, so the Basic view stays visible at a glance (full per-room detail in the popup).',
      ),
    ],
  },
  {
    version: '2.0.0',
    items: [
      t(
        'Komplett neue Oberfläche „Liquid Glass" – jetzt Standard für alle Installationen. Die klassische 1.20-Oberfläche bleibt unter Einstellungen wählbar.',
        'A completely new "Liquid Glass" interface — now the default for every installation. The classic 1.20 interface remains available under Settings.',
      ),
      t(
        'Frosted-Glass-Design mit linker Seitenleiste. Jede Seite hat eine ruhige Basis- und eine tiefe Experten-Ansicht (Rohwerte, alle geplanten Aktionen, Risiko je Fenster, Lernmodell, manuelle Steuerung mit Sturmschutz-Vorrang).',
        'Frosted-glass design with a left sidebar. Every page has a calm Basic view and a deep Expert view (raw values, all planned actions, per-window risk, learned model, manual control with storm-protection precedence).',
      ),
      t(
        'Voll konfigurierbare Darstellung: Vorlagen (inkl. eigener), Akzentfarbe, Hell/Dunkel/Auto, Hintergrundbild, Glas-Stärke und Symbol-Kacheln — plus Performance-Optionen (Statisches Glas, High FPS Mode) für flüssiges Scrollen.',
        'Fully configurable appearance: presets (incl. your own), accent colour, light/dark/auto, wallpaper, glass strength and icon tiles — plus performance options (Static Glass, High FPS mode) for smooth scrolling.',
      ),
      t(
        'Neuer geführter Einrichtungs-Assistent: Standort (auch per Gerätestandort), PV-Anlage (FusionSolar oder ein anderes HMIP-Watt-Gerät), GARDENA-Bewässerung, Räume und Rollläden per Auswahlmenü. Durchgängig zweisprachig (DE/EN).',
        'New guided setup wizard: location (also via device location), PV system (FusionSolar or another HMIP watt device), GARDENA irrigation, rooms and shutters via dropdown. Bilingual throughout (DE/EN).',
      ),
      t(
        'Unterstützung für HmIP-HDM1 Beschattungsmodule (Hunter Douglas / erfal): Sie werden automatisch erkannt und wie Rollläden für den Hitzeschutz angesteuert.',
        'Support for HmIP-HDM1 shading modules (Hunter Douglas / erfal): they are detected automatically and driven like shutters for heat protection.',
      ),
    ],
  },
  {
    version: '1.20.0',
    items: [
      t(
        'Stockwerk-Beschattung: Obergeschosse (OG/DG) werden früher beschattet als Erd- und Kellergeschoss. Pro Stockwerk einstellbar (Regeln → Stockwerk-Beschattung); leer = automatisch.',
        'Floor-based shading: upper floors (OG/DG) shade earlier than the ground floor and cellar. Configurable per floor (Rules → Floor-based shading); empty = automatic.',
      ),
      t(
        'Hitzetag-Schutz: Ab 35 °C und anliegender PV-Leistung (Sonne) fahren Rollläden nicht weiter als 50 % auf, damit ein Grundschutz erhalten bleibt. Schwelle und Maximal-Öffnung einstellbar (Regeln → Hitzetag-Schutz).',
        'Hot-day protection: at 35 °C or more with PV power present (sun) shutters open no further than 50 %, keeping a baseline of shade. Threshold and max opening configurable (Rules → Hot-day protection).',
      ),
      t(
        'Räume mit mobiler Klimaanlage lassen sich als „aktiv gekühlt" markieren und werden dann vom Lernen ausgenommen, damit verfälschte Innentemperaturen das Modell nicht stören.',
        'Rooms with a mobile AC can be marked "actively cooled" and are then excluded from learning so skewed indoor temperatures do not corrupt the model.',
      ),
      t(
        'Alert-Modus: Titel jetzt „Unwetterwarnung". Rahmen und Text tragen die DWD-Warnstufenfarbe (gelb/orange/rot/violett) statt immer gelb. Mit ✕ ausblendbar und als kleiner Hinweis wieder einblendbar. Während einer Warnung halbiert sich das Automatik-Zyklusintervall (mindestens 300 s).',
        'Alert mode: title is now "Severe-weather warning". Frame and text use the DWD warning-level colour (yellow/orange/red/violet) instead of always yellow. Dismiss with ✕ and reopen via a small pill. During a warning the automation cycle interval is halved (minimum 300 s).',
      ),
      t(
        'Pro Rollladen lassen sich Sperrzeiten festlegen (Wochentage + Uhrzeit, z. B. „Dachfenster Mo–Fr 22:00–10:00 nicht bewegen"). Sturm hat weiterhin Vorrang.',
        'Per-shutter block schedules (weekdays + time, e.g. "roof window Mon–Fri 22:00–10:00 do not move"). Storm still takes priority.',
      ),
      t(
        'Telegram-Häufigkeit der Unwetterwarnung einstellbar: aus, nur Änderungen, oder alle 30/60/90 Minuten (Einstellungen → Darstellung).',
        'Telegram frequency for severe-weather warnings is configurable: off, changes only, or every 30/60/90 minutes (Settings → Appearance).',
      ),
    ],
  },
  {
    version: '1.19.1',
    items: [
      t(
        'Alert-Modus: roter Rahmen auch bei DWD-Hitzewarnungen (deren hoher Level-Code wurde vorher fälschlich gelb dargestellt). Regenradar höher und besser ablesbar.',
        'Alert mode: red frame for DWD heat warnings too (their high level code was previously shown yellow). Rain radar taller and easier to read.',
      ),
    ],
  },
  {
    version: '1.19.0',
    items: [
      t(
        'Neuer Alert-Modus („Katastrophenschutz-Zentrale"): Bei einer DWD-Warnung ab Stufe Rot erscheint auf Startseite und Wetter-Tab ein auffälliges Panel mit Warnung, Handlungshinweis, Live-Werten (Gewitter, Wind, Niederschlag), 15-Minuten-Niederschlag und kompaktem Radar. Je Tab unter Darstellung abschaltbar.',
        'New alert mode ("emergency center"): a DWD warning of level red or higher shows a prominent panel on the start page and Weather tab with the warning, advice, live values (thunderstorm, wind, precipitation), 15-minute precipitation and a compact radar. Can be turned off per tab under Appearance.',
      ),
      t(
        'DWD-Unwetterwarnungen jetzt auch per Telegram: sofort bei neuer/eskalierter Warnung, alle 30 Minuten ein Lage-Update und automatische Entwarnung.',
        'DWD severe-weather warnings now via Telegram too: immediately on a new/escalated warning, a situation update every 30 minutes, and an automatic all-clear.',
      ),
      t(
        'Ort für DWD-Warnungen ist jetzt einstellbar (Einstellungen → Darstellung; Standard Berlin) und wird im Assistenten aus den Koordinaten vorgeschlagen. Warnungen werden auch auf Landkreis-Ebene erkannt.',
        'The DWD warning location is now configurable (Settings → Appearance; default Berlin) and is suggested from the coordinates in the wizard. Warnings are also detected at district level.',
      ),
      t(
        'Sofort-Warnung bei offenen Fenstern – besonders Dachfenstern – während Sturm oder Regen, über Telegram und Dashboard.',
        'Immediate warning for open windows – especially roof windows – during storm or rain, via Telegram and the dashboard.',
      ),
      t(
        'Regenradar: Verlauf, Jetzt und Vorhersage klar getrennt, plus ein neuer 2-Stunden-Niederschlags-Strip (Open-Meteo, 15-Minuten-Auflösung).',
        'Rain radar: past, now and forecast clearly separated, plus a new 2-hour precipitation strip (Open-Meteo, 15-minute resolution).',
      ),
      t(
        'Bewässerung: AUTO-Knopf im Planer legt die optimale Strategie an und berechnet täglich neu, ob/wann/wie lange jede Zone läuft.',
        'Irrigation: an AUTO button in the planner sets the optimal strategy and recomputes daily whether/when/how long each zone runs.',
      ),
      t(
        'Beschattung: „Forecast – Nächste 12 Stunden" heißt jetzt „Wettervorhersage – Nächste 12 Stunden".',
        'Shading: "Forecast – next 12 hours" is now "Weather forecast – next 12 hours".',
      ),
    ],
  },
  {
    version: '1.18.5',
    items: [
      t(
        'Mobil: Der Automatik-Schalter in der Kopfzeile schrumpft auf dem Smartphone zum reinen Schalter (Beschriftung ausgeblendet), damit die Navigation wieder bedienbar ist.',
        'Mobile: the automation switch in the header shrinks to just the toggle on phones (label hidden) so the navigation is usable again.',
      ),
      t(
        '„Nächste Aktionen" und die 12-Stunden-Vorschau zeigen Fenster mit aktiver Übersteuerung oder ausgeschalteter Automatik jetzt als gehalten („keine Fahrt") an, statt eine geplante Fahrt, die gar nicht ausgeführt wird.',
        '"Next actions" and the 12 h preview now show windows with an active override or with automation off as held ("no move"), instead of a planned move that will not run.',
      ),
    ],
  },
  {
    version: '1.18.4',
    items: [
      t(
        'Fix: Das Schalten der Plugin-Geräte „Hitzeschutz pausiert" und „Urlaub" in der Homematic-App wirkt jetzt sofort auf Status und Automatik — bisher wurde der Schaltbefehl nur gespeichert, aber erst nach einem Neustart übernommen.',
        'Fix: toggling the plugin devices "Heat protection paused" and "Vacation" in the Homematic app now takes effect immediately on status and automation — previously the toggle was only persisted and applied only after a restart.',
      ),
    ],
  },
  {
    version: '1.18.3',
    items: [
      t(
        'Beschattung folgt der tatsächlichen Sonnenlast: an heißen, aber bewölkten Phasen bleiben die Rollläden für Tageslicht offen statt unnötig zu schließen (ein geschlossener Rollo kühlt einen warmen Raum nicht, wenn keine Sonne anliegt) — und schließen automatisch, sobald wieder Solarlast auftritt.',
        'Shading now follows the actual solar load: on hot but cloudy spells the shutters stay open for daylight instead of closing pointlessly (a closed shutter cannot cool a warm room when there is no sun) — and close again automatically once solar load returns.',
      ),
      t(
        'Live-PV-Nowcast: bricht die PV-Leistung durch aufziehende Wolken ein, korrigiert das Plugin die Strahlungsprognose der nächsten Stunden sofort, statt der trägeren Wettervorhersage zu folgen.',
        'Live PV nowcast: when PV output collapses under incoming clouds, the plugin immediately corrects the next hours\u2019 radiation forecast instead of trailing the slower weather forecast.',
      ),
      t(
        'Selbstlernende Anlagen-Ausrichtung: der Azimut der PV-Anlage wird aus der Leistungskurve gelernt, sodass der Nowcast ohne manuelle Eingabe weiß, wann die Sonne auf die Module scheint.',
        'Self-learning array orientation: the PV array azimuth is learned from the power curve, so the nowcast knows when the sun is on the panels without manual configuration.',
      ),
      t(
        'Diagramm „Temperatur mit/ohne Beschattung" zeigt jetzt den echten Beschattungsnutzen (zwei separate Simulationen statt nahezu identischer Kurven).',
        'The "temperature with/without shading" chart now shows the real shading benefit (two separate simulations instead of near-identical curves).',
      ),
      t(
        'Korrektur: Räume mit aktiver manueller Übersteuerung werden in der 12-Stunden-Rollladen-Vorschau als gehalten dargestellt (mit „Manuell"-Markierung) statt eine Fahrt anzuzeigen, die wegen der Übersteuerung gar nicht ausgeführt wird.',
        'Fix: rooms with an active manual override now show as held in the 12 h shutter timeline (with a "Manual" tag) instead of a move that the override prevents from running.',
      ),
    ],
  },
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

      <OtaPanel />

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
