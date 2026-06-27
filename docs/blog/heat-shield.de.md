# Heat Shield: Wie ein selbstgebautes Homematic-IP-Plugin die Sommerhitze aus dem Haus hält

*Ein vorausschauendes, lernendes Rollladen-Plugin für die Homematic IP Home Control Unit – mit PV-Daten, Wetterprognose, ET-basierter Gartenbewässerung und einem Premium-Dashboard. Open Source, lokal, ohne Cloud-Zwang.*

---

## Das Problem: Sommerhitze ist ein Timing-Problem

Wer im Sommer ein aufgeheiztes Schlaf- oder Arbeitszimmer kennt, weiß: Gegen Mittag die Rollläden runterzufahren ist **zu spät**. Die Wärme ist dann längst im Raum, gespeichert in Wänden und Möbeln, und geht über Stunden nicht mehr raus. Klassische Zeit- oder Sonnenstandsschaltungen reagieren entweder zu spät oder verdunkeln das Haus den ganzen Tag „auf Verdacht" – und kosten dabei jeden Tag unnötig viel Tageslicht und unzählige Motorfahrten.

Hitzeschutz ist im Kern ein **Timing- und Optimierungsproblem**: Man möchte *so spät wie möglich, so wenig wie nötig* verschatten – aber *früh genug*, damit die Wärme gar nicht erst reinkommt. Genau dafür ist **Heat Shield** entstanden.

> Heat Shield ist ein privates, selbst gehostetes Hobby-Projekt – kein offizielles eQ-3-Produkt. Nutzung auf eigenes Risiko.

---

## Die Idee: vorausschauen statt nachregeln

Statt auf die aktuelle Temperatur zu *reagieren*, rechnet Heat Shield eine **12-Stunden-Wärmeprognose pro Raum** und wählt daraus die Rollladenposition, die den Raum über den gesamten Horizont komfortabel hält – mit den **wenigsten Fahrten**.

Die Prognose kombiniert:

- **Sonnenstand** (Azimut/Elevation, aus Geokoordinaten berechnet),
- die **Wetterkurve** (Temperatur, Bewölkung, Globalstrahlung),
- die **PV-Erzeugung** als Indikator für solare Last,
- die **thermische Trägheit** des Gebäudes,
- und die **Fenstergeometrie** (Fassadenausrichtung, Dach- vs. Fassadenfenster).

Das Leitprinzip steht über allem: **so wenige Rollladenfahrten wie nötig, so viel Tageslicht wie möglich, Kühlen zuerst.**

---

## Wie die Steuerung entscheidet

### Risiko-Modell statt Bauchgefühl

Für jedes Fenster bildet die Engine ein **normiertes Risiko zwischen 0 und 1** aus gewichteten Komponenten (Sonneneinfall, prognostizierte Raumtemperatur, solare Last). Daraus leitet sie eine Zielposition ab – mit Hysterese, damit der Rollladen nicht bei jedem Wölkchen pendelt, und mit einer Mindest-Haltezeit.

### Acht Betriebsmodi

Eine endliche Zustandsmaschine klassifiziert jeden Zyklus in einen Modus. Die Reihenfolge ist eine strikte Priorität (oben gewinnt):

1. **STORM** – höchste Priorität. Bei Wind über der Schwelle fahren außenliegende Rollläden zum Schutz **hoch**, mit Haltezeit nach der Böe. Überschreibt alles andere.
2. **MAINTENANCE** – Wartung; die Automatik ist pausiert, das Dashboard zeigt weiter alles an.
3. **VACATION** – Urlaubsprofil (geht bewusst vor dem Hitzeschutz).
4. **NIGHT_COOLING** – nachts, wenn außen kühler als innen: Rollläden öffnen, um warme Luft rauszulassen.
5. **HEATWAVE** – Hitzewelle (hohe Prognose oder bereits sehr warme Räume).
6. **ACTIVE_HEAT_PROTECTION** – aktiver Hitzeschutz.
7. **SUMMER_WATCH** – erhöhte Beobachtung bei aufkommender Hitze.
8. **NORMAL** – Ruhebetrieb.

Jede Entscheidung ist **transparent**: Das Dashboard zeigt den Modus, den ausschlaggebenden Faktor und die relevanten Messwerte als Chips – kein Blackbox-Verhalten.

### Selbstlernend

Heat Shield verbessert sich von Tag zu Tag:

- Es lernt einen **begrenzten Komfort-Bias pro Raum**.
- Es gewichtet den **gemessenen solaren Eintrag** je Raum (Innen-Peak vs. Außen-Maximum) und verschattet stark aufheizende Räume früher.
- Es **kalibriert die thermische Trägheit** jedes Raums aus dem Vergleich „vorhergesagter vs. tatsächlicher Peak".

### Die Rollladen-Konvention

