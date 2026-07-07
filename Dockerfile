# Heat Shield â€” Multi-stage container build (Task 15.1).
#
# Build stage: standard `node:20-alpine` (multi-arch, ships npm + tsc).
# Runtime stage: HMIP's `alpine-node-typescript:0.0.1` (arm64-only â€” the
# HCU's CPU). The HMIP runtime image is intentionally minimal: it ships
# `node` but **not** `npm`, so we cannot `npm ci --omit=dev` there. The
# build stage prunes dev deps and the runtime stage copies the resulting
# `node_modules/` over.
#
# Cross-platform note: this Dockerfile is meant to produce arm64 images
# (the only architecture the HCU runs). Build on an x86_64 host with:
#
#   docker buildx build --platform=linux/arm64 -t heatshield:0.1.0 .
#
# Plain `docker build` on x86_64 ALSO works because we pin the runtime
# stage to `--platform=linux/arm64`; QEMU handles the cross-execution.
#
# Image size target: â‰¤ 200 MB compressed once layers are squashed
# (steering â€” keep the runtime image tight enough to deploy via the
# HCU's plugin manager without timing out).

ARG HEATSHIELD_VERSION=2.0.5
# Unique per-build stamp so the running plugin can report exactly
# which image is live (the dashboard surfaces it). Pass at build:
#   docker buildx build --build-arg BUILD_ID=$(date ...) ...
ARG BUILD_ID=dev

# ---- Build stage ---------------------------------------------------------
# `$BUILDPLATFORM` is the platform of the host running buildx, so the
# build stage runs natively (no QEMU emulation, much faster). The
# resulting `node_modules/` only contains pure-JS packages (no native
# bindings in our dep tree), so it's safe to copy across architectures.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /build

# Install full deps for compilation (including dev deps for tsc + esbuild).
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy sources and assets the build needs.
COPY tsconfig.json tsconfig.spa.json ./
COPY src ./src

# Compile + bundle. Output:
#   - dist/plugin/**.js                    (tsc engine + persistence + dashboard)
#   - src/plugin/dashboard/public/app.js   (esbuild SPA bundle)
RUN npm run build

# Prune dev dependencies in place so the runtime stage can reuse the
# resulting `node_modules/` without needing `npm` itself.
RUN npm prune --omit=dev

# ---- Runtime stage -------------------------------------------------------
# No `--platform=` here on purpose: BuildKit defaults the runtime FROM
# to `$TARGETPLATFORM`, which is whatever `docker buildx build
# --platform=...` picks. The HCU runs arm64, so CI / CD must invoke
# `docker buildx build --platform=linux/arm64`. For local dev on
# x86_64, `--platform=linux/amd64` works just as well.
FROM ghcr.io/homematicip/alpine-node-typescript:0.0.1 AS runtime

ARG HEATSHIELD_VERSION
ENV NODE_ENV=production \
    HEATSHIELD_VERSION=${HEATSHIELD_VERSION} \
    NODE_ICU_DATA=/usr/share/icu/74.2

# Re-declare the build-stamp ARG in this stage and bake it into the
# runtime env so the plugin can report the live build.
ARG BUILD_ID=dev
ENV HEATSHIELD_BUILD=${BUILD_ID}

WORKDIR /app

# Copy production deps + compiled artefacts from the build stage. Doing
# the prune in build (instead of installing fresh in runtime) is the
# only path that works because the HMIP runtime image does not ship
# `npm`.
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# Static dashboard assets (index.html + bundled app.js + styles.css).
# `dist/` does not include these because the engine tsconfig has
# rootDir=src, outDir=dist, so we explicitly carry the public/ folder
# from the build stage where esbuild has already minified app.js.
COPY --from=build /build/src/plugin/dashboard/public ./dist/plugin/dashboard/public

