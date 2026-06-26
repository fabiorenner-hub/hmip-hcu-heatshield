# HMIP HCU Plugin: Heat Shield

[Deutsche Version → `README.de.md`](README.de.md)

A [Homematic IP](https://www.homematic-ip.com/) Home Control Unit (HCU) plugin
that controls external roller shutters **predictively** to protect rooms from
summer overheating — and, optionally, runs a full **ET-based garden irrigation**
system through GARDENA smart devices.

`pluginId: de.fr.renner.plugin.heatshield`

It combines live PV data (from the FusionSolar plugin), weather forecasts
(Open-Meteo), and native HMIP sensors into a per-room thermal forecast and a
per-window risk model, then drives the shutters via the official Connect API —
aiming for **as few shutter movements as necessary, as much daylight as
possible, cooling first**. A premium, self-hosted PWA dashboard visualizes
everything and lets you tune it.

> Heads-up: this is a personal, self-hosted hobby project, not an official
> eQ-3 product. Use at your own risk.

## Support

Found a bug or have a question? Please
[open an issue](../../issues). Include your HCU firmware version, the plugin
version (Einstellungen → Updates), and the relevant lines from the Connect log
(Einstellungen → Diagnose → Connect-Protokoll).

## What it does

### Heat protection (shutters)

- **Predictive control.** A 12 h per-room thermal forecast (sun position,
  weather curve, PV, building inertia, window geometry) picks the shutter
  position that keeps the room comfortable over the whole horizon with the
  fewest moves.
- **Self-learning.** Day to day, the plugin learns a bounded comfort bias per
  room, factors each room's measured solar gain (indoor peak vs. outdoor max)
  to shade strongly-heating rooms earlier, and self-calibrates each room's
  thermal inertia from predicted-vs-actual peaks.
- **Operating modes.** `NORMAL` · `SUMMER_WATCH` · `ACTIVE_HEAT_PROTECTION` ·
  `HEATWAVE` · `NIGHT_COOLING` · `STORM` (highest priority) · `VACATION` ·
  `MAINTENANCE`.
- **Shutter convention.** 0 % = open, **95 % = strongest automatic close**
  (anti-heat-buildup gap), 100 % only manual / for roof windows.
- **Advisory modules.** Ventilation and active-cooling hints (gated on PV
  surplus); optional Telegram alerts for storm, extreme heat and high UV.

### Irrigation (optional, GARDENA)

- **ET-based water balance (FAO-56) per zone.** Tracks soil-water depletion
  from reference evapotranspiration (Open-Meteo `et0_fao_evapotranspiration`),
  effective rainfall and applied irrigation; waters only when the readily
  available water is used up, deep and infrequent.
- **Learning + forecast.** Calibrates each zone's crop coefficient and emitter
  rate from the measured soil-moisture response, detects faulty emitters, and
  forecasts the next watering.
- **Editable day-ahead plan.** A draggable timeline shows which valve runs when
  and for how long; entries can be moved, resized, toggled, added or deleted.
- **Safety + coordination.** Only **one valve open at a time** (shared supply),
  rain/frost/wind skips, daily budgets, cycle-and-soak, PV-preferred watering,
  mower coordination, optional pump socket.
- Direct GARDENA smart system integration via your own Husqvarna Application
  key/secret — no separate Gardena plugin required.

### Dashboard (PWA)

A self-hosted dashboard on the HCU (`http://<your-hcu>.local:8089/`) with a
house digital-twin (live sky, sun arc, per-room badges, heat-map, 12 h shutter
preview), weather (radar, wind, DWD warnings, interactive deep-dive charts),
irrigation, automation and settings. Responsive, automatic light/dark theme.

## Install on your HCU

1. Download the latest `heatshield-<version>-arm64.tar.gz` from the
   [Releases](../../releases) page (or build it yourself, see below).
2. In **HCUweb → Plugins**, upload the `.tar.gz`.
3. Open the plugin's config page and set your **location** (latitude,
   longitude, timezone) and, if used, your **source bindings** (FusionSolar
   base URL, Open-Meteo / native sensors) and **GARDENA** key/secret.
4. The dashboard is then reachable at `http://<your-hcu>.local:8089/`.

The image must be `arm64` (the HCU's CPU) and uploaded as a `.tar.gz`.

## Build it yourself

Requirements: Node.js ≥ 20 and Docker (with `buildx` for arm64).

```bash
npm install          # install the toolchain
npm run build        # tsc (engine + SPA) → dist/ and bundle the SPA
npm test             # vitest --run
npm run lint         # eslint, --max-warnings=0
npm run build:image  # build the arm64 image → .tmp-assets/heatshield-<version>-arm64.tar.gz
```

Then upload the resulting `.tar.gz` via HCUweb. On Windows the image build runs
through `scripts/build-image.ps1` (invoked by `npm run build:image`).

## Configuration

All configuration is done on the plugin's config page / dashboard
(Einstellungen). Nothing is hard-coded to a specific home.

- **Location** — latitude / longitude / timezone (drives sun position, weather,
  sunrise/sunset).
- **Sources** — bind the signals (outdoor temperature, PV power, wind,
  radiation, forecast) to FusionSolar, Open-Meteo or native HMIP devices.
- **Rooms & windows** — per room: floor, priority, facade orientation, roof vs.
  facade window, comfort targets.
- **Automation** — thresholds for the operating modes, storm wind limit, etc.
- **Irrigation** — global ET settings plus per-zone plant/soil/emitter profile,
  the GARDENA valve and an optional soil-moisture sensor.
- **Notifications** — optional Telegram bot for alerts.

Runtime state and learned models are persisted under the `/data/` volume only.

## Troubleshooting

See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for a detailed guide
(bilingual). Quick pointers:

- **Dashboard shows "Something went wrong"** → check the browser console and
  the plugin log (HCUweb plugin log panel).
- **No devices / sensors appear** → verify the source bindings and, for
  GARDENA, test the connection under Einstellungen → Bewässerung.
- **Irrigation does nothing** → make sure the **automatic irrigation** master
  switch (top of the Bewässerung tab) is **on**.
- **Connect log shows `ERROR_RESPONSE` / deserialization errors** → a feature
  or enum value was rejected by the HCU; check the plugin version is current.

## Author

Fabio Renner ([@fabiorenner-hub](https://github.com/fabiorenner-hub)).

### Third-party components

- [Preact](https://preactjs.com/) — dashboard UI (MIT).
- [Leaflet](https://leafletjs.com/) + [RainViewer](https://www.rainviewer.com/) — rain radar (BSD-2 / API).
- [SunCalc](https://github.com/mourner/suncalc) — sun position (BSD-2).
- [Fastify](https://fastify.dev/) — dashboard HTTP server (MIT).
- [Zod](https://zod.dev/) — config validation (MIT).
- Weather data: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- Severe-weather warnings: [Deutscher Wetterdienst (DWD)](https://www.dwd.de/).

## License

[Apache License 2.0](LICENSE).
