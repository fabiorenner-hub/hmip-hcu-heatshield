# HMIP HCU Plugin: Heat Shield

[English version → `README.md`](README.md)

Ein Plugin für die [Homematic IP](https://www.homematic-ip.com/) Home Control
Unit (HCU), das **vorausschauend** Außenrollläden steuert, um Räume vor
sommerlicher Überhitzung zu schützen — und optional eine vollständige
**ET-basierte Garten-Bewässerung** über GARDENA-smart-Geräte fährt.

`pluginId: de.fr.renner.plugin.heatshield`

Es verbindet PV-Live-Daten (FusionSolar-Plugin), Wettervorhersagen (Open-Meteo)
und native HMIP-Sensoren zu einer Raum-Wärmeprognose und einem Fenster-Risiko­
modell und steuert die Rollläden über die offizielle Connect API — mit dem Ziel
**so wenig Rollladenfahrten wie nötig, so viel Tageslicht wie möglich, Kühlen
zuerst**. Ein hochwertiges, selbst gehostetes PWA-Dashboard zeigt alles an und
macht es einstellbar.

> Hinweis: persönliches, selbst gehostetes Hobby-Projekt, kein offizielles
> eQ-3-Produkt. Nutzung auf eigene Gefahr.

## Support

Fehler gefunden oder Frage? Bitte ein [Issue öffnen](../../issues). Bitte HCU-
Firmware-Version, Plugin-Version (Einstellungen → Updates) und die relevanten
Zeilen aus dem Connect-Protokoll (Einstellungen → Diagnose) angeben.

## Was es kann

### Hitzeschutz (Rollläden)

- **Vorausschauende Steuerung.** Eine 12-h-Wärmeprognose pro Raum (Sonnenstand,
  Wetterverlauf, PV, Gebäudeträgheit, Fenstergeometrie) wählt die
  Rollladenstellung, die den Raum über den ganzen Horizont mit den wenigsten
  Fahrten komfortabel hält.
- **Selbstlernend.** Lernt täglich einen begrenzten Komfort-Bias je Raum,
  berücksichtigt den gemessenen solaren Eintrag (Innen-Peak vs. Außen-Max) und
  kalibriert die thermische Trägheit aus Prognose-vs-Ist.
- **Betriebsmodi.** `NORMAL` · `SUMMER_WATCH` · `ACTIVE_HEAT_PROTECTION` ·
  `HEATWAVE` · `NIGHT_COOLING` · `STORM` (höchste Priorität) · `VACATION` ·
  `MAINTENANCE`.
- **Rollladen-Konvention.** 0 % = offen, **95 % = stärkstes automatisches
  Schließen** (Stauschutz-Spalt), 100 % nur manuell / für Dachfenster.
- **Empfehlungen.** Lüftungs- und Aktiv-Kühl-Hinweise (PV-Überschuss-gekoppelt);
  optionale Telegram-Warnungen bei Sturm, extremer Hitze und hohem UV.

### Bewässerung (optional, GARDENA)

- **ET-Wasserbilanz (FAO-56) pro Zone.** Verfolgt das Bodenwasser-Defizit aus
  Referenz-Verdunstung, effektivem Regen und Bewässerung; gießt nur, wenn das
  nutzbare Wasser aufgebraucht ist — tief und selten.
- **Lernen + Forecast.** Kalibriert Pflanzenkoeffizient und Emitter-Abgabe aus
  der Feuchte-Antwort, erkennt defekte Emitter und sagt die nächste Gabe voraus.
- **Editierbarer Tagesplan.** Eine Zeitleiste zeigt, welches Ventil wann und wie
  lange läuft; Einträge per Drag verschieben, ändern, hinzufügen, löschen.
- **Sicherheit.** Immer nur **ein Ventil gleichzeitig** offen, Regen-/Frost-/
  Wind-Verzicht, Tagesbudgets, Cycle-and-Soak, PV-bevorzugt, Mäher-Koordination.
- Direkte GARDENA-Anbindung über deinen eigenen Husqvarna-Application-Key — kein
  separates Gardena-Plugin nötig.

### Dashboard (PWA)

Selbst gehostetes Dashboard auf der HCU (`http://<deine-hcu>.local:8089/`) mit
Haus-Twin, Wetter (Radar, Wind, DWD-Warnungen, interaktive Diagramme),
Bewässerung, Automatik und Einstellungen. Responsiv, automatisches Hell/Dunkel.

## Auf der HCU installieren

1. Neueste `heatshield-<version>-arm64.tar.gz` von der
   [Releases](../../releases)-Seite laden (oder selbst bauen, siehe unten).
2. In **HCUweb → Plugins** die `.tar.gz` hochladen.
3. Konfigurationsseite öffnen und **Standort** (Breite, Länge, Zeitzone) sowie
   ggf. **Quellen** (FusionSolar-URL, Open-Meteo / native Sensoren) und
   **GARDENA**-Key/Secret setzen.
4. Dashboard danach unter `http://<deine-hcu>.local:8089/`.

Das Image muss `arm64` sein und als `.tar.gz` hochgeladen werden.

## Selbst bauen

Voraussetzungen: Node.js ≥ 20 und Docker (mit `buildx` für arm64).

```bash
npm install          # Toolchain installieren
npm run build        # tsc (Engine + SPA) → dist/ und SPA bündeln
npm test             # vitest --run
npm run lint         # eslint, --max-warnings=0
npm run build:image  # arm64-Image → .tmp-assets/heatshield-<version>-arm64.tar.gz
```

Die entstehende `.tar.gz` über HCUweb hochladen. Unter Windows läuft der
Image-Build über `scripts/build-image.ps1` (via `npm run build:image`).

## Konfiguration

Alles wird auf der Konfigurationsseite / im Dashboard (Einstellungen)
eingestellt — nichts ist auf ein bestimmtes Zuhause fest verdrahtet.

- **Standort** — Breite / Länge / Zeitzone (Sonnenstand, Wetter, Auf-/Untergang).
- **Quellen** — Signale (Außentemperatur, PV, Wind, Strahlung, Prognose) an
  FusionSolar, Open-Meteo oder native HMIP-Geräte binden.
- **Räume & Fenster** — je Raum: Stockwerk, Priorität, Fassaden-Ausrichtung,
  Dach- vs. Fassadenfenster, Komfortziele.
- **Automatik** — Schwellen der Betriebsmodi, Sturm-Windgrenze usw.
- **Bewässerung** — globale ET-Einstellungen plus Zonen-Profil, GARDENA-Ventil
  und optionaler Feuchtesensor.
- **Benachrichtigungen** — optionaler Telegram-Bot.

Laufzeitstand und gelernte Modelle liegen nur unter dem `/data/`-Volume.

## Fehlerbehebung

Siehe [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) (zweisprachig).
Schnellhilfe:

- **Dashboard zeigt „Something went wrong"** → Browser-Konsole und Plugin-Log
  (HCUweb-Log-Panel) prüfen.
- **Keine Geräte / Sensoren** → Quellen-Bindungen prüfen; für GARDENA unter
  Einstellungen → Bewässerung die Verbindung testen.
- **Bewässerung tut nichts** → den **Automatik-Schalter** oben im Bewässerung-
  Tab einschalten.
- **Connect-Log zeigt `ERROR_RESPONSE`** → ein Feature/Enum-Wert wurde von der
  HCU abgelehnt; prüfen, ob die Plugin-Version aktuell ist.

## Autor

Fabio Renner ([@fabiorenner-hub](https://github.com/fabiorenner-hub)).

## Lizenz

[Apache License 2.0](LICENSE).
