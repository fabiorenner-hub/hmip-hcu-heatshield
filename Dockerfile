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

ARG HEATSHIELD_VERSION=1.20.0
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
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"de.fr.renner.plugin.heatshield","version":"1.20.0","issuer":"Fabio Renner","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"Hitzeschutz","en":"Heat Shield"},"description":{"de":"Vorausschauende, lernende Rollladensteuerung für sommerlichen Hitzeschutz auf Basis von Sonnenstand, Wetter und PV-Erzeugung.","en":"Predictive, self-learning shutter control for summer heat protection driven by sun position, weather and PV production."},"changelog":"1.20.0 — Stockwerk-Beschattung: Obergeschosse (OG/DG) werden frueher beschattet als Erd- und Kellergeschoss, pro Stockwerk einstellbar. Hitzetag-Schutz: ab 35 Grad mit Sonne (PV-Leistung) fahren Rolllaeden nicht weiter als 50 Prozent auf (einstellbar). Raeume mit mobiler Klimaanlage koennen vom Lernen ausgenommen werden, damit verfaelschte Messwerte das Modell nicht stoeren. Alert-Modus: Titel jetzt Unwetterwarnung, Rahmen und Text in der DWD-Warnstufenfarbe (gelb, orange, rot, violett), mit X ausblendbar und als Mini-Hinweis wieder einblendbar; waehrend einer Warnung halbiert sich das Automatik-Zyklusintervall (mindestens 300 Sekunden). Pro Rollladen lassen sich Sperrzeiten festlegen (Wochentage plus Uhrzeit, z. B. Dachfenster Mo bis Fr 22:00 bis 10:00 nicht bewegen). Telegram-Haeufigkeit der Unwetterwarnung einstellbar (aus, nur Aenderungen, alle 30, 60 oder 90 Minuten). 1.19.1 — Alert-Modus: roter Rahmen auch bei DWD-Hitzewarnungen (vorher faelschlich gelb); Regenradar hoeher. 1.19.0 — Neuer Alert-Modus (Katastrophenschutz-Zentrale) bei DWD-Warnung ab Stufe Rot: Warnung mit Handlungshinweis, Live-Werte (Gewitter, Wind, Niederschlag), 15-Minuten-Niederschlag und kompaktes Regenradar auf Startseite und Wetter-Tab, je Tab abschaltbar. DWD-Unwetterwarnungen jetzt auch per Telegram (sofort, 30-Minuten-Lage-Updates, Entwarnung). Der Ort fuer die Warnungen ist im UI einstellbar (Standard Berlin), wird im Assistenten aus den Koordinaten vorgeschlagen, und Warnungen werden auch auf Landkreis-Ebene erkannt. Sofort-Warnung bei offenen Fenstern und besonders Dachfenstern waehrend Sturm oder Regen ueber Telegram und Dashboard. Regenradar mit klarer Trennung von Verlauf, Jetzt und Vorhersage plus 2-Stunden-Niederschlagsstreifen. Bewaesserung: AUTO-Knopf im Planer fuer die optimale, taeglich neu berechnete Strategie. Mobile Navigation nutzbar. 1.18.5 — Mobile: der Automatik-Schalter in der Kopfzeile schrumpft auf dem Smartphone zum reinen Schalter, sodass die Navigation wieder bedienbar ist. Nächste Aktionen und die 12-Stunden-Vorschau zeigen Fenster mit aktiver Übersteuerung oder ausgeschalteter Automatik jetzt als gehalten (keine Fahrt) an, statt eine geplante Fahrt anzuzeigen, die gar nicht ausgefuehrt wird. 1.18.4 — Fix: Schalten der Plugin-Geraete Hitzeschutz pausiert und Urlaub in der Homematic-App wirkt jetzt sofort auf Status und Automatik, statt erst nach einem Neustart (der Schaltbefehl wurde bisher nur gespeichert, aber nicht in den laufenden Zustand uebernommen). 1.18.3 — Beschattung folgt der tatsaechlichen Sonnenlast: an heissen aber bewoelkten Phasen bleiben die Rolllaeden fuer Tageslicht offen statt unnoetig zu schliessen und schliessen automatisch sobald wieder Sonne da ist (ein geschlossener Rollo kuehlt einen warmen Raum nicht, wenn keine Sonne anliegt). Neuer Live-PV-Nowcast: bricht die PV-Leistung durch aufziehende Wolken ein, korrigiert das Plugin die Strahlungsprognose der naechsten Stunden sofort statt der traegeren Wettervorhersage zu folgen. Die Anlagen-Ausrichtung lernt das Plugin ausserdem selbst aus der PV-Leistungskurve, sodass der Nowcast ohne manuelle Eingabe weiss, wann die Sonne auf die Module scheint. Korrektur: Raeume mit aktiver manueller Uebersteuerung werden in der 12-Stunden-Rollladen-Vorschau jetzt als gehalten dargestellt (mit Manuell-Markierung) statt eine Fahrt anzuzeigen, die wegen der Uebersteuerung gar nicht ausgefuehrt wird. 1.18.2 — Regenradar: die Bedien-Elemente der Karte (Zoom-Buttons und Quellenangabe) waren hell und passen sich jetzt dem dunklen UI an. 1.18.1 — Logs und Debug: neuer Button Alle Informationen — ein 360-Grad-Diagnose-Export, der alle Status- und Diagnose-Endpunkte, die API-Werkzeuge, das Connect-Protokoll sowie Browser- und System-Informationen in einer einzigen .txt-Datei bündelt (ideal für Bug-Reports). 1.18.0 — Premium-UI-Politur: durchgehend einheitliche Karten-Radien, Schatten und Abstände, eine klare Typo-Skala für Überschriften und Karten-Titel sowie einheitliche Form-Elemente (Eingaben, Buttons, Chips). Zu kleine Mikro-Beschriftungen auf eine lesbare Mindestgröße angehoben. Mobile-Fix: breite Tabellen (Quellen, Diagnose) sprengen nicht mehr den Bildschirm, sondern scrollen sauber horizontal. 1.17.2 — Wetter-Tab kompakter: Wind ist jetzt eine kompakte Zeile über dem Regenradar (volle Breite, nur so hoch wie nötig), das Regenradar liegt darunter über die ganze Breite — keine ungenutzte Fläche mehr. Fix: der Pflanzentyp (z. B. Rasen, Hecke) auf den Bewässerungs-Zonenkarten wird jetzt auch in der deutschen Version übersetzt angezeigt statt englisch. 1.17.1 — Einheitlicher Dark-Look: mehrere Bereiche (Lern-Vorschläge, Geräte-Suche, Szenen- und Schnellzugriff-Buttons, Sicherung importieren) hatten noch helle Reste aus einem früheren Design und passen sich jetzt der dunklen Oberfläche an. 1.17.0 — Mehrsprachigkeit: das komplette Dashboard gibt es jetzt auf Deutsch und Englisch. Die Sprache folgt automatisch dem Browser (Deutsch als Fallback) und lässt sich unter Einstellungen, Darstellung und Sprache pro Gerät auf AUTO, Deutsch oder Englisch stellen. Alle Tabs, Diagramme, Empfehlungen und Hinweise sind übersetzt; Zahlen folgen dem Sprachformat. Telegram-Benachrichtigungen haben eine eigene Sprachwahl in den Einstellungen. Windrose vergrößert und überarbeitet (mit Bewölkungsanzeige). Der Ambient-Hintergrund-Schalter ist von der Kopfzeile in die Einstellungen gewandert. 1.16.8 — Update-Hinweis: prüft GitHub auf eine neuere Version als die installierte und zeigt das oben am Versions-Badge (Klick führt zur Updates-Seite mit GitHub-Link). Neue Einstellungen-Kachel Logs und Debug: Live-Connect-Protokoll, alle Diagnose-Endpunkte als Roh-JSON mit Kopieren/Download und Build-Infos. Hilfe ist jetzt ein kompakter Funktions-Überblick mit Kurzerklärungen statt eines langen Handbuchs. 1.16.7 — Fix: SPA-Fallback fürs Routing. 1.16.6 — Dive-Deep-Diagramme sind jetzt interaktiv (Fadenkreuz + Werte-Tooltip beim Überfahren) und werden nicht mehr verzerrt — die Kurven/Beschriftungen rendern pixelgenau (1:1) statt horizontal gestreckt. Einheitliche Karten-Titel (kein großer Leerraum mehr über der Überschrift) und angemessene Schriftgrößen über alle Tabs. Wetter-Tab: Wind-Kachel füllt jetzt die Höhe des Regenradars und zeigt zusätzlich die Bewölkung. 1.16.5 — Planer reagiert sofort: Änderungen (Verschieben, Dauer, an-aus, hinzufügen, löschen) werden jetzt optimistisch direkt angezeigt, statt auf die nächste Server-Aktualisierung zu warten. Dauer-Dropdown zeigt jetzt immer den korrekten Wert (auch krumme Auto-Dauern); Auto-Dauern werden auf 5-Minuten gerundet. 1.16.4 — Fix: Der Bewässerungsplan wurde auch dann ausgeführt, wenn die automatische Bewässerung ausgeschaltet war. Geplante Einträge werden jetzt nur bei eingeschalteter Automatik dispatcht (die Vorschau bleibt sichtbar). 1.16.3 — Wetter-Tab überarbeitet: einheitliche Karten-Überschriften (vorher teils klein-GROSS, teils fett) und sinnvolle Reihenfolge — Aktuelle Werte, 24-h-Vorhersage, Radar und Wind, Diagramme, gemessener Verlauf, dann Innenraum-Prognose und Wirkung klar abgetrennt am Ende. 1.16.2 — Planer: geplante Bewässerungen dürfen sich nicht mehr überschneiden — es ist nie mehr als ein Ventil gleichzeitig offen, jetzt auch im Plan erzwungen (Verschieben/Hinzufügen mit Überschneidung wird abgelehnt; Auto-Einträge weichen automatisch aus). Drag spürbar flüssiger (Track-Geometrie wird gecacht, weniger Re-Renders). Die blaue Linie in den Zonen-Karten ist jetzt als Bodenwasser-Prognose (3 Tage) beschriftet. 1.16.1 — Fix: Bewässerung- und Updates-Tab ließen sich nicht öffnen (Fragment is not defined). 1.16.0 — Bewässerung überarbeitet: Automatik-Schalter, Dauer-Auswahl, Tagesplan-Editor (Drag verschieben, Dauer/an-aus, löschen, hinzufügen), Boden-Kalibrierung, Gardena-Sensor-Kachel, Ventile deaktivierbar, triggerBias.","logsEnabled":true}'

# Dashboard listens on port 8089 by default (see Config.dashboard.port).
EXPOSE 8089

# Health: dashboard returns 200 on `/api/state` once the boot module
# has wired the snapshot dep. Failure flips the container to unhealthy
# without restarting the process. wget is part of busybox in the HMIP
# alpine image.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --spider http://localhost:8089/api/state || exit 1

CMD ["node", "dist/plugin/index.js"]
