# Heat Shield  - Multi-stage container build (Task 15.1).
#
# Build stage: standard `node:20-alpine` (multi-arch, ships npm + tsc).
# Runtime stage: HMIP's `alpine-node-typescript:0.0.1` (arm64-only  - the
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
# (steering  - keep the runtime image tight enough to deploy via the
# HCU's plugin manager without timing out).

ARG HEATSHIELD_VERSION=2.0.28
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
#   - changelog                  : String (NOT a map  - caused
#                                  "Plugin nicht valide" with v0.1.0)
#   - logsEnabled                : boolean (enables HCUweb log view)
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"de.fr.renner.plugin.heatshield","version":"2.0.28","issuer":"Fabio Renner","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"Hitzeschutz","en":"Heat Shield"},"description":{"de":"Vorausschauende, lernende Rollladensteuerung für sommerlichen Hitzeschutz auf Basis von Sonnenstand, Wetter und PV-Erzeugung.","en":"Predictive, self-learning shutter control for summer heat protection driven by sun position, weather and PV production."},"changelog":"2.0.28 - Rueckrollung: die Aenderungen am Raeume-Tab aus 2.0.27 (Risiko-Label, Ausblenden der naechsten Aktion bei ausgeschalteter Automatik) werden zurueckgenommen, da sie den Raeume-Tab gestoert haben. Der Raeume-Tab entspricht wieder dem bewaehrten Stand. Die uebrigen 2.0.27-Verbesserungen (Glas-Optik der Touch-Leiste, Fix der Badge-Ueberlappung in Naechste Aktionen, scrollende Vorhersage-Basisansicht) bleiben erhalten. 2.0.27 - Mobile Touch-Leiste optisch an das v2-Design angeglichen (gleiche Glas-Rezeptur wie Karten/Seitenleiste, folgt dem Live-Theme). Naechste Aktionen: Badge-Ueberlappung endgueltig behoben (Text-Container war inline, Ellipsis wirkte nicht - jetzt Flex-Spalte). Vorhersage (Basis): Tagesplan/Prognoseverlauf wurden weiter abgeschnitten - die Seite scrollt jetzt zuverlaessig (Flex-Kinder nicht mehr gestaucht). Raeume: Stufen-Badge klar als Risiko (Ueberhitzungsrisiko) beschriftet, nicht Temperatur. Automatik aus zeigt keine naechsten Aktionen mehr an (Uebersicht und Raeume). 2.0.26 - Mobile Touch-Navigation ist jetzt Standard bei schmaler Breite (Smartphone und Tablet unter 840 px, auch bei schmal gezogenem Desktop-Fenster): statt der alten abgeschnittenen alle-Tabs-Leiste erscheint die schwebende Glas-Leiste unten (4 Tabs plus Mehr), jetzt korrekt im V2-Glas-Look mit Transparenz und Blur. Vorhersage (Basis) scrollt jetzt sauber - Tagesplan und Prognoseverlauf wurden je nach Aufloesung ohne Scrollbalken abgeschnitten. Naechste Aktionen: das Status-Badge ueberlagerte bei langen Namen den Text, jetzt behoben. 2.0.25 - OTA-Installation repariert: ein frisch geladenes OTA-Update wurde beim Neustart faelschlich als beschaedigt eingestuft und automatisch zurueckgerollt. Ursache: der Bootstrap-Loader verglich den Gesamt-Hash der Bundle-Datei mit der entpackten main.js (konnte nie uebereinstimmen). Der Installer persistiert jetzt mainSha256 (Hash der entpackten main.js) und der Loader verifiziert genau diese Datei beim Boot. Hinweis: der Loader ist Teil des Images und nicht OTA-updatebar - dieser Fix greift erst nach einmaliger Installation dieses .tar.gz ueber HCUweb; danach funktionieren OTA-Updates. 2.0.24 - OTA-taugliche Updates: ab dieser Version koennen Aktualisierungen over-the-air (OTA) bereitgestellt werden. 2.0.23 - OTA-Updates werden jetzt standardmaessig automatisch installiert: verifizierte, zum Kern passende Payloads werden ohne Nachfrage geladen und aktiviert (Neustart). Im Tab Updates auf Manuell umstellbar. Sicherheitsnetze unveraendert (nur verifizierte Bundles, Crash-Loop-Rollback aufs Image). 2.0.22 - OTA-faehig: Updates fuer Oberflaeche und reines-JS-Backend koennen jetzt over-the-air aus GitHub Releases geladen werden (automatisch oder manuell im Tab Updates), wenn das Dashboard Internet hat. Kern-Updates (Image, native Abhaengigkeiten, Port) laufen weiterhin per .tar.gz ueber HCUweb. Es werden zwei Versionen gefuehrt und angezeigt: Kern (Image) und OTA (Payload). Ein Bootstrap-Loader laedt nur verifizierte Bundles (sha256, optionale Signatur, Mindest-Kernversion) aus /data/ota und faellt bei Problemen automatisch auf das Image zurueck (Crash-Loop-Schutz mit Rollback). Feste Quelle, nur HTTPS, atomare Aktivierung, keine Secrets im Log. 2.0.21 - Verschattung reagiert klueger auf Hitze und faehrt zur passenden Zeit: (1) Trend-basierter Hitze-Deckel - an heissen, sonnenreichen Tagen wird ein Fenster auch dann schon frueher/staerker geschlossen, wenn die direkte Sonne noch nicht buendig auf der Fassade steht, aber NUR wenn die Prognosekurve dadurch den erwarteten Innen-Peak spuerbar senkt (sonst bleibt es beim tageslicht-freundlichen Geometrie-Deckel). (2) Bewegungen liegen nicht mehr zwangsweise auf der vollen Stunde - der Zeitpunkt jeder Fahrt wird auf den echten Umschaltpunkt verfeinert, den die Modelle liefern (auf 5 Minuten gerundet). 2.0.20 - Drei Verbesserungen: (1) Die neue Apple-Style-Navigationsleiste unten (mit Mehr-Menue) gibt es jetzt auch in der neuen Oberflaeche (v2), nicht nur in v1. (2) Weniger Telegram-Spam: die Meldung Manuelle Bedienung erkannt kommt pro manueller Verstellung nur noch einmal statt bei jeder erneuten Statusmeldung des Rollladens. (3) Hitzetag-Schutz ist jetzt mehrstufig und frei konfigurierbar - z. B. ab 30 Grad 30 Prozent Beschattung, ab 35 Grad 50 Prozent; es gilt die hoechste erreichte Stufe (Regeln, Hitzetag-Schutz). 2.0.18 - PV-Boost: Fenster in Anlagen-Richtung (z. B. SW) werden bei sehr hoher PV-Leistung staerker geschlossen (bis voll) und bleiben zu, solange die Anlage viel liefert - denn die PV-Anlage schaut selbst in diese Richtung. Anlagen-Ausrichtung und die PV-Schwelle (ab wann sehr hoch) sind konfigurierbar unter Regeln, Beschattungs-Strategie; nie ueber den jeweiligen Fenster-Deckel hinaus, Sturm bleibt Vorrang. 2.0.17 - Verschattung faehrt jetzt graduell hoch statt direkt auf 95 Prozent zu springen: die Rollladen-Stellung folgt der tatsaechlichen direkten Sonne auf dem jeweiligen Fenster und steigt schrittweise (z. B. 30 auf 50 auf 75 Prozent), voll geschlossen erst nahe dem Sonnen-Peak. Ein sonniges Fenster bleibt bei kuehlem Raum fuer Tageslicht offen. 2.0.16 - Vorhersage/Tagesplan aufgeraeumt und korrigiert: die Rolllaeden-Zeile im Prognoseverlauf reicht wieder ueber den ganzen Tag (keine leeren Werte ab 08:00 mehr); neue Zeile Sonne auf Fassade zeigt die Himmelsrichtung der Sonne im Tagesverlauf (NO/O/SO/S/SW/W). Geplante Bewegungen und die Diagramm-Skala liegen jetzt auf vollen Stunden (kein 08:20 mehr). Das Tagesplan-Diagramm ist interaktiv (Fadenkreuz beim Ueberfahren, anklickbare Punkte, Tooltips). Rolllaeden koennen einen eigenen Namen tragen statt nur Fenster SW; identische Doppel-Eintraege werden zusammengefasst. Ein Fenster wird nicht mehr geoeffnet, solange direkte Sonne darauf liegt (behebt zu fruehes Oeffnen z. B. auf SO/NW). Passenderes Symbol bei Alle Aktionen anzeigen. 2.0.15 - Engine durchgaengig konfigurierbar: neue Beschattungs-Strategie (Tageslicht / Ausgewogen / Waermeschutz) als ein Regler, dazu ein Abend-Oeffnen-Gate (Fenster oeffnen abends erst, wenn keine Sonne mehr drauf ist, z. B. NW) - pro Raum und Fenster ueberschreibbar. Alle bisher fest verdrahteten Engine-Konstanten (Verschattungs-Schwellen, Off-Sun-Caps, Solar-stark-Schwelle, Segment/Vorausblick, Thermomodell) sind jetzt einstellbar; die Risikogewichte im Profil Benutzerdefiniert sind frei editierbar. Seite Regeln und Grenzwerte aufgeraeumt: Karten haben jetzt Innenabstand (nichts wird mehr am Rand abgeschnitten), Schwellwerte sind in Gruppen sortiert. 2.0.14 - Grosser Engine-Overhaul der Verschattung fuer die beste Balance aus Tageslicht und Waermeschutz bei wenigen Fahrten: direktsonnen-bewusst (ein Fenster wird nur so stark verschattet wie wirklich Sonne darauf steht; Nebenfassaden ohne direkten Sonneneinfall nur mild bis 30 Prozent, bei starker Last bis 70 Prozent, nie voll zu), Dachfenster bleiben an Hitzetagen ganztags zu und oeffnen erst wenn Sonne und PV nachlassen, der 24-Stunden-Plan entspricht jetzt dem echten Verhalten, Bewegungs-Deckel 2-4 Fahrten pro Rollladen und Tag, und die Engine verschattet frueher wenn der Raum waermer laeuft als vorhergesagt. Sanftes Beschatten ist jetzt ein harter Teil-Deckel. 2.0.13 - Neue Mobil-Navigation im Apple-Stil: eine schwebende Liquid-Glass-Leiste unten mit Blur und Transparenz, vier Haupt-Tabs plus ein Mehr-Menue als Sheet (Automatik, Einstellungen, Nachrichten, Hilfe, Darstellung, Updates) samt Basis/Experte-Umschalter. Grosse Touch-Ziele, animierter Aktiv-Indikator, Safe-Area und reduzierte Bewegung beachtet. Aktivierbar unter Darstellung als Mobile Touch-Navigation. 2.0.12 - Vorhersage und Aktionsplanung korrigiert: Rolllaeden blieben faelschlich auf 95 Prozent, obwohl keine Sonne am Fenster lag - jetzt oeffnet die Vorschau fuer Tageslicht, wenn Beschatten dort keinen Kuehl-Nutzen bringt. Der Tagesplan zeigt einen echten, zeitlich gestaffelten 24-Stunden-Fahrplan (wann welcher Rollladen schliesst und wieder oeffnet) statt nur einer Aktion jetzt. Die Rolllaeden-Zeile im Prognoseverlauf reicht ueber den ganzen Planungshorizont statt nach 12 Stunden abzubrechen. Tagesplan-Karte: Innenabstand ergaenzt, Inhalt wird oben links nicht mehr abgeschnitten. 2.0.11 - Tagesplan (24-Stunden-Plan) im Vorhersage-Tab laedt wieder: der Fehler O.find is not a function ist behoben (die Antwort von /api/forecast wird jetzt korrekt als Objekt mit forecasts-Liste gelesen). 2.0.10 - Alle bisher im klassischen Design verbliebenen Seiten (System, Raeume, Quellen, Diagnose, Benachrichtigungen, Bewaesserung-Einstellungen, Nachrichten, Updates, Hilfe, Logs & Debug, Gebaeude-Studio) sind jetzt durchgaengig in der neuen Liquid-Glass-Optik gestaltet: einheitliche Glas-Karten, Akzentfarben, Tabellen, Typografie, Formulare und Buttons - ohne Funktionsverlust. 2.0.9 - Regeln & Grenzwerte samt Simulation/Probelauf sind in der neuen Oberflaeche (v2) jetzt erreichbar und neu gestaltet: eigene lg2-Seite unter /rules mit Profil, allen Schwellwert-Reglern und Automatik-Erweiterungen, Live-Vorschau und echtem Probelauf (faehrt keinen Rollladen). Der Entscheidungsverlauf zeigt jetzt den echten historischen Verlauf (mit Filter und JSON-Export im Experten-Modus) statt nur geplanter Aktionen. 2.0.8 - Vorhersage-Tab-Absturz behoben (l is not a function im Experten-Modus). Sturmschutz jetzt auch in der neuen Oberflaeche (Automatik) per Schalter deaktivierbar; eine haengende Sturm-Haltezeit wird beim Deaktivieren sofort aufgehoben. Manuelles Verstellen eines Rollladens in App/WebApp wird respektiert - die Automatik faehrt nicht mehr kurz danach zurueck (Position wird gehalten) und fragt optional per Telegram (/ja oder /nein), ob wieder geschlossen werden soll. Neuer 24-Stunden-Plan pro Raum im Vorhersage-Tab: erwartete Temperaturkurve plus jede geplante Rollladen-Fahrt mit Ziel und Begruendung; Planungshorizont 12/24/48 h waehlbar. Neues sanftes Beschatten (optional): beschattet erst teilweise (30/50/70 Prozent) und beobachtet, statt bei milder Waerme voll zu schliessen - echte Hitzewelle und Sturm bleiben ausgenommen. 2.0.7 - Sturmschutz laesst sich in den Einstellungen deaktivieren. Neues virtuelles HCU-Geraet Hitzeschutz Automatik (SWITCH) schaltet die Automatik ein/aus (nutzbar in HCU-Automationen und der HmIP-App). Kompass-Rose im Gebaeude-Studio ein/ausblendbar. Neuer Parameter Kuehl-Soll-Temperatur: gibt eine Ziel-Innentemperatur fuer alle Raeume vor. 2.0.6 - Gebaeude-Studio 3D: 3D-Ansicht war gespiegelt (Nord/Sued) - jetzt korrekt wie die 2D-Ansicht. Wandecken (L) werden im 3D-Modell sauber gehrt dargestellt. Fenster, Tueren und Durchgaenge haben jetzt Namen; ein Klick auf ein Fenster im Plan springt direkt zu dessen Einstellungen (Zeile hervorgehoben). Neue Kompass-Rose zeigt und stellt die Gebaeudeausrichtung (Norden) ein. 2.0.5 - Gebaeude-Studio: Stockwerke lassen sich wieder loeschen (Inline-Bestaetigung statt blockiertem System-Dialog). Fenster, Tueren und Durchgaenge werden per zwei Klicks auf der Wand platziert (Ort + Groesse = Distanz), mit Live-Vorschau; an der Oeffnung entsteht eine echte Aussparung in der Wand samt Tuer-/Fenster-Symbol, nichts wird mehr ueberlagert. 2.0.4f2 - Hausuebersicht: die farbige Temperatur-Kante der Raum-Kacheln ist wieder deutlich als Farbband sichtbar und faerbt sich immer nach dem Messwert (gruen unter 24, blau 24-26, rot ueber 26 Grad), sofern eine Messung vorliegt. 2.0.4f1 - Gebaeude-Studio 3D verbessert: Das Dach beschneidet jetzt immer die Raeume (keine durchstossenden Waende mehr). Daecher haben nur noch Schraegflaechen - Giebel, Krueppelwalm-Giebel und Kniestock werden aus der obersten Wand gebildet, die bis zum Dach aufgefuellt wird. Dachueberstand wirkt jetzt in 3D (Standard 1 m, haengt entlang der Neigung herunter, First bleibt auf Wandhoehe). Dachfenster sitzen im Dach (nicht in der Wand) und lassen PV-Aussparungen; PV liegt auf der Dachschraege statt auf dem Deckel. Wand-Bezugskante (Mitte/Aussen/Innen) beim Zeichnen und Snapping auf Wand-Innen-/Aussenkanten; saubere L-Ecken auch am Raum-Schlusspunkt. Raeume und Fenster lassen sich mit der HeatShield-Konfiguration verknuepfen. 2.0.4 - Gebaeude-Studio stark erweitert: Grundriss zeichnen mit Auto-Schluss (Wand/Raum schliesst am Startpunkt), feineres Raster (1-10 cm), starkes Snapping auf vorhandene Ecken; Punkte nachtraeglich verschieben (ziehen) und loeschen (Alt+Klick). Fenster und Tueren mit Hoehe/Breite/Verglasung (1/2/3-fach) und Dachfenster, jetzt auch im 2D-Plan sichtbar. Waende mit Standard-Dicke (Innen/Aussen). Raumliste mit Namen und m2. Keller anlegbar; 2D- und 3D-Ansicht im selben Bereich. Kompaktere Oberflaeche (Projekt in der Kopfzeile, Mehr-Menue, schliessbare Hilfe-Kachel). Hausuebersicht: Kachel-Flaechen faerben nach Raumtemperatur (gruen/blau/rot), Fenster-Symbol in Textfarbe. 2.0.3f2 - Pull-to-Refresh: am Seitenanfang nach unten ziehen laedt die Seite neu (fuer iOS, wo es keine native Geste gibt); Glas-Indikator folgt dem Zug. 2.0.3f1 - Mobile-Feinschliff: Wetter-Chip rechtsbuendig im gestapelten Header, Automatik-Schalter mit gleicher Glas-Transparenz wie der Wetter-Chip, doppelte Scrollbalken behoben (overflow-x clip statt hidden), Bottom-Navigation verteilt sich flexibel und passt vollstaendig. 2.0.3 - Mobile UI ueberarbeitet: neue iPhone-taugliche Bottom-Navigation mit Beschriftung (alle Bereiche erreichbar), Wetter-Chip zeigt den Ort, Automatik-Schalter mit Text auf dem Handy, Titel nicht mehr unter der Notch abgeschnitten. Einstellungs-Kacheln exakt im Liquid-Glass-Look. Symbol-Schatten und Kachel-Rahmen (Staerke und Farbe) konfigurierbar. Layout-Fix: kompakte Icon-Leiste bricht schmale Fenster nicht mehr (keine doppelten Scrollbalken). 2.0.2 - Hausuebersicht neu: Raum-Kacheln im klaren Kachelraster (max. 4x3) mit reichem Klick-Popup samt manueller Steuerung (Auf/50/Zu), ohne 3D-Haus im Hintergrund; der Hero oben fuellt den freien Platz. Popup und Detailansicht jetzt im Liquid-Glass-Design; Chips im Glas-Look passend zu den Raeumen. Darstellung erweitert: konfigurierbare Status-Farbpalette, Theme-Import/-Export und Ueberspeichern eigener Presets. Unterstuetzung fuer HmIP-HDM1 Beschattungsmodule. 2.0.1 - Hausuebersicht: alle Raeume werden jederzeit ohne Scrollen angezeigt. 2.0.0  - Komplett neue Oberflaeche Liquid Glass, jetzt Standard fuer alle Installationen (die klassische 1.20-Oberflaeche bleibt unter Darstellung waehlbar). Frosted-Glass-Design mit linker Seitenleiste; pro Seite eine ruhige Basis- und eine tiefe Experten-Ansicht. Voll konfigurierbare Darstellung (Presets inkl. eigener, Akzentfarbe, Hell-/Dunkel-/Auto-Schema, Hintergrundbild, Glas-Staerke, Symbol-Kacheln) mit High-FPS-Optionen. Neuer gefuehrter Einrichtungs-Assistent (Standort, PV-Anlage inkl. anderer Watt-Geraete, GARDENA, Raeume und Rolllaeden). Neu unterstuetzt werden HmIP-HDM1 Beschattungsmodule (Hunter Douglas / erfal), die automatisch erkannt und wie Rolllaeden angesteuert werden. Zweisprachig DE/EN. Vorheriger oeffentlicher Stand war 1.20.0 (Stockwerk-Beschattung, Hitzetag-Schutz, Alert-Modus mit DWD-Warnstufen, Bewaesserungsplaner).","logsEnabled":true}'

# Dashboard listens on port 8089 by default (see Config.dashboard.port).
EXPOSE 8089

# Health: dashboard returns 200 on `/api/state` once the boot module
# has wired the snapshot dep. Failure flips the container to unhealthy
# without restarting the process. wget is part of busybox in the HMIP
# alpine image.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:8089/api/state || exit 1

# OTA-capable entry: the bootstrap loader (image-only, never OTA-updated) picks
# a verified /data/ota bundle or falls back to the image-baked dist/plugin.
CMD ["node", "dist/bootstrap/loader.js"]
