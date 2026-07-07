# Changelog

Alle nennenswerten Änderungen am Heat-Shield-Plugin. Version = Single
Source of Truth in `package.json`. Build mit `npm run build:image`.

## 2.0.7

- **Sturmschutz deaktivierbar:** In den Einstellungen (Regeln → Automatik-Erweiterungen) lässt sich der Sturmschutz-Zwangsöffner abschalten. Standard bleibt **an** (Sicherheit).
- **Virtuelles HCU-Gerät „Hitzeschutz Automatik":** ein neuer SWITCH, mit dem sich die Automatik ein/aus schalten lässt – nutzbar in HCU-Automationen und in der HmIP-App. Bidirektional mit `automationEnabled` synchron (Dashboard/Telegram/HCU). Alte State-Dateien werden migriert (5 → 6 Schalter, ohne Datenverlust).
- **Kompass-Rose ein-/ausblendbar:** die Windrose im Gebäude-Studio ist nicht mehr dauerhaft eingeblendet (🧭-Button).
- **Kühl-Soll-Temperatur:** neuer setzbarer Parameter (Regeln), der eine Ziel-Innentemperatur für alle Räume vorgibt und das Komfortband entsprechend verschiebt. Optional – ohne Angabe gelten die per-Raum-Ziele wie bisher.

## 2.0.6

- **3D-Ansicht war gespiegelt** (Nord/Süd) – jetzt korrekt in derselben Ausrichtung wie die 2D-Ansicht.
- **Saubere Wandecken (L) im 3D-Modell** – Wände werden im 3D-Mesh gehrt (wie in 2D), keine klaffenden/überlappenden Ecken mehr.
- **Fenster/Türen/Durchgänge haben Namen** (editierbar); beim 2-Klick-Platzieren automatisch vergeben.
- **Klick auf ein Fenster im Plan** wählt es aus und springt direkt zu dessen Einstellungen (Zeile hervorgehoben, in den sichtbaren Bereich gescrollt).
- **Kompass-Rose** über der Zeichenfläche zeigt und stellt die Gebäudeausrichtung (Norden) ein – per Ziehen, ↺/↻ (15°) oder Gradeingabe; wirkt auch auf die Sonnen-/Schattenberechnung im 3D.

## 2.0.5