`0 % = offen`, **`95 % = stärkstes automatisches Schließen`** (ein bewusster Spalt gegen Wärmestau), `100 %` nur manuell bzw. für Dachfenster. Diese Detailtreue verhindert, dass sich hinter einem komplett dichten Rollladen die Hitze staut.

---

## Woher die Daten kommen

Heat Shield ist ein reiner WebSocket-Client an der **offiziellen Connect API** der HCU und führt mehrere Quellen zusammen:

- **Native Homematic-IP-Geräte** über den System-State: Rollläden (`BRAND_SHUTTER`), Fensterkontakte (`SHUTTER_CONTACT`), Wand-/Heizkörperthermostate, Temperatur-/Feuchtesensoren (innen und außen), Lichtsensoren. Die Geräteerkennung läuft **feature-basiert** (z. B. „hat `shutterLevel`") – robust gegenüber neuen Gerätetypen.
- **PV-Daten** vom FusionSolar-Plugin (aktuelle Leistung, Batterie, Einspeisung) als Maß für solare Last und für den PV-Überschuss.
- **Wetter** von Open-Meteo (Temperatur, Bewölkung, Globalstrahlung, Wind, Niederschlag, Tageshöchstwert, Referenz-Verdunstung).
- **Amtliche Unwetterwarnungen** vom Deutschen Wetterdienst (DWD).

Wichtig: **Native Rollläden werden ausschließlich über den dokumentierten Connect-API-Befehl gesteuert.** Das Plugin sendet keine erfundenen Zustände und respektiert die strikten Schema-/Enum-Regeln der HCU.

---

## Mehr als Rollläden: ET-basierte Gartenbewässerung

Wer im Sommer das Haus kühl hält, will oft auch den Garten klug bewässern. Heat Shield bringt deshalb optional eine **vollwertige, ET-gesteuerte Bewässerung** über das **GARDENA smart system** mit – ohne separates Gardena-Plugin, direkt über deinen eigenen Husqvarna-Application-Key.

- **Wasserbilanz nach FAO-56 pro Zone.** Statt nach Zeitplan zu gießen, führt die Engine eine Bilanz aus Referenz-Verdunstung (Open-Meteo `et0_fao_evapotranspiration`), effektivem Regen und ausgebrachtem Wasser. Gegossen wird erst, wenn das pflanzenverfügbare Wasser aufgebraucht ist – **tief und selten** statt täglich oberflächlich.
- **Lernen & Prognose.** Jede Zone kalibriert ihren Kc-Wert und die Abgaberate aus der gemessenen Bodenfeuchte-Reaktion, erkennt defekte Tropfer/Emitter und sagt die nächste Gabe voraus.
- **Editierbarer Tagesplan.** Eine Drag-&-Drop-Timeline zeigt, welches Ventil wann und wie lange läuft; Einträge lassen sich verschieben, in der Dauer ändern, an-/ausschalten, hinzufügen und löschen.
- **Sicherheit & Koordination.** Es ist **immer nur ein Ventil gleichzeitig** offen (gemeinsame Wasserversorgung), dazu Regen-/Frost-/Wind-Skip, Tagesbudgets, Cycle-and-Soak, bevorzugtes Gießen bei PV-Überschuss, Koordination mit dem Mähroboter und eine optionale Pumpen-Steckdose.

Dazu kommen **beratende Module** für Lüftung und aktives Kühlen (an PV-Überschuss gekoppelt): Sie schalten nichts selbst, geben aber Hinweise wie „jetzt querlüften" oder „mit Solarstrom vorkühlen".

---

## Das Dashboard: ein selbst gehostetes Premium-PWA

Das Herzstück für den Alltag ist ein **eigenständiges Dashboard**, das direkt auf der HCU läuft (`http://<deine-hcu>.local:8089/`) – als installierbare Progressive Web App, responsiv für Browser und Mobile, mit automatischem Hell-/Dunkel-Theme.

Highlights:

- **Digitaler Zwilling des Hauses** – Live-Himmel, Sonnenbogen, Raum-Badges, Heat-Map und eine 12-Stunden-Vorschau der Rollladenfahrten.
- **Wetter-Tab** mit Regenradar (RainViewer), kompakter Windrose, DWD-Warnungen und interaktiven Deep-Dive-Diagrammen (Fadenkreuz + Werte-Tooltip, pixelgenaues Rendering).
- **Bewässerung** mit Zonenkarten, Bodenwasser-Gauge, Lern-Status und dem Tagesplan-Editor.
- **Automatik**, **Räume & Fenster**, **Quellen-Mapping**, **Diagnose** und ein Tab **Logs & Debug**.
- **Live-Updates** über Server-Sent Events – das Dashboard atmet mit den Daten, ohne Reload.

Seit den jüngsten Versionen ist das gesamte UI **zweisprachig (Deutsch/Englisch)**: Die Sprache folgt automatisch dem Browser (Deutsch als Fallback) und lässt sich pro Gerät unter *Einstellungen → Darstellung & Sprache* fest auf AUTO/Deutsch/English stellen. Übersetzt ist **alles** – Tabs, Diagramme, Empfehlungen und sogar die vom Backend erzeugten Entscheidungs-Texte; Zahlen folgen dem Sprachformat.

### Benachrichtigungen

Optional meldet sich ein **Telegram-Bot**: Morgen-Briefing, Abend-Rückblick, Wetter-Updates und Alarme (Sturm, extreme Hitze, hoher UV-Index). Die **Sprache der Benachrichtigungen** ist eine eigene, installationsweite Einstellung.

### Bug-Reports in einem Klick

Für Support gibt es unter *Logs & Debug* den Button **„Alle Informationen"**: ein 360°-Diagnose-Export, der alle Status- und Diagnose-Endpunkte, die API-Werkzeuge, das Connect-Protokoll sowie Browser- und System-Infos in **einer einzigen `.txt`-Datei** bündelt.

---

## Lokal, privat, ohne Cloud-Zwang

Heat Shield läuft als Plugin **direkt auf der HCU** und im lokalen Netz. Der Scope ist `LOCAL`, Laufzeitzustand und gelernte Modelle liegen ausschließlich im `/data`-Volume. Es gibt **keine** Pflicht-Cloud und keine Telemetrie. Wetterdaten kommen von Open-Meteo, PV vom lokalen FusionSolar-Plugin, alles andere von deinen eigenen Geräten.

Nichts ist auf ein bestimmtes Zuhause hartkodiert: Standort, Quellen-Bindungen, Räume, Schwellen und Bewässerungszonen werden komplett über die Konfigurationsseite gepflegt.

---

## Unter der Haube: Technik & Qualität

- **TypeScript (strict)**, ESM, klare Trennung von purer Engine-Logik und I/O.
- **Pure, deterministische Engine** (gleiche Eingaben → gleiche Ausgaben), dadurch hervorragend testbar – inklusive Property-Based-Tests mit fast-check.
- **~960 automatisierte Tests** (Vitest), ESLint mit `--max-warnings=0`, Prettier.
- **Frontend:** Preact + Chart.js/Leaflet, mit ESBuild gebündelt, ganz ohne CDN.
- **Server:** Fastify; Konfig-Validierung mit Zod.
- **Connect API:** WebSocket-Client streng nach Spezifikation – korrekte Header, Envelope-Format, Enum-Werte; defensives Parsen pro Feld, damit neue Gerätefelder nie ganze Geräte verschlucken.
- **Auslieferung:** Multi-Stage-Docker-Build als **arm64**-Image (die CPU der HCU), hochgeladen als `.tar.gz` über den HCUweb-Plugin-Manager.

### Open-Source-Bausteine

Preact, Leaflet + RainViewer, SunCalc, Fastify, Zod; Wetterdaten von Open-Meteo (CC BY 4.0), Unwetterwarnungen vom DWD. Lizenz des Plugins: **Apache 2.0**.

---

## Installation in Kürze

1. Aktuelles `heatshield-<version>-arm64.tar.gz` aus den **Releases** laden (oder selbst bauen).
2. In **HCUweb → Plugins** das `.tar.gz` hochladen.
3. Auf der Konfigseite **Standort** (Breite/Länge/Zeitzone) und – falls genutzt – **Quellen** (FusionSolar, Open-Meteo/native Sensoren) und **GARDENA** (Key/Secret) setzen.
4. Dashboard öffnen: `http://<deine-hcu>.local:8089/`.

Selber bauen (Node ≥ 20, Docker mit `buildx`):

```bash
npm install
npm run build        # tsc (Engine + SPA) + SPA-Bundle
npm test             # vitest --run
npm run lint         # eslint, --max-warnings=0
npm run build:image  # arm64-Image -> .tmp-assets/heatshield-<version>-arm64.tar.gz
```

---

## Fazit

Heat Shield zeigt, wie viel in einer offenen Plattform wie der Homematic IP HCU steckt, wenn man **Prognose, Lernen und eine klare UX** zusammenbringt: Räume bleiben kühl, ohne das Haus zu verdunkeln; der Garten wird bedarfsgerecht statt nach Stoppuhr bewässert; und jede Entscheidung ist im Dashboard nachvollziehbar. Alles lokal, quelloffen und in deiner Hand.

**Code, Releases & Doku:** <https://github.com/fabiorenner-hub/hmip-hcu-heatshield>
Fragen oder Bugs? Bitte ein Issue eröffnen (mit HCU-Firmware-Version, Plugin-Version und – am besten – dem Export aus *Logs & Debug → „Alle Informationen"*).

*Heat Shield ist ein privates Hobby-Projekt und kein offizielles eQ-3-Produkt.*
