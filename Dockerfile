# Heat Shield — Multi-stage container build (Task 15.1).
#
# Build stage: standard `node:20-alpine` (multi-arch, ships npm + tsc).
# Runtime stage: HMIP's `alpine-node-typescript:0.0.1` (arm64-only — the
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
# Image size target: ≤ 200 MB compressed once layers are squashed
# (steering — keep the runtime image tight enough to deploy via the
# HCU's plugin manager without timing out).

ARG HEATSHIELD_VERSION=1.16.8
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
# Schema: Connect API spec §4.1 (image requirements). Field types
# strictly enforced by the HCU validator on upload:
#   - friendlyName / description : Map<String,String> (ISO-639-1 keys)
#   - changelog                  : String (NOT a map — caused
#                                  "Plugin nicht valide" with v0.1.0)
#   - logsEnabled                : boolean (enables HCUweb log view)
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"de.fr.renner.plugin.heatshield","version":"1.16.8","issuer":"Fabio Renner","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"Hitzeschutz","en":"Heat Shield"},"description":{"de":"Vorausschauende, lernende Rollladensteuerung für sommerlichen Hitzeschutz auf Basis von Sonnenstand, Wetter und PV-Erzeugung.","en":"Predictive, self-learning shutter control for summer heat protection driven by sun position, weather and PV production."},"changelog":"1.16.8 — Update-Hinweis: prüft GitHub auf eine neuere Version als die installierte und zeigt das oben am Versions-Badge (Klick führt zur Updates-Seite mit GitHub-Link). Neue Einstellungen-Kachel Logs und Debug: Live-Connect-Protokoll, alle Diagnose-Endpunkte als Roh-JSON mit Kopieren/Download und Build-Infos. Hilfe ist jetzt ein kompakter Funktions-Überblick mit Kurzerklärungen statt eines langen Handbuchs. 1.16.7 — Fix: SPA-Fallback fürs Routing. 1.16.6 — Dive-Deep-Diagramme sind jetzt interaktiv (Fadenkreuz + Werte-Tooltip beim Überfahren) und werden nicht mehr verzerrt — die Kurven/Beschriftungen rendern pixelgenau (1:1) statt horizontal gestreckt. Einheitliche Karten-Titel (kein großer Leerraum mehr über der Überschrift) und angemessene Schriftgrößen über alle Tabs. Wetter-Tab: Wind-Kachel füllt jetzt die Höhe des Regenradars und zeigt zusätzlich die Bewölkung. 1.16.5 — Planer reagiert sofort: Änderungen (Verschieben, Dauer, an-aus, hinzufügen, löschen) werden jetzt optimistisch direkt angezeigt, statt auf die nächste Server-Aktualisierung zu warten. Dauer-Dropdown zeigt jetzt immer den korrekten Wert (auch krumme Auto-Dauern); Auto-Dauern werden auf 5-Minuten gerundet. 1.16.4 — Fix: Der Bewässerungsplan wurde auch dann ausgeführt, wenn die automatische Bewässerung ausgeschaltet war. Geplante Einträge werden jetzt nur bei eingeschalteter Automatik dispatcht (die Vorschau bleibt sichtbar). 1.16.3 — Wetter-Tab überarbeitet: einheitliche Karten-Überschriften (vorher teils klein-GROSS, teils fett) und sinnvolle Reihenfolge — Aktuelle Werte, 24-h-Vorhersage, Radar und Wind, Diagramme, gemessener Verlauf, dann Innenraum-Prognose und Wirkung klar abgetrennt am Ende. 1.16.2 — Planer: geplante Bewässerungen dürfen sich nicht mehr überschneiden — es ist nie mehr als ein Ventil gleichzeitig offen, jetzt auch im Plan erzwungen (Verschieben/Hinzufügen mit Überschneidung wird abgelehnt; Auto-Einträge weichen automatisch aus). Drag spürbar flüssiger (Track-Geometrie wird gecacht, weniger Re-Renders). Die blaue Linie in den Zonen-Karten ist jetzt als Bodenwasser-Prognose (3 Tage) beschriftet. 1.16.1 — Fix: Bewässerung- und Updates-Tab ließen sich nicht öffnen (Fragment is not defined). 1.16.0 — Bewässerung überarbeitet: Automatik-Schalter, Dauer-Auswahl, Tagesplan-Editor (Drag verschieben, Dauer/an-aus, löschen, hinzufügen), Boden-Kalibrierung, Gardena-Sensor-Kachel, Ventile deaktivierbar, triggerBias.","logsEnabled":true}'

# Dashboard listens on port 8089 by default (see Config.dashboard.port).
EXPOSE 8089

# Health: dashboard returns 200 on `/api/state` once the boot module
# has wired the snapshot dep. Failure flips the container to unhealthy
# without restarting the process. wget is part of busybox in the HMIP
# alpine image.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --spider http://localhost:8089/api/state || exit 1

CMD ["node", "dist/plugin/index.js"]