- **Gebäude-Studio – Stockwerke löschen:** Das Löschen von Stockwerken funktioniert wieder. Der native Bestätigungsdialog (`window.confirm`) wird im HCU-Webview blockiert; ersetzt durch eine **Inline-Bestätigung** (🗑 → „Löschen?" → bestätigen, ✕ bricht ab). Das letzte verbleibende Stockwerk bleibt geschützt.
- **Gebäude-Studio – Öffnungen per 2 Klicks:** Fenster, Türen und Durchgänge werden jetzt durch **zwei Klicks auf der Wand** platziert – erster Klick = Startpunkt, zweiter Klick = Endpunkt; **Breite = Distanz** dazwischen (aufs Raster gerundet). Mit Live-Vorschau (Laibungs-Ticks + Spannband) und Breiten-Anzeige; Esc bricht ab.
- **Echte Aussparung + Symbol:** An jeder Öffnung entsteht eine echte Lücke in der Wand, in der Tür/Fenster/Durchgang gezeichnet werden – nichts wird mehr über die Wand gelegt.

## 2.0.4f2

- **Hausübersicht:** Die farbige **Temperatur-Kante** der Raum-Kacheln ist wieder deutlich als **Farbband** am linken Rand sichtbar und färbt sich **immer nach dem Messwert** (grün < 24 °C, blau 24–26 °C, rot > 26 °C), sobald ein Messwert vorliegt — nicht mehr grau, wenn kein Sensor formal gebunden ist.

## 2.0.4f1

- **Gebäude-Studio 3D deutlich verbessert.** Das **Dach beschneidet jetzt immer die Räume** — keine Wände mehr, die durch das Dach stoßen (auch ein Obergeschoss im Dachraum wird an der Dachschräge gekappt).
- **Dächer haben nur noch Schrägflächen.** Giebel, Krüppelwalm-Giebel und der Kniestock-Bereich werden aus der **obersten Wand** gebildet, die automatisch bis zum Dach aufgefüllt und an den Dachschrägen abgeschnitten wird. Kein senkrechtes „Wandstück" mehr am Dach.
- **Dachüberstand wirkt in 3D** (Standard **1 m**): die Traufe ragt hinaus und hängt entlang der Neigung herunter, der First bleibt auf Wandspann-Höhe.
- **Dachfenster sitzen im Dach** (nicht in der Wand) und lassen **PV-Aussparungen**; **PV liegt auf der Dachschräge** statt flach auf dem Geschoss-Deckel.
- **Wand-Bezugskante** (Mitte/Außen/Innen) beim Zeichnen und **Snapping auf Wand-Innen-/Außenkanten**; saubere **L-Ecken** auch am Raum-Schlusspunkt.
- **Räume und Fenster** lassen sich mit der HeatShield-Konfiguration **verknüpfen**.

## 2.0.4

- **Gebäude-Studio (Grundriss-Editor) stark erweitert.** Grundriss zeichnen mit **Auto-Schluss**: Wand und Raum schließen automatisch, sobald man wieder auf den Startpunkt klickt. **Feineres Raster** (1/2/5/10 cm zusätzlich zu 0,25/0,5/1 m) und **starkes Snapping** auf vorhandene Ecken. Punkte lassen sich **nachträglich verschieben** (ziehen) und **löschen** (Alt+Klick); Wände/Räume/Öffnungen einzeln löschbar.
- **Fenster & Türen** mit Höhe, Breite, **Verglasung (1-/2-/3-fach)** und **Dachfenster**-Option; werden jetzt auch **im 2D-Plan** angezeigt. **Wände** mit wählbarer Standard-Dicke (Innen 11,5/17,5 cm, Außen 24/30/36,5 cm). **Dachüberstand** einstellbar.
- **Raumliste** mit editierbarem Namen und **m²**; Raumname + Fläche direkt im Plan. **Keller** anlegbar (unter dem EG). **2D- und 3D-Ansicht im selben Viewport** umschaltbar.
- **Kompaktere, platzsparende Oberfläche**: Projektwahl in der Kopfzeile, sekundäre Aktionen im **„Mehr"-Menü**, kontextuelle Wand-Aktionen, schließbare Hilfe-Kachel. Nur-Desktop-Hinweis auf schmalen Screens.
- **Hausübersicht**: die Kachel-Flächen färben sich nach Raumtemperatur (grün < 24 °C, blau 24–26 °C, rot > 26 °C); das „Fenster offen"-Symbol nutzt die Textfarbe des Raumnamens.

## 2.0.3f2

- **Pull-to-Refresh (Mobile).** Am Seitenanfang nach unten ziehen löst einen Reload der Seite aus — für iOS-WebViews/Standalone, die keine native Geste haben. Ein Glas-Indikator (drehender Pfeil) folgt gedämpft dem Zug und wird grün ab der Auslöseschwelle. Nur Touch-Geräte, nur am Scroll-Anfang; horizontales Wischen, normales Scrollen und Overlays bleiben unberührt. Respektiert `prefers-reduced-motion` und die iOS Safe-Area.

## 2.0.3f1

- **Mobile-Feinschliff.** Wetter-Chip im gestapelten Header **rechtsbündig**; **Automatik-Schalter** mit derselben Glas-Transparenz wie der Wetter-Chip (Sheen + Scrim + Panel + Bevel, inkl. Static-Glass/Lite).
- **Doppelte Scrollbalken behoben.** `.lg2-demo`/`.lg2-main` nutzen `overflow-x: clip` statt `hidden` — `hidden` erzwang laut CSS-Spec `overflow-y: auto` und machte beide zu vertikalen Scroll-Containern. Mobile scrollt jetzt (auch im Experten-Modus) natürlich über den Body.
- **Bottom-Navigation passt vollständig.** Die Tabs verteilen sich flexibel über die Leistenbreite (`flex: 1 1 auto`, Labels mit Ellipsis); auf sehr schmalen Handys scrollt die Leiste weiterhin.

## 2.0.3

- **Mobile-Oberfläche überarbeitet.** Neue iPhone-taugliche **Bottom-Navigation**: die Seitenleiste wird zu einer festen, unten angedockten Glas-Leiste mit horizontal scrollbaren Tabs (Icon + Beschriftung), sodass **alle** Bereiche (auch Nachrichten, Hilfe, Darstellung, Ansicht) auf dem Handy erreichbar sind. Respektiert die iOS Safe-Areas.
- **Wetter-Chip zeigt den Ort** (statt eines Strichs, wenn der Himmelszustand unbekannt ist). Der **Automatik-Schalter** trägt auf dem Handy wieder seinen Text, und der Titel „Übersicht" wird nicht mehr unter der Statusleiste/Notch abgeschnitten.
- **Einstellungs-Kacheln exakt im Liquid-Glass-Look.** Ursache behoben: die Landing-Kacheln nutzten nur eine flache Panel-Füllung statt der vollen Glas-Rezeptur (Sheen + Scrim + Panel, Bevel, Specular-Rim) — jetzt identisch zu allen anderen V2-Karten, inkl. Lite/Static-Glass/High-FPS.
- **Symbol-Schatten & Kachel-Rahmen konfigurierbar.** Neuer Regler „Schatten-Stärke" für den Glyph-Schatten (jetzt standardmäßig an und sichtbarer) sowie „Kachel-Rahmen" mit **Rahmen-Stärke** (0–3 px) und **Rahmen-Farbe** (Auto oder frei wählbar).
- **Layout-Fix (schmale Fenster).** Die kompakte Icon-Leiste (`navRail`) ist jetzt auf Desktop/Tablet beschränkt; auf schmalen Fenstern (≤ 820 px) quetscht sie den Inhalt nicht mehr in einen 72-px-Streifen und es gibt keine doppelten Scrollbalken mehr.

## 2.0.2

- **Hausübersicht neu aufgebaut.** Die Räume erscheinen als klares Kachelraster (max. 4×3 = 12 Räume; darüber scrollt das Raster in der Karte) mit farbigem Status-Balken. Ein Klick öffnet ein reiches Popup mit Werten und **manueller Steuerung** (Auf / 50 % / Zu, Slider) sowie „Detailansicht öffnen". Das frühere 3D-Haus im Hintergrund entfällt; der **Hero oben** ist ein flexibler Platzhalter, der den freien Platz füllt, sodass die Kacheln nur so hoch sind wie nötig.
- **Popup & Detailansicht im Liquid-Glass-Design (V2).** Beide werden per Portal außerhalb der Shell gerendert; die V2-Tokens werden jetzt auf `<body>` gespiegelt, sodass sie dem aktiven Theme (Akzent, Glas, Hell/Dunkel) folgen. Die Chips nutzen denselben Glas-Hintergrund wie die Räume-Liste.
- **Darstellung erweitert:** konfigurierbare **Status-Farbpalette** (Gering/Warnung/Hoch/Info), **Theme-Import/-Export** (JSON, kopieren + herunterladen / einfügen + anwenden) und **Überspeichern** eigener Presets bei Änderungen.
- **HmIP-HDM1** Beschattungsmodule (Hunter Douglas / erfal) werden erkannt und wie Rollläden angesteuert.
- Leerzustand „Keine Räume konfiguriert" zentriert. Fix: beschädigter Service-Worker-Kommentar bereinigt.

## 2.0.2

- **Hausübersicht neu gestaltet.** Die Raum-Kacheln erscheinen in einem klaren **4×3-Raster** (max. 12 Räume sichtbar, darüber scrollt die Karte) mit einem **reichen Klick-Popup** samt manueller Steuerung (Auf / 50 % / Zu, Slider) – **ohne** das 3D-Haus im Hintergrund. Der obere „Hero"-Bereich ist ein flexibler Platzhalter und füllt den freien Platz, sodass keine leere Zeile entsteht.
- **Durchgängiges V2-Design.** Popup und Detailansicht nutzen jetzt das Liquid-Glass-Design; die Kacheln haben den gleichen Glas-Look wie die Räume-Zeilen. **Alle Einstellungs-Seiten** (inkl. Einstellungs-Hub, Diagnose, Logs, Bewässerung, Quellen …) sind auf die Glas-Optik vereinheitlicht und die **High-FPS-Optionen** greifen auch dort.
- **Darstellung erweitert.** Konfigurierbare **Status-Farbpalette** (Gering/Warnung/Hoch/Info), **Theme-Import/-Export** (JSON) und **Überspeichern** eigener Presets bei Änderungen.
- **HmIP-HDM1** Beschattungsmodule (Hunter Douglas / erfal) werden unterstützt (automatische Erkennung, Steuerung via `setPrimaryShadingLevel`).
- Fix: beschädigter Service-Worker-Kommentar (Mojibake) bereinigt.

## 2.0.1

- **Hausübersicht zeigt jederzeit alle Räume – ohne Scrollen.** Das Kachelraster teilt sich die Kartenhöhe und passt sich der Raumanzahl an: In der Basis-Ansicht schrumpfen die Kacheln so weit, dass **alle** Räume auf einen Blick sichtbar bleiben, statt innerhalb der Karte zu scrollen. Bei vielen Räumen (ab drei Zeilen) verdichtet sich die Kachel automatisch (Name, Risiko-Ampel und Temperatur bleiben lesbar; die Rollladen-Zeile wandert in das Detail-Popup). In der Experten-Ansicht behalten die Kacheln ihre volle Höhe und die Seite scrollt wie gewohnt.

## 2.0.0

- **Komplett neue Oberfläche „Liquid Glass" – jetzt Standard für alle Installationen.** Frosted-Glass-Design mit linker Seitenleiste (keine obere Navigation). Jede Seite hat eine ruhige **Basis-Ansicht** und eine tiefe **Experten-Ansicht** (Rohwerte, alle geplanten Aktionen, Risiko je Fenster, Lernmodell je Raum, manuelle Rollladen-/Ventilsteuerung mit Sturmschutz-Vorrang). Die klassische **1.20-Oberfläche** bleibt unter *Einstellungen → Darstellung & Sprache* wählbar.
- **Voll konfigurierbare Darstellung.** Vorlagen inkl. eigener Presets (Standard „Glass", zusätzlich „White"), Akzentfarbe, Hell-/Dunkel-/Auto-Schema, Hintergrundbild, Glas-Stärke und Symbol-Kacheln — dazu Performance-Optionen (**Statisches Glas**, **High FPS Mode** mit granularen Schaltern) für flüssiges Scrollen. Das Darstellungs-Menü ist neu in Abschnitte gegliedert.
- **Neuer geführter Einrichtungs-Assistent.** Führt beim ersten Start Schritt für Schritt durch die komplette Einrichtung: Standort (auch per Gerätestandort), **PV-Anlage** (FusionSolar oder ein anderes HMIP-Watt-Gerät, z. B. vom Modbus-Plugin), **GARDENA-Bewässerung**, **Räume** und **Rollläden** per Auswahlmenü. Fensterkontakte werden ohne Drag-and-drop über Auswahlmenüs zugewiesen.
- **Unterstützung für HmIP-HDM1 Beschattungsmodule** (Hunter Douglas / erfal): Sie werden automatisch erkannt (feature-basiert über `primaryShadingLevel`) und spec-konform über `setPrimaryShadingLevel` wie Rollläden für den Hitzeschutz angesteuert — ohne zusätzliche Konfiguration, auch für bestehende Installationen.
- **Warnungen grafisch neu** (Hero-Bild je Warnart, DWD-Warnstufenfarben) und ein **Tagesplan-Editor** für die Bewässerung. Durchgängig zweisprachig (DE/EN); ehrliche „–"-Platzhalter statt erfundener Werte.

## 1.20.0

- **Stockwerk-Beschattung**: Obergeschosse (OG/DG) werden früher beschattet als Erd- und Kellergeschoss. Pro Stockwerk einstellbar (Regeln → Stockwerk-Beschattung); leer = automatischer Vorlauf (DG +1,0 / OG +0,6 / EG 0). Wärme und Sonne werden weiterhin pro Fenster verfolgt — der Vorlauf verschiebt nur die Komfortgrenze.
- **Hitzetag-Schutz**: Ab 35 °C (einstellbar) und anliegender PV-Leistung (Sonne) fahren Rollläden nicht weiter als 50 % auf (einstellbar), damit ein Grundschutz erhalten bleibt. Sturm und Nachtauskühlung sind ausgenommen.
- **Aktiv gekühlte Räume**: Räume mit mobiler Klimaanlage lassen sich markieren und werden vom Lernen (Kalibrierung + Komfort-Bias) ausgenommen, damit verfälschte Innentemperaturen das Modell nicht stören.
- **Alert-Modus**: Titel jetzt „Unwetterwarnung". Rahmen, Text und Glühen tragen die DWD-Warnstufenfarbe (Stufe 1 gelb, 2 orange, 3 rot, 4 violett) statt immer gelb. Panel mit ✕ ausblendbar und als kompakter Hinweis wieder einblendbar (Eskalation blendet automatisch wieder ein). Während einer aktiven Warnung (Stufe ≥ 3) halbiert sich das Automatik-Zyklusintervall, mindestens 300 s.
- **Sperrzeiten pro Rollladen**: Wochentage + Uhrzeit-Fenster (über Mitternacht hinweg), z. B. „Dachfenster Schlafzimmer Mo–Fr 22:00–10:00 nicht bewegen". Sturm hat weiterhin Vorrang. Verfeinerung der bisherigen Raum-Ruhezeiten.
- **Telegram-Häufigkeit** der Unwetterwarnung einstellbar: aus, nur Änderungen, oder alle 30/60/90 Minuten.

## 1.19.1

- **Alert-Modus: roter Rahmen** auch bei DWD-Hitzewarnungen. Deren hoher
  Level-Code (z. B. 51) fiel bisher auf die gelbe Standardfarbe zurück; ab
  Stufe Rot ist der Rahmen jetzt immer rot (Violett nur bei Stufe 4).
- **Regenradar höher** — die Karte (und das eingebettete Radar im Alert-Modus)
  ist jetzt deutlich höher und besser ablesbar.

## 1.19.0

- **Alert-Modus „Katastrophenschutz-Zentrale".** Bei einer aktiven DWD-Warnung
  ab Stufe Rot erscheint auf der Startseite (Beschattung) und im Wetter-Tab ein
  auffälliges, pulsierendes Panel: amtliche Warnung mit DWD-Handlungshinweis,
  Gültigkeit, Live-Sicherheitswerte (Gewitter, Wind, Niederschlag der nächsten
  2 h), ein 15-Minuten-Niederschlags-Strip und – auf der Startseite – ein
  kompaktes Regenradar. Verschwindet automatisch, sobald die Warnung endet. Je
  Tab unter Einstellungen → Darstellung abschaltbar.
- **DWD-Warnungen per Telegram.** Sofortige Meldung bei neuer/eskalierter
  Warnung, alle 30 Minuten ein Lage-Update solange aktiv, und automatische
  „Entwarnung". Während eines Alarms wird der DWD-Feed alle 2 statt 5 Minuten
  abgefragt.
- **DWD-Region konfigurierbar + Landkreis-Fix.** Der Ort für die Warnungen ist
  jetzt im UI einstellbar (Einstellungen → Darstellung; Standard Berlin) und
  wird im Einrichtungs-Assistenten automatisch aus den Koordinaten
  vorgeschlagen. Warnungen werden zusätzlich auf Landkreis-Ebene erkannt (eine
  Gemeinde-Warnzelle ist oft leer, die Warnung liegt auf dem Landkreis).
- **Sofort-Warnung bei offenen Fenstern im Unwetter.** Sind bei Sturm/Regen
  Fenster offen – besonders Dachfenster – kommt umgehend eine eskalierte Warnung
  über Telegram und das Dashboard.
- **Regenradar verbessert.** Verlauf / Jetzt / Vorhersage sind jetzt klar
  getrennt (Badge + relative Zeit), dazu ein neuer 2-Stunden-Niederschlags-Strip
  (Open-Meteo, 15-Minuten-Auflösung) unter dem Radar.
- **Bewässerung: AUTO-Knopf im Planer.** Legt die optimale Bewässerungsstrategie
  an und berechnet täglich neu, ob/wann/wie lange jede Zone läuft (ET-Modell,
  Pflanze, Boden, Sensoren); setzt manuelle Einträge zurück.
- **Beschattung:** „Forecast – Nächste 12 Stunden" heißt jetzt
  „Wettervorhersage – Nächste 12 Stunden".

## 1.18.5

- **Mobile-Navigation nutzbar.** Der Master-Automatik-Schalter in der Kopfzeile
  hat auf dem iPhone die Navigation verdrängt. Auf schmalen Screens wird jetzt
  nur noch der kompakte Schalter angezeigt (Beschriftung ausgeblendet, Status
  weiter über Farbe erkennbar; `aria-label`/`title` für Screenreader).
- **Übersteuerte / inaktive Fenster zeigen „keine Fahrt".** „Nächste Aktionen"
  und die 12-h-Vorschau („Rollladen-Steuerung") zeigten geplante Fahrten auch
  für Fenster, die wegen einer aktiven manuellen Übersteuerung oder
  ausgeschalteter Automatik gar nicht bewegt werden. Solche Einträge werden
  jetzt als gehalten markiert („manuell übersteuert" bzw. „Automatik aus" —
  „keine Fahrt") und zählen nicht mehr ins Aktions-Badge.

## 1.18.4

- **Fix: Plugin-Schalter in der Homematic-App wirken sofort.** Das Umschalten der
  plugin-eigenen Geräte „Hitzeschutz pausiert" und „Urlaub" in der Homematic-App
  wurde bisher nur nach `/data/state.json` geschrieben, aber nicht in den
  laufenden In-Memory-Zustand übernommen — Status (Dashboard) und Automatik
  änderten sich erst nach einem Neustart. Die Übersteuerung läuft jetzt direkt
  auf dem Live-Zustand; Schalten wirkt unmittelbar. Zusätzlich loggt das Plugin
  jeden empfangenen `CONTROL_REQUEST` (Gerät + Wert) zur Diagnose.

## 1.18.3

- **Beschattung folgt der tatsächlichen Sonnenlast.** Der vorausschauende
  Planer schließt nicht mehr maximal, nur weil ein Raum warm ist — er prüft
  zuerst, ob in den nächsten Stunden überhaupt Solarlast anliegt. An heißen,
  aber bewölkten Phasen bleiben die Rollläden für Tageslicht offen und schließen
  automatisch, sobald wieder Sonne auf das Fenster trifft.
- **Live-PV-Nowcast.** Bricht die PV-Leistung durch aufziehende Wolken ein,
  korrigiert das Plugin die Strahlungsprognose der nächsten Stunden sofort,
  statt der trägeren OpenMeteo-Vorhersage zu folgen — nur wenn die Sonne
  tatsächlich auf der Anlage steht (sonst unzuverlässig).
- **Selbstlernende Anlagen-Ausrichtung.** Der Azimut der PV-Anlage wird aus der
  Leistungskurve gelernt (leistungsgewichteter Kreismittelwert des
  Sonnenazimuts, elevations-normalisiert), persistiert unter `/data`. Der
  manuelle `orientationHint` bleibt Fallback, bis die Schätzung sicher ist.
- **Diagramm „Temperatur mit/ohne Beschattung".** Zeigt jetzt zwei echte
  Gegen-Simulationen (alle Fenster offen vs. alle geschlossen) statt nahezu
  identischer Kurven.
- **Fix: manuelle Übersteuerung in der 12-h-Vorschau.** Räume mit aktiver
  Übersteuerung wurden in der „Rollladen-Steuerung · nächste 12 h"-Vorschau
  fälschlich mit einer geplanten Fahrt dargestellt, obwohl die Übersteuerung
  diese hält. Jetzt halten sie ihre Position (mit „Manuell"-Markierung) bis die
  Übersteuerung abläuft.

## 1.18.2

- **Regenradar: dunkle Bedien-Elemente.** Die Karten-Steuerung (Zoom-Buttons und
  Quellenangabe von Leaflet) wurde standardmäßig hell dargestellt und passt sich
  jetzt dem dunklen Dashboard-Look an.

## 1.18.1

- **Logs & Debug: „Alle Informationen".** Neuer Button für einen 360°-Diagnose-
  Export: bündelt alle Status- und Diagnose-Endpunkte (`/api/state`, `config`,
  `diagnostics`, `metrics`, `decisions`, `trends`, `connect/log`, `messages`,
  `notifications`, Quellen-Discovery, GARDENA-Test, synthetischer Probelauf)
  zusammen mit Browser- und System-Informationen (User-Agent, Sprache,
  Viewport/Screen, Zeitzone, Speicher, localStorage-Schlüssel) in **einer
  einzigen `.txt`-Datei** — ideal für Bug-Reports.

## 1.18.0

- **Premium-UI-Politur (Audit-getrieben).** Eine zentrale Normalisierungs-Schicht
  vereinheitlicht das Design: gleiche Karten-Radien, Schatten und Abstände, eine
  klare Typo-Skala (h1/h2/h3 + Karten-Titel) und einheitliche Form-Elemente
  (Eingaben, Buttons, Chips/Badges). Bewusste Formen (Pills, Segment-Schalter,
  runde Icon-Buttons, Toggles) bleiben erhalten.
- **Lesbarkeit.** Zu kleine Mikro-Beschriftungen (8.5–10.5 px) auf eine
  lesbare Mindestgröße (11 px) angehoben.
- **Mobile-Fix.** Breite Tabellen (Quellen-Mapping, Diagnose, Automatik-Kaskade)
  sprengen auf schmalen Screens nicht mehr das Layout, sondern scrollen sauber
  horizontal innerhalb ihrer Karte.

## 1.17.2

- **Wetter-Tab kompakter.** Der Wind sitzt jetzt als kompakte Zeile (Windrose
  horizontal + Ausblick) über dem Regenradar — über die volle Breite und nur so
  hoch wie nötig. Das **Regenradar** liegt darunter über die ganze Breite. Die
  zuvor leere Fläche neben/unter der Windrose ist weg.
- **Fix: Pflanzentyp übersetzt.** Auf den Bewässerungs-Zonenkarten wurde der
  Pflanzentyp als roher Wert (`lawn`, `hedge`, …) angezeigt; er erscheint jetzt
  lokalisiert (Rasen, Hecke, …) — auch in der deutschen Version.

## 1.17.1

- **Einheitlicher Dark-Look.** Mehrere Bereiche trugen noch helle Stilreste aus
  einem früheren Design (weiße Karten/Buttons mit dunkler Schrift): die
  **Lern-Vorschläge** (Live), der **Geräte-Suche**-Status (Räume, Quellen,
  Assistent), die **Szenen-Buttons** und **Übernehmen**-Schaltfläche der
  Steuerung sowie **Sicherung importieren** in der Diagnose. Alle nutzen jetzt
  die dunkle Token-Palette (Karten, Ränder, semantische Status-Töne) und passen
  zum Premium-Dark-Look der übrigen Oberfläche.

## 1.17.0

- **Mehrsprachigkeit (Deutsch / English).** Das komplette Dashboard ist jetzt
  zweisprachig. Die Sprache folgt automatisch der Browsersprache (Deutsch als
  Fallback) und lässt sich unter **Einstellungen → Darstellung & Sprache** pro
  Gerät fest auf **AUTO / Deutsch / English** stellen.
- **Vollständig übersetzt.** Alle Tabs, Diagramme, Empfehlungen, Modus- und
  Entscheidungs-Texte der Engine sowie Hinweise. Zahlen folgen dem jeweiligen
  Sprachformat (Dezimaltrennzeichen); 24-h-Zeit und °C bleiben Standard.
- **Benachrichtigungssprache.** Telegram-Nachrichten haben eine eigene,
  installationsweite Sprachwahl (Standard Deutsch) in den Einstellungen.
- **Windrose** vergrößert und überarbeitet (inkl. Bewölkungsanzeige).
- **Ambient-Hintergrund-Schalter** von der Kopfzeile in die Einstellungen
  verschoben.

## 1.16.8

- **Update-Hinweis aus GitHub.** Das Plugin prüft die GitHub-Releases auf eine
  neuere Version als die installierte. Ist eine verfügbar, zeigt das
  Versions-Badge oben einen Punkt; ein Klick darauf öffnet die **Updates**-Seite
  mit Hinweis und Link zum Release. Quelle/Releases sind dort verlinkt.
- **Neue Einstellungen-Kachel „Logs & Debug".** Live-Connect-Protokoll
  (Level-Filter, Auto-Refresh, Download), alle Diagnose-Endpunkte als Roh-JSON
  (Kopieren/Download) und Build-Infos — gebündelt für Fehlersuche/Bug-Reports.
- **Hilfe als kompakter Überblick.** Statt eines langen Handbuchs jetzt alle
  Funktionen gruppiert mit je einer kurzen Erklärung und Suchfeld.

## 1.16.7

- **Fix: SPA-Fallback fürs Routing.** Ein Neuladen oder Direktaufruf eines
  Tabs (z. B. `/forecast`, `/bewaesserung`) lieferte serverseitig ein
  404-JSON statt der App, weil es keinen History-Fallback gab. Ein
  `setNotFoundHandler` liefert jetzt für GET-HTML-Navigationen (nicht `/api/`)
  `index.html` aus → Aktualisieren und Deep-Links funktionieren auf jedem Tab.

## 1.16.6

- **Diagramme: interaktiver Dive-Deep + keine Verzerrung mehr.** Der SVG-Chart
  misst jetzt seine echte Breite und rendert **pixelgenau (1:1)** statt mit
  `preserveAspectRatio="none"` horizontal gestreckt zu werden — Kurven,
  Beschriftungen und Stroke-Breiten sind scharf, auch im Vollbild. Beim
  Überfahren erscheinen ein **Fadenkreuz, Punkte je Serie und ein
  Werte-Tooltip** (Zeit + Wert je Linie) — in der Kachel und im Deep-Dive.
- **Einheitliche Karten-Titel über alle Tabs.** `<h3>`-Kartentitel hatten den
  Standard-Browser-Außenabstand → großer Leerraum über der Überschrift. Jetzt
  einheitlich zurückgesetzt; konsistente Schriftgröße/Gewicht.
- **Wetter-Tab:** Die **Wind-Kachel füllt die Höhe des Regenradars** und zeigt
  zusätzlich die **Bewölkung**.

## 1.16.5

- **Planer reagiert sofort.** Änderungen am Tagesplan (Verschieben, Dauer,
  An/Aus, Hinzufügen, Löschen) werden jetzt **optimistisch** lokal angezeigt,
  statt auf die nächste Server-Aktualisierung (Snapshot-Poll) zu warten — kein
  spürbares Nachladen mehr. Schlägt eine Änderung serverseitig fehl (z. B.
  Überschneidung), wird sie automatisch zurückgesetzt.
- **Dauer-Dropdown korrekt.** Zeigte den falschen Wert, wenn `durationMin` kein
  Listenwert war (Auto-Einträge mit krummen Minuten). Das aktuelle Maß wird nun
  immer als Option geführt; Auto-Dauern werden auf 5-Minuten-Schritte gerundet.

## 1.16.4

- **Fix:** Der Bewässerungsplan wurde ausgeführt, obwohl die automatische
  Bewässerung **ausgeschaltet** war. `runPlan` prüfte den Hauptschalter
  (`irrigation.enabled`) nicht. Fällige Plan-Einträge werden jetzt nur noch
  dispatcht, wenn die Automatik an ist — die Plan-Vorschau bleibt unabhängig
  davon sichtbar.

## 1.16.3

- **Wetter-Tab komplett überarbeitet.** Einheitliche Karten-Überschriften
  (vorher mischten sich kleine GROSSBUCHSTABEN-Labels und fette Titel) und eine
  sinnvolle Reihenfolge:
  1. DWD-Warnungen, 2. Aktuelle Werte, 3. Wettervorhersage – Nächste 24 Stunden,
  4. Regenradar + Wind, 5. Diagramme, 6. Gemessen vs. Prognose, 7. Verlauf.
  Die haus-bezogenen Abschnitte (Innenraum-Prognose, Wirkung) stehen jetzt klar
  abgetrennt am Ende statt mitten im Wetter.

## 1.16.2

- **Planer erzwingt „nur ein Ventil gleichzeitig".** Geplante Bewässerungen
  dürfen sich nicht mehr zeitlich überschneiden: Verschieben/Hinzufügen mit
  Überschneidung wird abgelehnt (mit Hinweis im UI), Auto-Einträge weichen beim
  Seeden automatisch auf den nächsten freien Slot aus.
- **Drag flüssiger.** Die Track-Geometrie wird beim Greifen einmalig gecacht
  (kein `getBoundingClientRect` pro Mausbewegung) und es wird nur bei echter
  Positionsänderung neu gerendert.
- **Blaue Linie beschriftet.** Die Kurve in den Zonen-Karten ist die
  Bodenwasser-Prognose (verfügbares Wasser, nächste ~3 Tage) und trägt jetzt
  Label + Tooltip.

## 1.16.1

- **Fix:** Der Bewässerung-Tab ließ sich nicht mehr öffnen und zeigte nur
  „Something went wrong. Fragment is not defined". Ursache war ein fehlender
  `Fragment`-Import bei der JSX-Kurzform `<>…</>`. Behoben in `irrigationZones.tsx`
  und im ebenfalls betroffenen `updates.tsx` (Build-Kennung).

## 1.16.0

- **Bewässerung überarbeitet (UX + Steuerung):**
  - **Automatik-Schalter** direkt oben im Bewässerung-Tab (schaltet
    `irrigation.enabled`) – erklärt sofort, warum gerade nichts läuft.
  - **Dauer-Auswahl** beim manuellen „Bewässern": 5–60 min in 5-min-Schritten
    statt fixer Default-Laufzeit.
  - **Editierbarer Tagesplan**: geplante Bewässerungen pro Eintrag per Drag
    verschieben (Zeit), Dauer ändern, an/aus, löschen und neue hinzufügen –
    auf einer 24-h-Zeitleiste je Tag. Auto-Einträge kommen aus dem Forecast;
    sobald editiert, bleiben sie fix. Die Engine führt die Einträge zur
    geplanten Zeit aus (STORM-gesperrt, immer nur ein Ventil gleichzeitig).
  - **Boden-Kalibrierung pro Zone**: der tatsächliche Bodenwasser-Stand lässt
    sich setzen, damit das offene Modell nach dem Anlegen nicht fälschlich
    „voll" (Defizit 0) annimmt.
  - **Eigene Gardena-Sensor-Kachel** (Bodenfeuchte/-temperatur/Licht/Batterie);
    die Mäher-Kachel ist entfallen.
  - **Ventile in den Einstellungen deaktivierbar** – deaktivierte Ventile
    verschwinden aus der Bewässern-Ansicht und werden nie automatisch
    gesteuert.
  - Nur **eine Bedien-Ebene** (Zonen): die rohe Ventil-Liste entfällt zugunsten
    der Zonen-Karten.
- **Modus verschiebt den Auslöse-Zeitpunkt** (`triggerBias`): Eco gießt später,
  Hitze/Anwuchs früher – vorher wirkte der Modus nur auf die Wassermenge.
- **Durchgängig deutsche, konsistente Begriffe** in allen Tabs (Diagnose,
  Automatik, Einrichtungs-Assistent, Lade-/Speicher-Hinweise).

## 1.15.0

- **Bewässerung im Vollausbau (Stufe 0–4).** Aus der manuellen Ventilsteuerung
  wird eine vollwertige, vorausschauende Wassersteuerung:
  - **ET-Wasserbilanz (FAO-56) pro Zone**: `Depletion += ETc − effektiver
    Regen − Bewässerung`; gegossen wird, wenn das nutzbare Wasser (RAW)
    erschöpft ist, exakt bis Feldkapazität. ET0 + Bodendaten kommen von
    Open-Meteo (`et0_fao_evapotranspiration`, Bodenfeuchte/-temperatur).
  - **Lern-Algorithmus**: kalibriert pro Zone den Pflanzenkoeffizienten (Kc)
    und die Emitter-Abgabe aus der gemessenen Bodenfeuchte-Antwort und erkennt
    defekte Emitter (Wasser ohne Feuchteanstieg).
  - **Forecast-Modell**: projiziert die Bodenfeuchte über 72 h, zeigt die
    nächste Gabe (ETA) und den Verlauf je Zone.
  - **Zonen** mit Pflanzen-/Boden-/Emitter-/Hang-Profil, Gardena-Ventil und
    optionalem Bodenfeuchte-Sensor (Closed Loop).
  - **Gates**: Regen-Skip (aktuell + Prognose), Frost-/Wind-Sperre,
    Zeitfenster, Tages-/Gesamtbudget, Mindestpause, Feuchte-Obergrenze,
    Cycle-and-Soak gegen Abfluss, Ventil-Sequenzierung (Flow-Limit),
    PV-bevorzugtes Gießen, Mähroboter-Koordination und Pumpen-Steckdose.
  - **UI**: Live-Zonen-Kacheln mit Feuchte-Gauge, Wasserbilanz, „Warum",
    Forecast-Sparkline und Bewässern/Stopp/Heute-aus im Bewässerung-Tab; neue
    Zonen-Verwaltung unter **Einstellungen → Bewässerung**.
  - **Bodenfeuchtesensor-Fix**: Gardena-Dienste werden nicht mehr nach Typ
    verworfen — der Sensor wird über seine Messwerte erkannt und zuverlässig
    angezeigt (Boden-Temperatur des Sensors fließt in Frostschutz + Anzeige).
  - **Nur ein Ventil gleichzeitig**: auf der gemeinsamen Wasserversorgung ist
    immer höchstens ein Ventil offen (fest erzwungen, auch manuell).
  - **Ventil-Zeiten**: Zeitfenster (von–bis) und „offen bis"-Uhrzeit je Zone
    sichtbar. **Ungenutzte Ventile ausblendbar**. „Gardena verbinden" liegt
    jetzt unter Einstellungen → Bewässerung.

## 1.14.0

- **Gardena direkt im Plugin integriert.** Heat Shield spricht jetzt selbst
  mit dem GARDENA smart system über deinen eigenen API-Zugang
  (Application Key + Secret, OAuth2 client-credentials gegen
  `api.smart.gardena.dev`). Ein separates Gardena-Connect-Plugin auf der HCU
  ist nicht mehr nötig.
  - Liest **Bodenfeuchte, Boden-/Umgebungstemperatur und Lichtintensität** der
    Sensoren und steuert **Ventile** (Bewässern/Stopp) direkt über die Cloud.
  - **Live-Updates per WebSocket** mit automatischem Reconnect; Token-Refresh
    inklusive.
  - Einrichtung im **Bewässerung-Tab**: „Gardena verbinden" mit Application
    Key/Secret, optionaler Location-ID, Standard-Bewässerungsdauer und einem
    **„Verbindung testen"**-Button. Das Secret wird wie der Telegram-Token
    maskiert gespeichert und nie geloggt.
  - Bereits über die HCU eingebundene Gardena-Geräte werden weiterhin als
    Fallback erkannt.

## 1.13.0

- **Benachrichtigungen sind eine eigene Kachel.** Die Telegram-Einrichtung
  (Bot-Token, Chat-ID, Chat-Befehle, Steuer-Freigabe, erlaubte Chat-IDs),
  Morgen-Briefing, Ereignis-Schalter, Abend-Rückblick und die regelmäßigen
  Wetter-Updates sind aus dem Automation-Tab in eine neue Kachel
  **„Benachrichtigungen"** unter **Einstellungen** umgezogen.
- **Wetter-Tab: kompaktere Windrose.** Die Windrose ist kleiner; direkt
  darunter sitzt ein **Wind-Ausblick** (max. Böen heute/morgen, Hauptrichtung).
- **Mehr Diagramme & Dive-Deep.** Neuer Bereich **„Wettervorhersage ·
  Diagramme"** mit aufklappbaren Charts für Temperatur & gefühlte Temperatur,
  Niederschlag, Regenwahrscheinlichkeit, Bewölkung, Wind & Böen,
  Globalstrahlung, UV-Index, Luftdruck und Luftfeuchte (umschaltbar 24 h/48 h)
  sowie eine 7-Tage-Temperaturkurve (Min/Max). Jedes Diagramm lässt sich groß
  öffnen.
- **Umbenennung.** „Forecast – Nächste 24 Stunden" heißt jetzt
  **„Wettervorhersage – Nächste 24 Stunden"**.

## 1.12.0

- **Wetter-Tab — Regenradar überarbeitet.** „Aktuelle Werte" sitzt jetzt über
  dem Regenradar. Der Radar nutzt eine **dunkle Karte** (CARTO „dark") passend
  zum dunklen Glass-UI. Regen wird mit einem **kräftigen Farbschema** bei hoher
  Deckkraft dargestellt; zusätzlich gibt es einen **zuschaltbaren Wolken-Layer**
  (Infrarot-Satellit) mit „Wolken"-Button, sodass Regen und Wolken deutlich
  sichtbar sind.
- **Bewässerung — volle Gardena-Anbindung mit Steuerung.** Gardena-Geräte, die
  über das Gardena-Connect-Plugin in die HCU eingebunden sind, werden jetzt live
  angezeigt: **Bodenfeuchte, Bodentemperatur und Lichtintensität** je Sensor
  sowie **Ventile, die sich direkt ein-/ausschalten lassen** (Bewässern/Stopp).
  Native Steuerung läuft über `HmipSystemRequest setSwitchState`. Die
  automatische Bewässerungsplanung anhand von Niederschlag, Bodenfeuchte, Sonne
  und Temperatur ist als nächster Schritt vorgesehen.

## 1.11.0

- **Wind systemweit in km/h.** Alle Wind-Anzeigen (Windrose, KPI-Kachel,
  Automatik-Erklärung, Sturm-Schwelle, Hilfe) zeigen km/h. Intern rechnet die
  Engine weiterhin in m/s.
- **Wetter-Tab umgebaut.** „Forecast – Nächste 24 Stunden" sitzt jetzt über dem
  Regenradar; der überflüssige Zwischentitel ist weg. Neue Karte **„Aktuelle
  Werte"**: UV-Index, Niederschlag (jetzt/heute), Luftdruck, Luftfeuchte,
  Sonnenauf-/-untergang (Open-Meteo, browserseitig). **DWD-Warnungen** erscheinen
  nur noch, wenn es aktive Warnungen gibt.
- **Neuer Tab „Bewässerung"** (links von „Wetter"). Fokus auf Regen,
  Niederschlagsmenge und Gewitter: KPIs (Regen jetzt, Summe/Wahrscheinlichkeit
  24 h, nächster Regen, Gewitterrisiko) und Diagramme (Niederschlag +
  Wahrscheinlichkeit 24 h, Tagessummen 7 Tage). **Gardena**-Anbindung ist als
  „geplant"-Platzhalter vorbereitet (API-Key folgt). Hinweis: in diesem
  Workspace existiert kein vorhandenes Gardena-Plugin zum Einlesen.

## 1.10.0

- **Neuer „Wetter"-Tab** (vormals „Forecast"). Drei neue Bausteine plus die
  bisherige Prognose/Verlauf:
  - **Regenradar** — natives Leaflet-Kartenfeld mit OSM-Basiskarte und
    animierten **RainViewer**-Radarframes (kostenlos, kein Key), Play/Pause +
    Zeit-Slider, Standort-Marker. Tiles werden browserseitig von OSM/RainViewer
    geladen; Leaflet ist gebündelt (kein CDN).
  - **Windrose** — SVG-Kompass mit Windrichtung, Geschwindigkeit (m/s + Beaufort)
    und Böen, direkt von Open-Meteo (browserseitig, CORS).
  - **DWD-Unwetterwarnungen** — amtliche Warnungen aus dem offiziellen
    DWD-Feed, serverseitig geproxyt (`/api/dwd-warnings`). Die Region wird über
    die DWD-Warncell-CSV vom Namen aufgelöst (Standard „Beispielstadt"); per
    `dwd.warncellId` überschreibbar. Farbcodierung nach Warnstufe 1–4.

## 1.9.1

- **Fix: Schloss-Symbol über dem Twin sichtbar.** Der Sperr-Schalter zeigte das
  Schloss-SVG kaum/nicht an, weil das Icon nur die geerbte Button-Farbe nutzte.
  Es bekommt jetzt eine explizit weiße Stroke-Farbe (`twin-iconbtn__glyph`),
  etwas mehr Größe (17 px) und einen feinen Schatten — analog zu den
  KPI-Kachel-Icons.

## 1.9.0

- **Vollständiges Hilfe-Handbuch.** Die „Hilfe" wurde von einer Kurzfassung zu
  einem kompletten Handbuch ausgebaut: nach Kategorien (Grundlagen, Bedienung,
  Regelungslogik, Konfiguration, Erweitert, Referenz &amp; Hilfe) gruppiert, mit
  Volltextsuche über Titel/Schlagworte, allen acht Betriebsmodi inkl. echter
  Schwellwerte, einer kompletten Einstellwert-Referenztabelle (Default + Bereich),
  Glossar und FAQ/Fehlerbehebung.
- **Weitere eigene SVG-Icons.** „Einstellungen" nutzt jetzt ein echtes Zahnrad
  (statt des sonnenähnlichen Symbols); der Sperr-Schalter über dem Twin ist ein
  Schloss-SVG (geschlossen/offen) statt Emoji.

## 1.8.9

- **Eigene SVG-Icons (Test).** Die KPI-Kacheln (PV-Leistung, Innen-/
  Außentemperatur, Sonnenstand, Hitze-Index) nutzen statt Emoji jetzt eigene
  weiße Linien-SVGs mit transparentem Hintergrund (über die bestehende
  `Icon`-Komponente, `currentColor` → weiß). Erster Schritt; bei Gefallen lassen
  sich Twin-Toolbar, Modus-Header und Nachrichten genauso umstellen.

## 1.8.8

- **Sommer-Beobachtung früher aktiv.** Die SUMMER_WATCH-Schwellen wurden gesenkt:
  Tagesprognose ≥ 20 °C (vorher 24 °C) und Außentemperatur ≥ 18 °C (vorher
  22 °C); PV-Trigger unverändert > 2,0 kW. Die Werte sind nicht im UI editierbar,
  daher werden bestehende `/data/config.json` beim Laden automatisch von den
  alten Default-Werten (24/22) auf die neuen (20/18) angehoben (idempotent,
  wertgenau — nur exakte Alt-Defaults werden ersetzt).
- **Automatik-Logik ohne Dopplung.** Die Begründung erschien doppelt
  („Ausschlaggebend …" plus identischer Reason-Chip). Die Chips werden jetzt nur
  noch gezeigt, wenn es keine einzelne „Ausschlaggebend"-Zeile gibt; die volle
  Herleitung bleibt hinter dem ⓘ.
- **„Nächste Aktionen" transparent.** Die Aktions-Zeilen hatten einen opaken
  Hintergrund (`--color-bg-elev`), der nicht zum Glas-Panel passte; sie nutzen
  jetzt die durchscheinende Glas-Optik.

## 1.8.7

- **Einheitliches UI — alle Kacheln angeglichen.** Sämtliche Karten/Kacheln über
  alle Tabs nutzen jetzt EINE kanonische Glas-Oberfläche (identischer
  Hintergrund, Rahmen, Eck-Radius 14 px und Schatten), zentral über die
  Glass-Tokens und eine gemeinsame Surface-Regel gesteuert. Fenster-, Raum-,
  KPI-, Analyse-, Forecast- und Automatik-Karten sind damit deckungsgleich;
  abweichende Radien (8/10/16/20 px) und der dicke Forecast-Rahmen sind weg.

## 1.8.6

- **Modernes 3D-Glass-UI-Overhaul.** Über alle Tabs hinweg: top-belichteter
  Glas-Schliff (Sheen), mehrlagige Tiefen-Schatten für echte Elevation und ein
  sanftes Anheben interaktiver Karten beim Hover. Glas-Icon-Buttons mit
  Hover-/Druck-Effekt, aktiver Tab mit Verlauf + Glow, einheitlich aufpolierte
  Forecast-, Automatik-, Detail- und Deep-Dive-Panels. Zentral über die
  Glass-Design-Tokens gesteuert; `prefers-reduced-motion` wird respektiert.

## 1.8.5

- **Stauschutz-Grenze auch in der Vorschau.** Der Forecast-Planner deckelt das
  Schließen jetzt schon bei der Planung auf die Heat-Stau-Grenze (Fassade 95 %,
  Dachfenster 100 %, per-Fenster-Override). Dadurch zeigen „Nächste Aktionen",
  die Twin-Rollo-Prognose und die Heatmap nicht mehr fälschlich 100 % für
  Fassaden — der Plan entspricht jetzt exakt dem, was die Engine tatsächlich
  fährt (der Live-Befehl war schon immer auf 95 % gekappt).
- **Haus-Twin auf Standard zurücksetzen.** Der ↺-Knopf in der Twin-Leiste setzt
  jetzt die komplette Ansicht zurück: Badge-Anordnung (Auto-Layout), Sperre,
  Wärme-Ansicht und Legende.
- **Forecast-Panel mit großer Umrandung.** „Forecast – Nächste Stunden" hat eine
  deutliche Rahmen-Umrandung; die Kacheln darin sind transparent (Glas, kein
  gefüllter Tile-Look).

## 1.8.4

- **Raum-Popup im Twin nicht mehr abgeschnitten.** Das Detail-Popup beim Klick
  auf ein Raum-Badge wurde bisher von der Twin-Kachel (`overflow: hidden`)
  beschnitten. Es rendert jetzt frei über dem Dashboard (Portal in den
  `document.body`), positioniert sich automatisch ober- oder unterhalb des
  Badges, klemmt sich vollständig in den sichtbaren Bereich und scrollt bei
  Bedarf — es ist also immer komplett sichtbar.

## 1.8.3

- **Twin-Rollo-Prognose an die echten Planner-Ziele gekoppelt.** Die 12-h-
  Vorschau im Haus-Twin ist jetzt eine Stufenfunktion aus den geplanten
  Aktionen (aktuelle Position bis zur geplanten Fahrt, dann deren Ziel; auf
  95 % Fassade / 100 % Dachfenster gedeckelt) — also exakt das, was die Engine
  fahren wird.
- **Fix der unsinnigen „0 % in 2–3 h"-Vorschau.** Die alte, aus der
  Wärmelast abgeleitete Vorschau war eine Rückkopplungsfalle: geschlossene
  Rollläden → wenig modellierte Solarlast → Vorschau „öffnen", obwohl es
  Hochsommer-Mittag mit 34 °C und 800 W/m² war. Die neue Kopplung zeigt
  korrekt, dass die Rollläden geschlossen bleiben.

## 1.8.2

- **Forecast-Leiste mit Glas-Panel.** „Forecast – Nächste 12 Stunden" sitzt
  jetzt auf einer frostigen Glas-Fläche; die Kacheln sind leichte Tiles darauf.
- **Hintergrund weicher.** Der grobe Punkt-Noise (wirkte wie ein Teppich)
  wurde entfernt; stattdessen ein weicher, satter Mehrfach-Verlauf.
- **Rollo-Prognose im Twin** nutzt jetzt dieselbe feine 8-Stufen-Leiter wie die
  Live-Engine (vorher die alte grobe 5-Stufen-Abbildung).

## 1.8.1

- **Fix:** Deep-Dive-Diagramme (Vergrößern) wurden in eine Ecke gequetscht
  statt zentriert und groß angezeigt. Ursache: Glas-Karten mit
  `backdrop-filter` erzeugen für `position: fixed` einen eigenen
  Bezugsrahmen. Die Overlays (Chart-Vergrößerung, Raum-Detail) werden jetzt
  per Portal an den `document.body` gehängt und erscheinen korrekt fast im
  Vollbild.

## 1.8.0

Regelung (Engine):
- **Konservativ bei fehlenden Sensoren:** fehlt ein Messwert, werden die
  Risiko-Gewichte auf die vorhandenen Faktoren renormiert, statt den Score
  Richtung „nicht beschatten" zu ziehen.
- **Feinere 8-stufige Risiko→Rollo-Leiter** (0/15/30/45/60/75/90/100 %).
- **PV-Faktor an der echten Anlagen-Ausrichtung** (weiche Cosinus-Gewichtung
  um die konfigurierte Azimut-Richtung statt harter 90–200°-Lobe).
- **Richtungsabhängige Hysterese:** Schließen (Schutz) reagiert schneller,
  Öffnen träger (Schließ-Eile-Faktor).
- **Konfigurierbare Modus-Schwellen** (°C/kW).
- **Forecast-getriebene Vorkühl-Empfehlung** im Klima-Tab (PV-Überschuss +
  Hitzeprognose).
- **Prognosegüte-Metrik** (mittlerer Fehler vorhergesagter vs. tatsächlicher
  Innen-Peak) in der Wirkung-Übersicht.

UI:
- **Helleres Standard-Theme** mit stärkerem Farbverlauf und dezenter Noise;
  **Ambient ist jetzt standardmäßig AUS**.
- **Deep-Dive-Diagramme** öffnen fast im Vollbild (zentriert, große Charts).
- **Automatik-Tab** mit vollständiger technischer Live-Berechnung (Modus-
  Kaskade, Risiko je Fenster, Caps, Sperren); Beschattungs-Erklärung nur noch
  über das ⓘ.
- **Einstellungen:** neue Kacheln **Updates** (Changelog) und **Hilfe**
  (ultra-detaillierte Funktionsbeschreibung).
- Forecast-Tab ohne „Nächste Aktionen"; Zyklusintervall bis 60 min,
  Mindestpause zwischen Fahrten bis 6 h.

## 1.7.0

- **Deep-Dive-Verläufe im Lüftung- und Klima-Tab.** Beide Tabs zeigen jetzt
  „Verlauf"-Diagramme (Innen-/Außentemperaturen bzw. PV-Leistung) mit dem
  gleichen Klick-zum-Vergrößern wie der Forecast-Tab — so gibt es auf allen
  Tabs eine Detailansicht für die Daten.

## 1.6.0

- **Echte, ausführliche Automatik-Erklärung.** Der Info-Knopf der
  Automatik-Logik öffnet jetzt eine detaillierte Begründung statt doppelter
  Kurzinfos: aktuelle Messlage (Außen, Tagesprognose, PV, Wind, Strahlung,
  wärmster Raum), der konkrete Auslöser, was der Modus bedeutet, welche
  Fahrten geplant sind und welche Übersteuerungen aktiv sind – plus
  Modus-Glossar und Komfortindex.
- **Versionsanzeige.** Die laufende Version steht jetzt klein im Kopf neben
  „Heat Shield".
- **24-h-Forecast scrollt sauber.** Die Kachelleiste hat eine sichtbare
  Scroll-Leiste mit Snap und funktioniert auch ohne Scrollen auf schmalen
  Screens; im Vollbild scrollt breiter Inhalt horizontal.
- **Deep-Dive überall.** Auch die KPI-Verläufe (PV, Innen, Außen) lassen sich
  per Klick zu einem großen Zeitreihen-Diagramm aufziehen.
- **Glas / Glow / 3D-Feinschliff.** Ganzheitlicher Premium-Look über alle
  Tabs: dezente Hover-Tiefe, Akzent-Glow, Glas-Lichtkanten und abgestimmte
  Verläufe.

## 1.5.0

- **Ruhezeiten & Zeitpläne.** Neue globale **Ruhezeit** (Automatik-Tab): in
  einem festen Zeitfenster fährt das Plugin keine Rollläden automatisch. Dazu
  **pro Raum** „Fahrten nur zwischen X und Y Uhr" (Räume-Tab). **STURM
  überstimmt** beide immer (höchste Priorität).
- **Voll-Backup / Restore.** Der Diagnose-Tab exportiert jetzt Konfiguration
  **plus** gelernte Beschattungs-Effekte (`learning.ndjson`) und thermische
  Kalibrierung (`calibration.ndjson`) in **einer** Datei und stellt sie
  wieder her (`GET`/`POST /api/backup`). Token bleibt maskiert/erhalten.
- **Pro-Raum-Detailansicht.** Klick auf „Detailansicht öffnen" im Raum-Popover
  bzw. der mobilen Zeile zeigt Verlauf (letzte 12 h), Rollo-Prognose,
  Wärmerisiko-Faktoren und den Lern-/Kalibrier-Status des Raums.
- **Erstinbetriebnahme.** Solange noch kein Raum angelegt ist, führt ein
  freundlicher Leerzustand in drei Schritten (Quellen → Räume → Assistent)
  durch die Einrichtung statt leerer Panels.

## 1.4.0

- **Forecast-Tab zeigt 24 h.** Die Wetter-Vorschau und die Aktionsliste decken
  jetzt die nächsten 24 statt 12 Stunden ab.
- **Kombinierte „12 h zurück + 12 h voraus"-Diagramme.** Temperatur und
  PV-Leistung zeigen den gemessenen Verlauf (durchgezogen) nahtlos
  weitergeführt als Prognose (gestrichelt) mit „Jetzt"-Linie. Die erwartete
  PV-Leistung wird aus der Strahlungsprognose und der installierten
  Spitzenleistung geschätzt.
- **Deep-Dive in allen Diagrammen.** Jedes Diagramm hat einen Vergrößern-Knopf,
  der es in einem großen Overlay mit feinerer Achsenbeschriftung öffnet.
- **Forecast-Kacheln auf volle Stunden gerastet.** Start- und Forecast-Seite
  zeigen die Kacheln zu vollen, geraden Uhrzeiten (00, 02, 04 …) statt zur
  krummen aktuellen Minute.
- **Dunkleres, stärker mattiertes Glas-Design.** Tieferer Hintergrund (Ambient
  und Normal), mehr Blur, Transparenz und abgestimmte Farbverläufe über alle
  UI-Elemente. Der Schlagschatten im Haus-Twin ist deutlich kräftiger.

## 1.3.0

- **Wirkungs-Dashboard (Forecast-Tab).** Neue „Wirkung"-Karten machen den
  Nutzen des Plugins messbar: **Komfort heute gehalten** (Anteil der Zyklen
  ohne Raum über seiner Warnschwelle), **Ø Fahrten/Tag**, **PV-Eigenverbrauch**
  und **selbstlernende Tage** (Lern-/Kalibrier-Status).
- **Konfidenz-bewusste Steuerung.** Bei unsicherer Prognose
  (`confidence01` niedrig) hebt der Planer die Komfort-Obergrenze um eine
  Unsicherheits-Marge (bis +1 K) an und greift damit **weniger aggressiv** ein
  → weniger Fehlfahrten bei wechselhaftem Wetter.
- **Echte Unwetterwarnungen.** Zusätzlich zur reinen Windschwelle scannt das
  Plugin die Open-Meteo-Prognose der nächsten 6 h auf **Severe-Weather
  (WMO-Codes ≥ 95 Gewitter, Starkregen, Graupel/Hagel)** und meldet eine
  entprellte `severe-weather`-Warnung.
- **Tagesreport erweitert.** Der tägliche Bericht nennt jetzt zusätzlich die
  **Fahrten des Tages, den Innen-Peak** und die Anzahl der aktiven
  **Lern-/Kalibrier-Anpassungen**.
- **Manuelle Übersteuerung im Haus-Twin.** Im Raum-Popover lässt sich das
  Rollo direkt per **Slider + Auf/50 %/Zu** setzen (Fassade max. 95 %
  Stauschutz, Dachfenster bis 100 %) — bisher nur im Live-Tab möglich.
- **Mobile Haus-Twin als Tabelle.** Auf Phone-Breite (≤ 640 px) ersetzt eine
  kompakte, antippbare **Raum-Tabelle** den räumlichen 3D-Twin (dessen absolut
  positionierte Badges auf schmalen Screens zerfielen). Jede Zeile zeigt
  Rollo-Glyph + %, Innentemperatur mit Trend, Status und offenes Fenster; Tippen
  klappt Details samt manueller Steuerung auf.

## 1.2.0

- **Ganzheitlicher UI-Rework — Glas & Ambient.** Alle Tabs nutzen jetzt
  **frostige Glas-Oberflächen** (Blur, feine Lichtkante, weicher Schatten) mit
  dezentem Glow auf Akzenten und abgestimmten Farbverläufen — ein moderner,
  durchgängiger Look.
- **Ambient-Modus (Header-Schalter, an/aus, gespeichert).** Der **gesamte
  Dashboard-Hintergrund** verläuft dynamisch nach **Tageszeit und Wetter**
  (Tag/Dämmerung/Nacht/Sturm, bewölkt entsättigt); die Glaselemente schweben
  darüber → „deutlicher dynamischer Verlauf unter den Glaselementen".
- **Haus-Twin-Kopfzeile minimal & einzeilig.** Nur noch Schutz-Score,
  12-h-Wetter und Ø Rollo plus kompakte **Icon-Knöpfe** (Wärme/Legende/Sperre/
  Zurücksetzen) — keine mehrzeilige, überladene Leiste mehr.
- **Zeitstrahl-Leiste unter dem Twin entfernt.** Die Sonnen-/Uhrzeit-Anzeige
  steckt bereits im 3D-Twin (Sonnenbogen); die separate Leiste war redundant.
- Reine, getestete Ambient-Logik (`dashboard/spa/ambient.ts`).

## 1.1.0

- **Thermische Selbst-Kalibrierung (Engine).** Das Plugin erfasst jetzt täglich
  je Raum den **vorhergesagten** und den **tatsächlichen** Innentemperatur-Peak
  (`/data/calibration.ndjson`) und justiert daraus die **thermische Trägheit**
  des Forecast-Modells automatisch: lief der Raum heißer als vorhergesagt →
  reagiert er schneller → Trägheit wird gesenkt; blieb er kühler → erhöht.
  Die Korrektur ist begrenzt (Faktor 0,5–2,0, Trägheit 30–600 min) und wird
  langsam nachgeführt, damit ein einzelner Ausreißer-Tag die Steuerung nie
  destabilisiert. Ergebnis: die 12-h-Prognose und damit der bewegungsminimale
  Plan werden Tag für Tag genauer. Die Anpassung erscheint in der Lern-Karte.
  Reine, property-getestete Funktion (`engine/learning/thermalCalibration.ts`).
- **Forecast-Tab neu (Prognose & Verlauf).** Oben die Vorschau der nächsten
  12 h (Wetter-Zeitleiste, Innentemperatur-Prognose mit/ohne Beschattung,
  Wärmelast-Prognose), darunter die bisherigen Verlaufscharts mit
  Bereichsumschalter — alles im Premium-Kartenlook.
- **Automation-Tab neu.** Führt jetzt mit der **Automatik-Logik** (welcher
  Modus aktiv ist und welcher Faktor ihn ausgelöst hat), darunter Profile,
  Schwellen, Benachrichtigungen und Erweiterungen im Karten-Design
  (segmentierter Profilschalter, Akzent-Slider).

## 1.0.0

Erste stabile Version. Schwerpunkt dieses Release: Haus-Twin „premium" und
voll mobiltauglich, plus ein vorausschauenderes Lernmodul.

- **Haus-Twin überarbeitet (Premium, entwirrt).**
  - Die komplette Steuerleiste (Schutz-Score, 12-h-Wetter-Sparkline, Ø Rollo,
    offene Fenster, wärmster Raum sowie die Knöpfe) sitzt jetzt in einer
    eigenen **Kopfzeile über** dem Haus statt als Overlay darauf — das Hausbild
    bleibt ruhig.
  - **Keine Neon-Heatmap mehr:** „Wärme" tönt die Badges jetzt dezent
    (sanfter Innen-Farbton statt grell leuchtender Ränder).
  - **Kompaktere Badges** in einem zentralen Band; sie überlappen die
    Fassaden-Karten nicht mehr und crowden weniger.
  - Chips/Knöpfe nutzen Theme-Farben (auch im Hell-Modus sauber).
- **Voll mobiltaugliches Layout.** Im Hochformat führt das Haus (Hero), darunter
  die Live-KPIs als responsives Raster, dann die Analyse. Die Modulnavigation
  ist eine horizontal scrollbare Leiste; Abstände, Badges und Popover sind für
  Telefone verkleinert.
- **Module im Premium-Kartenlook.** Lüftung, Klima und der Einstellungs-Hub
  haben Karten mit Akzentleiste, Schatten und Hover-Lift bekommen.
- **Lernmodul vorausschauender.** Es berücksichtigt jetzt den **solaren
  Eintrag je Raum** (wie weit der Innen-Peak an heißen Tagen über dem Außen-Max
  liegt) und beschattet stark aufheizende Räume bis zu 0,3 K früher — bleibt
  dabei in den Grenzen [−1,5 … +1,0] K. Neue Tests dafür.
- **Schnellerer Kaltstart** (0.9.3): erste Regelrunde ~8 s nach Start, damit das
  Dashboard sofort Heatmap, 12-h-Prognose und geplante Aktionen zeigt.

## 0.9.3

- **Schnellerer Kaltstart.** Das Plugin rechnet jetzt ~8 s nach dem Start eine
  erste Regelrunde, statt bis zu `controlIntervalSeconds` (≤ 300 s) zu warten.
  Vorher war das Haus-Dashboard direkt nach einem (Neu-)Start „kalt": keine
  Wärme-Heatmap, keine 12-h-Rollo-Prognose, keine geplanten Aktionen, weil der
  `Forecast_Planner` noch kein Ergebnis geliefert hatte (`lastPlannerResult`
  undefiniert). `runCycleInner` lädt `getSystemState` zu Beginn selbst, daher
  ist der Cache auch bei der frühen Runde warm. (Diagnose über die Live-HCU:
  `/api/forecast` lieferte Trajektorien, `/api/state` aber noch leere
  `heatLoad01`/`shutterForecast` — exakt das Startfenster.)
- **Quellen-Discovery robuster.** Der `POST /api/sources/discover`-Aufruf der
  SPA sendet jetzt explizit `application/json` mit leerem Body `{}`, damit
  strikte HTTP-Clients keinen `415 Unsupported Media Type` mehr bekommen.
- **Haus-Twin aufgeräumt (weniger „durcheinander").** Die Steuerleiste
  (Schutz-Score, 12-h-Wetter, Ø Rollo, offene Fenster, wärmster Raum sowie die
  Knöpfe Wärme/Legende/Sperre/Zurücksetzen) sitzt jetzt in einer eigenen
  Kopfzeile **über** dem Haus statt als Overlay darauf — das Hausbild bleibt
  ruhig. Raum-Badges liegen in einem zentralen Band (20–80 %) und überlappen
  die Fassaden-Karten nicht mehr; kompakteres Glas-Design. Chips/Knöpfe nutzen
  Theme-Farben (auch im Hell-Modus sauber).

## 0.9.2

- **Haus-Twin — Premium-Politur.**
  - **Live-Tag/Nacht-Himmel**: Hintergrund-Verlauf färbt sich nach Sonnenstand
    (Tag, goldene Stunde, Dämmerung, Nacht) und wandert beim Scrubben mit.
  - **Sonnenstrahlen + Bodenschatten**: feiner Strahlenkranz an der Sonne,
    weicher Schlagschatten des Hauses (Richtung/Länge nach Sonnenstand).
  - **Weiche Übergänge**: Innentemperatur und Rollo-% zählen animiert hoch,
    Badges gleiten beim Umordnen, laufende Rollo-Animation während einer Fahrt.
  - **Schutz-Score-Ring** und **12-h-Wetter-Sparkline** in der Twin-Leiste.
  - **Detail-Popover erweitert**: 12-h-Rollo-Prognose als Sparkline + Balken
    der Wärmerisiko-Faktoren (Sonne, Raumtemp., PV, …) je Raum.
  - **Fassaden-Karten** zeigen den aktuellen **Sonnen-Einfallswinkel** (☀-Marker).
  - **„Heute"-Zeitstrahl** unter dem Haus mit Taglicht-Band, geplanten Fahrten
    und scrubbarem Jetzt-/Vorschau-Marker (gekoppelt an den Sonnenbogen).
  - **Skeleton-Ladeansicht** statt nacktem „warte auf Daten".
  - **Haptik** beim Verschieben/Sperren (sofern vom Gerät unterstützt).
- **Theming & Barrierefreiheit.** Automatischer **Hell-Modus** über
  `prefers-color-scheme` (Akzentfarben bleiben gleich); **`prefers-reduced-motion`**
  schaltet nicht-essentielle Animationen ab. PWA-`theme-color` je Hell/Dunkel,
  neues, hochwertigeres App-Icon mit Verlauf.

## 0.9.1

- **Innenraum-Temperaturen bleiben zuverlässig stehen.** Der HCU-Quellen-Cache
  wird jetzt zu Beginn **jeder** Regelrunde (alle 180–300 s) frisch über
  `getSystemState` geladen, statt nur einmal beim Plugin-Start. Langsam
  meldende Geräte (Wandthermostate senden `actualTemperature` selten) liefen
  sonst zwischen zwei Push-Events in die Stale-Schwelle (600 s) und der Raum
  zeigte kurzzeitig keinen Wert (`tempC: null`). Betrifft alle nativen
  Signale, nicht nur die Innentemperatur. Schlägt die Aktualisierung fehl,
  läuft die Runde unverändert mit dem vorhandenen Cache weiter.
- **Haus-Digital-Twin — Premium-Redesign.**
  - Jeder Raum-Badge zeigt jetzt einen **Rollo-Glyph** (live: 0 % offen …
    95 % geschlossen) mit sichtbarem Stauschutz-Spalt, die
    **Innentemperatur + Trendpfeil**, einen **Status-Punkt** (geplant/fährt/
    blockiert/manuell) und einen **Fenster-offen-Marker**.
  - **Manuelle Anordnung per Drag and Drop** mit **Sperre** gegen
    versehentliches Verschieben (Standard: gesperrt) und „Zurücksetzen" auf
    die automatische Anordnung (Stockwerk × Himmelsrichtung). Die Anordnung
    wird pro Browser lokal gespeichert.
  - **Live-Insights** (Ø Rollo-Stand, Anzahl offener Fenster, wärmster Raum)
    und eine einklappbare **Legende**, die alle Symbole und die
    95 %/100 %-Konvention erklärt.
  - **12-h-Rollo-Prognose**: Beim Scrubben des Sonnenbogens fahren die
    Rollo-Glyphs auf die für die jeweilige Uhrzeit prognostizierte Position
    (aus dem thermischen Forecast, mit „P"-Markierung).
  - **Wärme-Heatmap** (Toggle „Wärme"): tönt jeden Badge nach prognostizierter
    Wärmelast (grün→gelb→rot).
  - **Detail-Popover** per Klick auf ein Badge: Innentemperatur + Trend,
    Rollo-Stand inkl. Prognose, Wärmelast, Fassade/Ausrichtung, Fensterstatus
    und nächste geplante Aktion mit Begründung.
  - **Frische-Indikator** pro Badge, wenn der Innentemperatur-Messwert veraltet
    ist oder kein Sensor zugewiesen wurde.
  - **Snap-to-Grid mit Hilfslinien** beim manuellen Verschieben.
  - Stärkste Fassade wird hervorgehoben; Sonnenbogen mit weichem Verlauf und
    Glow am Sonnen-Punkt.

## 0.9.0

- **Lern-Modul (C5).** Das Plugin sammelt jetzt täglich je Raum eine
  Beobachtung (Innen-Peak, Außen-/Forecast-Maximum, PV-Peak, Anzahl Fahrten)
  in `/data/learning.ndjson` und lernt Tag für Tag eine **begrenzte
  Komfort-Bias** ([−1,5 … +1,0] K): lief ein Raum an heißen Tagen im Schnitt
  über der Komfortgrenze, wird früher/stärker beschattet; blieb er deutlich
  darunter, gibt es mehr Spielraum für Tageslicht. Die Bias fließt direkt in
  den Forecast_Planner. Neue Dashboard-Karte „Lernen · Beschattungs-Effekt".
  Reine, property-getestete Lernfunktion (`engine/learning/shadeLearner.ts`).
- **Telegram-Warnungen.** Sturm, extreme Innen- (≥ kritisch) bzw. Außenhitze
  (≥ 35 °C) und hoher UV-Index (≥ 8) lösen eine Telegram-/In-App-Warnung aus
  (pro Tag entprellt, Sturm pro Episode).
- **Planer-Verhalten.** (a) Öffnet abends für Tageslicht, wenn über den
  Horizont keine Wärmelast mehr erwartet wird (PV ≈ 0) und Offen den Komfort
  hält; (b) wählt unter den komfortwahrenden Positionen die **offenste**
  (mehr Licht); (c) plant **keine** Fahrt, wenn der Rollladen bereits am Ziel
  steht (kein „auf 100 % stellen", wenn schon 100 %).
- **Dachfenster** werden im Wärmemodell als größtes Wärmerisiko stärker
  gewichtet (Faktor 1,3) und damit früher beschattet.
- **Forecast-Anzeige korrigiert.** Hitze-Schwellen und „Forecast"-Wert nutzen
  das **heutige** Tagesmaximum (nicht mehr morgen).
- **Haus-Twin-Anordnung.** Räume nach Himmelsrichtung W, SW, S, SO, O, NO, N,
  NW (links→rechts) und nach Stockwerk sortiert.

## 0.8.4

- **Monitoring-Endpunkt (C7).** Neuer `GET /api/metrics` liefert kompakten
  JSON-Status (Modus, Quellen-Health, Innen-/Außentemperatur, PV, geplante
  Aktionen, Lüftungs-/Kühl-Empfehlung, Uptime) für Grafana/Healthchecks —
  rein lesend, aus dem aktuellen Snapshot abgeleitet.
- **Code-Aufräumen.** Tote Haus-Asset-Funktionen (`houseAssetFor`/
  `shutterStateFor` in der Engine, `averageShutterPercent` im SPA), der
  ungenutzte Sonnenbogen-Simulations-Prop und die verwaiste
  `.twin-overlay__time`-CSS-Regel entfernt; der zugehörige Property-Test auf
  die `clearSkyPvKw`-Eigenschaft fokussiert.

## 0.8.3

- **Klima-Modul mit echter Kühlempfehlung (C2).** Das bisherige „geplant"-
  Modul gibt jetzt eine PV-überschussgesteuerte Empfehlung aus:
  „Jetzt kühlen (Solarstrom)" (Raum über Komfort + PV-Überschuss),
  „Kühlen nur mit Netzstrom" (heiß, aber kein Überschuss), „Vorkühlen mit
  Überschuss" (Vorkühlband + starker Überschuss + Hitze erwartet) oder
  „Keine Kühlung nötig". PV-Überschuss = Einspeisung (FusionSolar-Meter),
  ersatzweise Erzeugung. Neue Karte „PV-Überschuss". Reine, property-getestete
  Engine-Funktion (`engine/coolingAdvice.ts`); rein beratend.

## 0.8.2

- **Lüftungs-Modul mit echter Empfehlung (C1).** Das bisherige „geplant"-
  Modul gibt jetzt eine deterministische Lüftungsempfehlung je Raum aus —
  „Jetzt lüften" (nachts, außen ≥ deltaC kühler, Raum über Komfort),
  „Lüften möglich", „Fenster schließen" (offenes Fenster, während es draußen
  wärmer ist) oder „Geschlossen halten" (Hitzeschutz, keine Abkühlung). Die
  Gesamt-Empfehlung zeigt die dringendste Raum-Aktion. Reine, property-
  getestete Engine-Funktion (`engine/ventilationAdvice.ts`); rein beratend —
  das Plugin steuert keine Fenster.

## 0.8.1

- **Hitze-Schwellen nutzen das echte Tagesmaximum.** Mode-FSM
  (SUMMER_WATCH / ACTIVE_HEAT_PROTECTION / HEATWAVE) und die „Forecast"-
  Anzeige auf der Außentemperatur-Kachel lesen die Tageshöchsttemperatur jetzt
  aus der Open-Meteo-Tagesübersicht (Maximum aus heute/morgen), statt aus einem
  Signal-Binding, das auf der HCU versehentlich auf einen Ist-Temperatursensor
  zeigte. Fällt auf das konfigurierte Binding zurück, wenn keine Tagesdaten
  vorliegen.

## 0.8.0

- **Prognose-Engine folgt der Wetterkurve (A1/A2).** Der Forecast_Planner
  sampelt jetzt die stündliche Open-Meteo-Reihe (Temperatur, Globalstrahlung,
  Bewölkung) pro Stützpunkt, statt die aktuellen Werte über den ganzen Horizont
  einzufrieren. Vorher rechnete er nachts mit „Strahlung 0 für 12 h" und sah
  damit den Sonnenaufgang nie — die Temperatur-/Wärmelast-Prognosen sind jetzt
  realistisch. Bewölkung dämpft die Last wieder (`thermalModel`).
- **Sonnenstand-Cache (B1).** Sonnenpositionen werden je Zeitschritt einmal
  berechnet und über alle Kandidaten-Resimulationen wiederverwendet — der
  Planner ist deutlich schneller.
- **Snapshot-Cache (B2).** Der teure Dashboard-Snapshot wird einmal pro Zyklus
  gebaut und für Polls/SSE zwischengespeichert (max. 2 s alt).
- **Zyklus-Überlappungsschutz (B3).** Ein langer Zyklus blockiert jetzt den
  nächsten Timer-Tick, statt zwei Zyklen parallel laufen zu lassen.
- **Tages-Peak überlebt Neustart (E3).** Der Innentemperatur-Tagespeak liegt in
  `state.json`.
- **Außentemperatur = Mittelwert vorne/hinten.** Plus Internet-Vergleich
  (Open-Meteo) auf der Kachel.
- **Quellen-Mapping lädt automatisch.** Geräte erscheinen beim Öffnen, ohne
  „Geräte suchen" klicken zu müssen.
- **Sonnenbogen.** Wieder ein runder Punkt, ohne Uhrzeit-Label, nicht mehr in
  der Breite gestaucht.
- **12-Stunden-Rollladen-Steuerungsvorschau.** Die Analyse-Leiste zeigt je Raum
  als 2-Stunden-Raster, wann welcher Rollladen-Schließgrad geplant ist.
- **Aufräumen (F3/H3).** Irreführenden History-Kommentar korrigiert; ESLint
  kennt jetzt den Service-Worker-Scope (`npm run lint` läuft sauber durch).

## 0.7.5

- **Automatik-Logik erklärt den Auslöser.** Die Karte zeigt jetzt eine
  „Ausschlaggebend"-Zeile mit dem konkreten Faktor, der den Modus bestimmt
  hat (z. B. „Hitzewelle: Tagesprognose 31 °C ≥ 30 °C"), plus Wert-/Schwellen-
  Chips. Der Faktor kommt direkt aus der Modus-FSM.
- **Himmelsrichtung je Fenster wählbar.** Unter Räume & Fenster lässt sich
  pro Fenster die Ausrichtung (N/NO/O/SO/S/SW/W/NW) per Auswahl setzen.
- **Offenes Fenster sichtbar.** Raum-Kacheln auf dem 3D-Haus zeigen ein
  Fenster-Symbol, wenn ein Fensterkontakt im Raum offen/gekippt meldet.
- **Linke Leiste neu sortiert.** Sonnenstand steht jetzt ganz oben über PV.
- **Außentemperatur** zeigt zusätzlich das Tages-Forecast-Maximum
  („… (Forecast: 27 °C)"), **Innentemperatur** den Tages-Peak seit 0:00.
- **Sonnenbogen.** Liegt jetzt unter den Raum-Kacheln (z-Index) und wird oben
  nicht mehr abgeschnitten; OST/WEST-Fassadenkacheln sind nicht mehr verdeckt.
- **Hausbild austauschbar.** In den Einstellungen kann das Hintergrundbild des
  3D-Hauses per Upload (PNG/JPEG/WebP) ersetzt werden (`POST /api/house-image`,
  Persistenz unter `/data/`).
- **Bewegungsbudget.** Standard-Mindestabstand zwischen geplanten Fahrten auf
  3 h (10800 s) angehoben — ein Rollladen fährt höchstens alle drei Stunden.
- **Nachts inaktiv (Toggle).** Neue Option: zwischen Sonnenuntergang und
  Sonnenaufgang werden keine Rollläden automatisch bewegt (STORM bleibt
  oberste Priorität). „Morgens hoch / abends runter" ist bewusst nicht Aufgabe
  des Plugins.
- **Geplante Aktionen in der Zukunft.** Der Position-Selector plant die
  Fahrt auf den Zeitpunkt, an dem die aktuelle Position den Komfort verlässt —
  die „Nächste Aktionen"-Liste zeigt damit künftige Fahrzeiten statt nur „Jetzt".

## 0.7.4

- **Transparente SVG-Icons.** Die Top-Navigation (Beschattung, Lüftung,
  Klima, Forecast, Automation, Einstellungen) und die Umgebungs-Chips am Haus
  (Sonnenintensität, UV, Wind, Luftfeuchte) nutzen jetzt handgezeichnete,
  vollständig transparente Inline-SVGs statt der nicht-transparenten PNGs. Die
  Icons übernehmen die Aktiv-/Inaktiv-Farbe per `currentColor`.
- **Statisches 3D-Haus.** Der Haus-Zwilling verwendet nur noch ein einziges
  Bild (`heatshield_haus_transparent_rgba_final`); kein Wechsel mehr nach
  Sonnenstand oder Rollladenzustand. Alle Dynamik liegt in den Overlays.
- **Sonnenstand-Diagramm.** Passt jetzt ohne Beschnitt in die KPI-Kachel,
  zeigt zusätzlich den geworfenen Schatten und ein Sonnen-Symbol statt des
  gelben Punkts.
- **Umgebungswerte verdrahtet.** Sonnenintensität (W/m²), UV-Index und
  Luftfeuchte kommen jetzt aus den Open-Meteo-Daten (current + stündliche
  Reihe) statt „–".
- **SÜD-Fassadenkachel.** Wird nicht mehr von der Umgebungs-Leiste verdeckt
  (Bottom-Strip mit Verlauf, z-Index-Schichtung der Overlays).

## 0.7.3

- **Aufgeräumte Navigation.** Nur noch die sechs Module aus dem Mock
  (Beschattung, Lüftung, Klima, Forecast, Automation, Einstellungen). Die
  zusätzliche, doppelte Tab-Leiste unter dem Header ist entfernt; die
  bisherigen Konfigurations-Tabs (Räume, Quellen, Wizard, Diagnose,
  Nachrichten) sind über den Einstellungen-Hub erreichbar. Lüftung und Klima
  zeigen die aktuelle Ausgangslage (geplante Module), Forecast den Verlauf,
  Automation die Regeln.

## 0.7.2

- **Echte Wetterprognose im Dashboard.** Forecast-Zeitleiste und
  Temperaturchart nutzen jetzt echte OpenMeteo-Daten (Abruf alle 15 min,
  Modell DWD ICON): `current` + `minutely_15`-Nowcast + `hourly` (12–24h,
  inkl. gefühlter Temperatur, Bewölkung, Globalstrahlung, Niederschlag +
  -wahrscheinlichkeit, UV, Wind) + `daily` (Sonnenauf/-untergang, UV-/
  Niederschlags-Maxima). Vorher zeigte die Zeitleiste konstante Platzhalter.
- **Haus-Zwilling korrekt.** Sechs echte Renderings (Tag/Nacht × Rollladen
  offen/halb/geschlossen, transparente PNGs) werden nach Sonnenstand und
  durchschnittlicher Rollladenstellung gewählt. Räume werden nach Stockwerk
  (KG/EG/OG/DG) und Himmelsrichtung am Haus platziert. Eigene Icons für
  Navigation und Umgebungswerte.
- **Fassaden-Kacheln & Raumtabelle gefixt.** Fassaden-Exposition als saubere
  Kacheln mit „%"; die Raumtabelle ist fixiert und rutscht nicht mehr unter
  die rechten Kacheln.
- **Nächste Aktionen aussagekräftig.** Statt nackter „100 %" jetzt
  Gerät/Raum + Zielposition + ETA, farbcodiert; „Keine geplanten Aktionen"
  wenn leer.
- **Automatik-Logik erklärt.** Titel „Automatik-Logik" mit Modus-Label und
  ein ⓘ-Panel, das alle Modi und die Komfort-/Hitzeindex-Stufen erklärt.
- **Korrigierter Temperaturchart** (Innen/Außen, Vergangenheit durchgezogen,
  Prognose mit/ohne Beschattung gestrichelt, Komfortband, Jetzt-Linie).

## 0.7.1

- **Zeichensatz-Fehler in Geräte-/Fensternamen behoben.** Umlaute,
  Bindestrich und Emoji werden wieder korrekt angezeigt (Dashboard und
  Telegram) — eine frühere Fehlkodierung (UTF-8 als CP1252) ist repariert.
- **Gruppierte Benachrichtigungen.** Gleichartige Ereignisse eines Zyklus
  werden zu einer Nachricht zusammengefasst statt einer pro Fenster.

## 0.7.0

- **Prognosegeführte, bewegungsminimierende Steuerung (Forecast_Planner).**
  Neue, der Engine vorgelagerte Planungsschicht: pro Raum wird über einen
  12-Stunden-Horizont (15-min-Schritte) eine thermische Trajektorie aus
  Sonnenstand, Wetter (Bewölkung/Einstrahlung), PV, Gebäudeträgheit und
  Fenstergeometrie berechnet. Daraus wird je Rollladen die Position gewählt,
  die den Raum über den ganzen Horizont im Komfort hält — mit den **wenigsten
  Bewegungen**. Hält die aktuelle Position bereits, wird gar nicht gefahren.
  Außerplanmäßig greift das Plugin nur ein, wenn die Messung über eine
  einstellbare Toleranz (Default 1,5 °C) von der Prognose abweicht. STURM,
  Sicherheit und Hysterese bleiben übergeordnet; alle Invarianten erhalten.
  Neue Konfiguration unter `rules.planning` plus `thermalInertiaMinutes` je
  Raum und `areaM2` je Fenster.
- **Neues 3-Spalten-Dashboard „Beschattung".** Links Live-KPIs (PV inkl.
  PV-Sonnenindex, Innen/Außen, Sonnenstand, Komfort-/Hitzeindex-Ring); Mitte
  isometrischer Haus-Zwilling mit Sonnenbogen, Fassaden-Exposition,
  Rollladen-Etiketten und Umgebungswerten plus Forecast-Zeitleiste und
  geplanten Aktionen; rechts Automatik-Logik (mit Begründungskette),
  Temperaturverlauf (Prognose mit/ohne Beschattung), PV- und Hitzelast-Chart
  sowie Rollladen-Tagesverlauf-Heatmap. Sonnenbogen-Scrubbing zeigt eine
  Vorschau späterer Zeitpunkte, ohne die Rollläden zu bewegen. Charts bleiben
  schlankes Inline-SVG (kein CDN). Neue Endpunkte `GET /api/forecast` und
  `GET /api/plan`.

## 0.6.0

- **Direkte Open-Meteo-Anbindung (HTTP).** Das Plugin kann Wetterdaten
  jetzt optional direkt von open-meteo.com abrufen — unabhängig vom
  HCU-OpenMeteo-Plugin. Verfügbare Felder: Außentemperatur,
  Tageshöchsttemperatur, Bewölkung (%), Globalstrahlung (W/m²),
  Windgeschwindigkeit (m/s) und Niederschlag. Im Quellen-Tab unter
  „Open-Meteo (direkt)" aktivierbar (mit einstellbarem Abruf-Intervall),
  danach in den Signal-Dropdowns als Quelle wählbar. Robuste
  3-Strikes-Fehlerlogik wie bei FusionSolar; Standort kommt aus der
  Konfiguration. Standardmäßig deaktiviert.

## 0.5.0

- **Verlauf-Tab mit Diagrammen.** Neuer Tab „Verlauf" zeigt zwei
  Liniendiagramme: Temperaturen (außen plus jeder Raum) und PV-Leistung
  über die letzten 6 Stunden, 24 Stunden oder 3 Tage. Die Charts sind
  als schlankes, abhängigkeitsfreies Inline-SVG umgesetzt (kein CDN,
  kein Chart.js-Ballast). Datenquelle ist der neue Endpunkt
  `GET /api/trends?seconds=` auf Basis der bereits persistierten
  `trends.ndjson`.

## 0.4.0

- **Winter-Isolierung.** Optional schließen die Rollläden in kalten,
  dunklen Nächten (Außentemperatur ≤ einstellbarer Schwelle), um
  Wärmeverluste zu senken — das Spiegelbild der sommerlichen
  Nachtkühlung. STURM und Nachtkühlung haben weiterhin Vorrang.
  Einstellbar im Regeln-Tab (Schwelle und Schließgrad).
- **Lern-Empfehlungen automatisch übernehmen.** Neuer Schalter im
  Regeln-Tab: das Plugin wendet seine Tuning-Vorschläge selbständig an
  (gedrosselt auf ca. alle 6 h) und meldet jede Anpassung.
- **Täglicher Abend-Rückblick.** Optionale Zusammenfassung (Modus,
  gefühlte Wärme, Anzahl verschatteter Fenster) zu einer einstellbaren
  Uhrzeit — einmal pro Tag, idempotent über Neustarts hinweg.
- **Gesundheits-Wächter.** Erreicht ein Rollladen 5 min nach einem
  Fahrbefehl seine Zielposition nicht (Abweichung > 15 %), gibt es eine
  einmalige Warnung (Motor blockiert oder Gerät offline?). Die Warnung
  verschwindet, sobald die Position wieder stimmt.

## 0.3.0

- **Manuelle Steuerung & Szenen im Live-Tab.** Pro Fenster ein Slider mit
  „Fahren"-Button für direkte Rollladen-Positionen, plus Szenen-Tasten
  „Alle auf / Halbschatten / Alle zu".
- **Config-Backup.** Im Diagnose-Tab Konfiguration als JSON exportieren
  (Download) und wieder importieren. Der Telegram-Token bleibt maskiert /
  beim Import erhalten.
- **Telegram-Tipp-Tasten (Inline-Buttons).** `/menu` und `/hilfe` zeigen
  Schnellzugriff-Tasten (Status, Wetter, Räume, Pause, Weiter, Urlaub) —
  ein Tipp statt getippter Befehle. Tasten lösen dieselben Befehle aus.

## 0.2.1

- **FIX: Solaranlagen-Werte (PV) erschienen nicht.** Aus dem Plugin-Container
  ist der mDNS-Name `hcu1-XXXX.local` nicht auflösbar; FusionSolar wird jetzt
  über `host.containers.internal:8088` erreicht (wie die Connect-API). Greift
  automatisch auch für bestehende Konfigurationen; per `HEATSHIELD_FUSION_URL`
  überschreibbar. Die aufgelöste URL steht im Log.
- **Dachfenster schließen bei Sonne.** Trifft direkte Sonne auf ein Dachfenster
  und Hitzeschutz ist aktiv, fährt es auf ~100 % (Glas über Kopf heizt den
  Raum am stärksten).
- **PV-Spitzenleistung („volle Sonne") einstellbar** im Quellen-Tab und per
  `/set pvmax <kWp>` — Bezugsgröße für die Wärmelast.
- **Klarere Live-Kacheln.** Ist eine Quelle zugewiesen, aber noch ohne Daten,
  zeigt die Kachel „… warte auf Daten" bzw. „⚠ Daten veraltet" statt
  „Quelle zuweisen".

## 0.2.0

- **Interaktiver Telegram-Bot (bidirektional).** Der Bot pollt jetzt per
  Long-Polling und reagiert auf Chat-Befehle:
  - **Abfragen:** `/status` (Modus, gefühlte Wärme, Rollladen-Ziele),
    `/wetter` (Tagesvorschau), `/raeume` (Raumtemperaturen), `/hilfe`.
  - **Steuern:** `/pause [Minuten]`, `/weiter`, `/urlaub an|aus`,
    `/automatik an|aus`, `/set <name> <wert>` (z. B. Morgenzeit,
    Aktivierungs-/Deaktivierungsschwelle, Haltezeit, PV-Gewicht,
    Forecast-Intervall).
  - **Sicherheit:** Befehle nur aus dem konfigurierten Chat (oder
    zusätzlichen erlaubten Chat-IDs). Steuerbefehle lassen sich global
    abschalten („Steuerbefehle erlauben"). Bot-Token wird nie geloggt.
- **Regelmäßige Wetter-Updates.** Optional alle N Stunden ein Wetter-/
  Status-Push (Telegram + In-App-Nachrichten-Tab).
- Neue Schalter im Regeln-Tab: „Chat-Befehle aktiv", „Steuerbefehle
  erlauben", erlaubte Chat-IDs, Wetter-Update-Intervall.

## 0.1.9

- **Fensterkontakt-Zuweisung per Drag & Drop.** Im Räume-Tab gibt es jetzt
  eine Liste „Fensterkontakte" (Geräte mit `windowState`-Feature). Einen
  Kontakt einfach auf den gewünschten Rollladen ziehen → er wird als
  Fenstersensor dieses Fensters gesetzt (für die Lüften-Erkennung). Jeder
  Rollladen zeigt seinen zugewiesenen Kontakt; ✕ entfernt die Zuweisung.

## 0.1.8

- **Korrekte PV-Quelle.** „PV-Leistung (Sonne)" liest jetzt FusionSolar
  `inputPower` (die DC-Erzeugung der Panels = echter Sonnen-Indikator)
  statt `activePower` (Wechselrichter-AC, durch Hausverbrauch/Akku
  verfälscht). Standardmäßig out-of-the-box gebunden.
- **Nicht vorhandene Strahlungs-Quelle entfernt.** Es gibt keinen
  Einstrahlungssensor; die „Strahlung (W/m²)"-Kachel und -Zuweisung sind
  raus, da die PV-Leistung diese Rolle übernimmt.
- **Auto-Speichern in allen Tabs.** Räume, Quellen und Regeln speichern
  Änderungen automatisch nach kurzer Pause — keine Speichern-Buttons mehr.
- **Klarnamen überall.** Fenster/Geräte erscheinen als
  „Raum – Gerät (…ID)" statt als nackte ID — in der Live-Ansicht, im
  Sonnen-Plot und in der Regel-Vorschau.
- **Räume löschbar** direkt in der Raumkarte.
- **Durchgängig deutsch** (Modus-Namen, Verbindungsstatus, Fensterkarten,
  Regel-Regler, Vorschau).
- **Modernere UI**: deutlichere Preset-Buttons, aufgeräumte Live-Fensterkarten
  (Aktuell → Ziel mit Richtungspfeil), Feels-like-Kachel mit Trendpfeilen.
- **Telegram-Einrichtungshilfe** im Regeln-Tab + „Test senden"-Button.

## 0.1.7

- **PV-geführtes „Feels-like"-Wärmemodell.** Die Wattleistung der
  PV-Anlage ist der maßgebliche Indikator für solare Wärmelast und wird
  in den Kontext der Außentemperatur gesetzt: starke Sonne bei bereits
  warmer Luft erhöht die effektive Wärmewirkung. Das Modell bleibt
  normalisiert [0, 1] (kein additives Modell) und ist nachweislich
  monoton in der PV-Leistung.
- **Asymmetrische Beschattungs-Hysterese.** Beschattung aktiviert
  zeitnah, wird aber erst nach einer Mindesthaltezeit (Default 60 min)
  zurückgenommen — die Rollläden pendeln nicht mehr. Aktivierungs- und
  Deaktivierungsschwelle sind getrennt einstellbar.
- **Orientierungs- und sonnenstandsbasierte, partielle Schließtiefe.**
  Fenster werden nur so weit geschlossen wie nötig; trifft keine direkte
  Sonne mehr auf ein Fenster, fährt das Rollo wieder hoch. NO-Fenster
  öffnen über den Tag früher als SW-Fenster.
- **Lüften-Lockout.** Ein offener Fensterkontakt nimmt das Rollo
  vollständig aus der Steuerung, bis das Fenster wieder geschlossen ist.
  STORM-Sicherheit behält Vorrang.
- **Multi-Sensor-Vergleich mit Mehrstunden-Trends.** Außentemperatur
  vorne (NO) und hinten (SW), API-IST, API-Forecast und PV werden
  verglichen; Verläufe (°C/h, kW/h) über ein gleitendes Fenster fließen
  vorausschauend in die Entscheidung ein und überdauern Neustarts.
- **Benachrichtigungen.** Optionale Telegram-Nachrichten (lüften,
  öffnen, schließen, Morgen-Wetterbriefing) plus ein In-App-Nachrichten-
  Tab mit Umschlag-Badge für ungelesene Nachrichten. Bot-Token wird im
  UI maskiert und nie geloggt.

## 0.1.6

- **UI durchgängig deutsch und bedienfreundlicher.** Alle Geräte
  erscheinen jetzt als Klarname plus die letzten vier Zeichen der
  Geräte-ID in Klammern (z. B. „Rollo Dachfenster (…5682)") statt als
  nackte UUID — sowohl im Wizard, in den Räumen als auch im
  Quellen-Mapping.
- **Himmelsrichtungs-Kompass:** Statt eines Dropdowns wählt man die
  Ausrichtung eines Fensters/Rollladens über einen anklickbaren
  8-Punkte-Kompass (N…NW), inkl. Grad-Anzeige.
- **Editierbare Raumnamen** direkt in der Raumkarte und im Wizard
  (Schritt 3). Prioritäten und Zieltemperaturen werden mit deutschen
  Klarnamen angezeigt (Zieltemperatur, Warnschwelle, Starke
  Beschattung, Kritisch).
- **Quellen-Dropdowns zeigen den aktuellen IST-Wert** jeder Quelle
  (z. B. „… · Temperatur = 22.4"), damit man beim Zuweisen sofort
  sieht, welcher Sensor welchen Wert liefert.
- **Automatik pro Fenster blockierbar:** Über eine „Automatik aus"-
  Checkbox (Wizard Schritt 4 und Raumkarte) lässt sich ein einzelnes
  Fenster von der Automatik ausnehmen; die Engine setzt dann
  `blockedBy='blocked'` und fährt das Rollo nicht.

## 0.1.5

- **Installierbare PWA:** Web-App-Manifest, Service Worker (Offline-
  Shell, `/api/*` immer live), iOS-Meta-Tags und Icon. Auf dem iPhone
  über Safari „Zum Home-Bildschirm" installierbar; läuft dann im
  Vollbild wie eine App. Responsives Layout für Mobile.
- **Temporäres Abschalten aus der HMIP-App** ist über das plugin-
  eigene Switch-Gerät „Hitzeschutz pausieren" möglich (pausiert bis
  Mitternacht; Engine hält alle Positionen). Ergänzt den persistenten
  Master-Schalter im Dashboard-Header.

## 0.1.4

- **Master-Schalter „Automatik aktiv" im Header (Default AUS).** Frisch
  installiert bewegt das Plugin nichts, bis man bewusst aktiviert — man
  kann in Ruhe konfigurieren. Technisch hält die Engine bei AUS alle
  Positionen (MAINTENANCE-Semantik), wertet aber weiter aus. Schalter
  über `POST /api/control/automation`, persistiert in
  `config.automationEnabled`.
- **Live-IST-Werte:** Die Geräte-/Feature-Übersicht zeigt jetzt den
  aktuellen Wert jedes Features (z.B. `shutterLevel=0.5`,
  `windowState=CLOSED`, `actualTemperature=22.4`).
- **Räume:** Schnell-Presets gruppiert nach Stockwerk
  (OG: Schlaf-/Arbeits-/Gäste-/Badezimmer; EG: Küche/Garderobe/Flur/
  Wohnzimmer; KG: Keller) plus frei konfigurierbares Stockwerk-Feld.
  Voll erweiterbar — beliebige Räume/Stockwerke.
- **Wizard Schritt 4:** Orientierung (N…NW), Fenstertyp und
  Fensterkontakt pro Rollladen zuweisbar; Discovery liefert
  `contactSources`.

## 0.1.3

- **Engine konsumiert die gemappte Konfiguration (Gesamtkonzept-Fix).**
  `buildCycleSnapshot` löst jetzt jede `SignalBinding` über
  `resolveSignal` gegen HCU-Cache + FusionSolar auf: Außentemperatur,
  Vorhersage-Max, PV-Leistung, Wind, Strahlung und pro Raum die
  Innentemperatur. Pro Fenster werden die Rollladen-Ist-Position
  (`shutterLevel`) und der Fensterkontakt-Zustand (`windowState` →
  closed/open/tilted) live gelesen. Vorher waren all diese Werte fest
  `null` — die Engine „sah" nichts, egal was gemappt war.
- **Wizard Schritt 4** erlaubt jetzt pro Rollladen: Raum, **Orientierung**
  (N…NW, kritisch fürs Sonnen-Gating), **Fenstertyp** (Fassade/Dachfenster)
  und **Fensterkontakt**-Zuordnung (fürs Lüften).
- **Discovery** liefert zusätzlich `contactSources` (Geräte mit
  `windowState`).

## 0.1.2

- **Wizard / Räume / Quellen feature-basiert:** Die UI erkennt Geräte
  jetzt über ihre Features statt über das DeviceType-Enum. Rollläden =
  Geräte mit `shutterLevel` (native `BRAND_SHUTTER` + Velux), Temperatur-
  quellen = Geräte mit `actualTemperature` (Wandthermostate, Temp/Feuchte-
  Sensoren, Außensensoren, OpenMeteo). Vorher filterte die UI auf
  `WINDOW_COVERING` / `CLIMATE_SENSOR` und fand auf einer echten HCU
  nichts.

## 0.1.1

- **Fix:** Native HmIP-Geräte werden jetzt erkannt. Der frühere strikte
  Geräte-Parser (`DeviceProbeSchema`) verwarf jedes native Gerät still
  (z. B. numerischer `manufacturerCode`, `null`-`label`) — auf einer
  echten HCU überlebten nur 49 von 118 Geräten. `mergeDevice` liest
  Felder jetzt defensiv pro Feld und nutzt den Map-Key als Geräte-ID,
  wenn das Objekt kein inneres `id` trägt. Damit erscheinen Rollläden
  (`shutterLevel`), Fensterkontakte (`windowState`) und Thermostate
  (`actualTemperature`) in der Discovery.
- **Discovery-Diagnose:** „Roh ↔ geparst"-Vergleich, DeviceType-Histogramm,
  vollständiges Geräte-/Feature-Inventar und ein „Plugin-Build"-Stempel
  im Dashboard, damit die laufende Version eindeutig erkennbar ist.
- **OpenMeteo-Erkennung:** Regex `/open[\s_-]?meteo/i` (matcht auch
  „Open-Meteo" mit Bindestrich); Erkennung feature-basiert statt über das
  DeviceType-Enum.
- **Versionierung:** `npm run build:image` baut versioniert, taggt das
  Image und exportiert `heatshield-<version>-arm64.tar.gz`.

## 0.1.0

- Erste Version: Engine (Risikomodell, Modus-FSM, Sicherheitslogik),
  Quellen-Adapter (FusionSolar, HCU, OpenMeteo, statisch), Connect-API-
  Client mit 5 plugin-eigenen SWITCH-Geräten, Dashboard-SPA (Live, Räume,
  Quellen, Regeln, Wizard, Diagnose), Persistenz unter `/data/`.