# Plugin metadata for the HCU plugin manager. JSON is single-line so
# `docker inspect --format` parses it cleanly.
#
# Schema: Connect API spec Â§4.1 (image requirements). Field types
# strictly enforced by the HCU validator on upload:
#   - friendlyName / description : Map<String,String> (ISO-639-1 keys)
#   - changelog                  : String (NOT a map â€” caused
#                                  "Plugin nicht valide" with v0.1.0)
#   - logsEnabled                : boolean (enables HCUweb log view)
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"de.fr.renner.plugin.heatshield","version":"2.0.5","issuer":"Fabio Renner","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"Hitzeschutz","en":"Heat Shield"},"description":{"de":"Vorausschauende, lernende Rollladensteuerung für sommerlichen Hitzeschutz auf Basis von Sonnenstand, Wetter und PV-Erzeugung.","en":"Predictive, self-learning shutter control for summer heat protection driven by sun position, weather and PV production."},"changelog":"2.0.5 - Gebaeude-Studio: Stockwerke lassen sich wieder loeschen (Inline-Bestaetigung statt blockiertem System-Dialog). Fenster, Tueren und Durchgaenge werden per zwei Klicks auf der Wand platziert (Ort + Groesse = Distanz), mit Live-Vorschau; an der Oeffnung entsteht eine echte Aussparung in der Wand samt Tuer-/Fenster-Symbol, nichts wird mehr ueberlagert. 2.0.4f2 - Hausuebersicht: die farbige Temperatur-Kante der Raum-Kacheln ist wieder deutlich als Farbband sichtbar und faerbt sich immer nach dem Messwert (gruen unter 24, blau 24-26, rot ueber 26 Grad), sofern eine Messung vorliegt. 2.0.4f1 - Gebaeude-Studio 3D verbessert: Das Dach beschneidet jetzt immer die Raeume (keine durchstossenden Waende mehr). Daecher haben nur noch Schraegflaechen - Giebel, Krueppelwalm-Giebel und Kniestock werden aus der obersten Wand gebildet, die bis zum Dach aufgefuellt wird. Dachueberstand wirkt jetzt in 3D (Standard 1 m, haengt entlang der Neigung herunter, First bleibt auf Wandhoehe). Dachfenster sitzen im Dach (nicht in der Wand) und lassen PV-Aussparungen; PV liegt auf der Dachschraege statt auf dem Deckel. Wand-Bezugskante (Mitte/Aussen/Innen) beim Zeichnen und Snapping auf Wand-Innen-/Aussenkanten; saubere L-Ecken auch am Raum-Schlusspunkt. Raeume und Fenster lassen sich mit der HeatShield-Konfiguration verknuepfen. 2.0.4 - Gebaeude-Studio stark erweitert: Grundriss zeichnen mit Auto-Schluss (Wand/Raum schliesst am Startpunkt), feineres Raster (1-10 cm), starkes Snapping auf vorhandene Ecken; Punkte nachtraeglich verschieben (ziehen) und loeschen (Alt+Klick). Fenster und Tueren mit Hoehe/Breite/Verglasung (1/2/3-fach) und Dachfenster, jetzt auch im 2D-Plan sichtbar. Waende mit Standard-Dicke (Innen/Aussen). Raumliste mit Namen und m2. Keller anlegbar; 2D- und 3D-Ansicht im selben Bereich. Kompaktere Oberflaeche (Projekt in der Kopfzeile, Mehr-Menue, schliessbare Hilfe-Kachel). Hausuebersicht: Kachel-Flaechen faerben nach Raumtemperatur (gruen/blau/rot), Fenster-Symbol in Textfarbe. 2.0.3f2 - Pull-to-Refresh: am Seitenanfang nach unten ziehen laedt die Seite neu (fuer iOS, wo es keine native Geste gibt); Glas-Indikator folgt dem Zug. 2.0.3f1 - Mobile-Feinschliff: Wetter-Chip rechtsbuendig im gestapelten Header, Automatik-Schalter mit gleicher Glas-Transparenz wie der Wetter-Chip, doppelte Scrollbalken behoben (overflow-x clip statt hidden), Bottom-Navigation verteilt sich flexibel und passt vollstaendig. 2.0.3 - Mobile UI ueberarbeitet: neue iPhone-taugliche Bottom-Navigation mit Beschriftung (alle Bereiche erreichbar), Wetter-Chip zeigt den Ort, Automatik-Schalter mit Text auf dem Handy, Titel nicht mehr unter der Notch abgeschnitten. Einstellungs-Kacheln exakt im Liquid-Glass-Look. Symbol-Schatten und Kachel-Rahmen (Staerke und Farbe) konfigurierbar. Layout-Fix: kompakte Icon-Leiste bricht schmale Fenster nicht mehr (keine doppelten Scrollbalken). 2.0.2 - Hausuebersicht neu: Raum-Kacheln im klaren Kachelraster (max. 4x3) mit reichem Klick-Popup samt manueller Steuerung (Auf/50/Zu), ohne 3D-Haus im Hintergrund; der Hero oben fuellt den freien Platz. Popup und Detailansicht jetzt im Liquid-Glass-Design; Chips im Glas-Look passend zu den Raeumen. Darstellung erweitert: konfigurierbare Status-Farbpalette, Theme-Import/-Export und Ueberspeichern eigener Presets. Unterstuetzung fuer HmIP-HDM1 Beschattungsmodule. 2.0.1 - Hausuebersicht: alle Raeume werden jederzeit ohne Scrollen angezeigt. 2.0.0 â€” Komplett neue Oberflaeche Liquid Glass, jetzt Standard fuer alle Installationen (die klassische 1.20-Oberflaeche bleibt unter Darstellung waehlbar). Frosted-Glass-Design mit linker Seitenleiste; pro Seite eine ruhige Basis- und eine tiefe Experten-Ansicht. Voll konfigurierbare Darstellung (Presets inkl. eigener, Akzentfarbe, Hell-/Dunkel-/Auto-Schema, Hintergrundbild, Glas-Staerke, Symbol-Kacheln) mit High-FPS-Optionen. Neuer gefuehrter Einrichtungs-Assistent (Standort, PV-Anlage inkl. anderer Watt-Geraete, GARDENA, Raeume und Rolllaeden). Neu unterstuetzt werden HmIP-HDM1 Beschattungsmodule (Hunter Douglas / erfal), die automatisch erkannt und wie Rolllaeden angesteuert werden. Zweisprachig DE/EN. Vorheriger oeffentlicher Stand war 1.20.0 (Stockwerk-Beschattung, Hitzetag-Schutz, Alert-Modus mit DWD-Warnstufen, Bewaesserungsplaner).","logsEnabled":true}'

# Dashboard listens on port 8089 by default (see Config.dashboard.port).
EXPOSE 8089

# Health: dashboard returns 200 on `/api/state` once the boot module
# has wired the snapshot dep. Failure flips the container to unhealthy
# without restarting the process. wget is part of busybox in the HMIP
# alpine image.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:8089/api/state || exit 1

CMD ["node", "dist/plugin/index.js"]
