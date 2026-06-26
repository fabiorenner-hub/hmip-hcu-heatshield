# Troubleshooting / Fehlerbehebung

Bilingual guide. English first, **Deutsch darunter**.

When reporting a bug, please include: HCU firmware version, plugin version
(Einstellungen → Updates), the running build stamp, and the relevant lines from
**Einstellungen → Logs & Debug** (Connect log + the `State` / `Diagnostics`
endpoint output).

---

## English

### The dashboard shows "Something went wrong."
The SPA caught a render error.
- Open the browser console (F12) and note the error.
- Check the plugin log in the HCUweb plugin panel.
- Make sure you are on the latest plugin version (the version badge top-left
  shows a dot when a newer GitHub release exists).

### Refreshing a tab shows a 404 / JSON error
Fixed in v1.16.7 (SPA history fallback). Update the plugin.

### The plugin doesn't connect to the HCU (Connect API)
- The plugin connects from inside its container to
  `wss://host.containers.internal:9001` using the token at `/TOKEN`.
- In **Einstellungen → Logs & Debug → Connect-Protokoll**, look for the
  `connect-api websocket open` line. If it never appears, the WebSocket has not
  been exposed in HCUweb developer mode, or the token is missing.
- `ERROR_RESPONSE` / `Cannot deserialize …` lines mean the HCU rejected a
  message (an unknown enum/feature). Update to the latest plugin version.

### No devices or sensors appear
- Check the **source bindings** under Einstellungen → Quellen and run the
  discovery / probe there.
- Native HMIP devices are read from `getSystemState`; if none show up, verify
  the Connect WebSocket is connected (see above).

### FusionSolar / PV data missing
- Set the correct FusionSolar base URL under Einstellungen → Quellen
  (default `http://host.containers.internal:8088`).
- Use Logs & Debug → `State` to confirm `sources.fusionSolar.sourceOk`.

### Weather / charts empty
- Weather is fetched client-side from Open-Meteo (needs outbound internet on the
  device showing the dashboard). Check the browser console for blocked requests.

### Irrigation does nothing
- Turn on the **automatic irrigation** master switch at the top of the
  Bewässerung tab. With it off, only manual watering runs.
- The day-ahead plan is executed only when the master switch is on.
- GARDENA: test the connection under Einstellungen → Bewässerung. If
  `sensors: 0`, expand "Erkannte Gardena-Dienste" to see what the API returns.

### GARDENA soil sensor not shown
- Open Einstellungen → Bewässerung → "Verbindung testen" and expand the raw
  service list. Sensors are detected by their attributes
  (`soilHumidity` / `soilTemperature` / …), not by a fixed service type.

### "Defizit 0,0 mm" although it is hot and dry
- The model assumes the soil started at field capacity when a zone is created
  and there is no soil-moisture sensor. Use **Kalibrieren** on the zone card to
  set the real available-water percentage.

### Only one valve runs at a time
By design — a shared water supply. The planner refuses overlapping entries and
the engine never opens a second valve while one is open.

---

## Deutsch

### Dashboard zeigt „Something went wrong."
Die Oberfläche hat einen Render-Fehler abgefangen.
- Browser-Konsole (F12) öffnen und Fehler notieren.
- Plugin-Log im HCUweb-Plugin-Panel prüfen.
- Sicherstellen, dass die neueste Plugin-Version läuft (das Versions-Badge oben
  links zeigt einen Punkt, wenn auf GitHub eine neuere Version vorliegt).

### Neuladen eines Tabs zeigt 404 / JSON-Fehler
Behoben in v1.16.7 (SPA-History-Fallback). Plugin aktualisieren.

### Plugin verbindet sich nicht mit der HCU (Connect API)
- Das Plugin verbindet sich aus seinem Container zu
  `wss://host.containers.internal:9001` mit dem Token unter `/TOKEN`.
- Unter **Einstellungen → Logs & Debug → Connect-Protokoll** nach der Zeile
  `connect-api websocket open` suchen. Fehlt sie, wurde der WebSocket im HCUweb-
  Entwicklermodus nicht freigegeben oder der Token fehlt.
- `ERROR_RESPONSE` / `Cannot deserialize …` heißt: die HCU hat eine Nachricht
  abgelehnt (unbekanntes Enum/Feature). Auf die neueste Version aktualisieren.

### Keine Geräte oder Sensoren sichtbar
- **Quellen-Bindungen** unter Einstellungen → Quellen prüfen und dort die
  Erkennung / den Probelauf starten.
- Native HMIP-Geräte kommen aus `getSystemState`; erscheinen keine, zuerst die
  Connect-Verbindung prüfen (siehe oben).

### FusionSolar / PV-Daten fehlen
- Korrekte FusionSolar-URL unter Einstellungen → Quellen setzen
  (Standard `http://host.containers.internal:8088`).
- Über Logs & Debug → `State` prüfen, ob `sources.fusionSolar.sourceOk` true ist.

### Wetter / Diagramme leer
- Wetter wird clientseitig von Open-Meteo geladen (das anzeigende Gerät braucht
  Internet). Browser-Konsole auf blockierte Anfragen prüfen.

### Bewässerung tut nichts
- Den **Automatik-Schalter** oben im Bewässerung-Tab einschalten. Ist er aus,
  läuft nur manuelles Bewässern.
- Der Tagesplan wird nur bei eingeschalteter Automatik ausgeführt.
- GARDENA: Verbindung unter Einstellungen → Bewässerung testen. Bei
  `sensors: 0` die „Erkannten Gardena-Dienste" aufklappen.

### GARDENA-Bodenfeuchtesensor wird nicht angezeigt
- Einstellungen → Bewässerung → „Verbindung testen" öffnen und die rohe
  Dienste-Liste aufklappen. Sensoren werden über ihre Messwerte erkannt
  (`soilHumidity` / `soilTemperature` / …), nicht über einen festen Typ.

### „Defizit 0,0 mm" obwohl es heiß und trocken ist
- Das Modell nimmt beim Anlegen einer Zone ohne Feuchtesensor an, der Boden sei
  voll. Über **Kalibrieren** auf der Zonen-Karte den realen Verfügbar-Prozentsatz
  setzen.

### Es läuft immer nur ein Ventil
So gewollt — gemeinsame Wasserversorgung. Der Planer lehnt Überschneidungen ab,
und die Engine öffnet nie ein zweites Ventil, solange eines offen ist.
