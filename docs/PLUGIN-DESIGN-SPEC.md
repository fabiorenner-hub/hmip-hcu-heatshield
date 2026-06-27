# HCU-Plugin – Design- & Feature-Spezifikation (Baseline)

Diese Spezifikation ist aus **Heat Shield** abgeleitet und dient als **wiederverwendbare Grundlage für neue Homematic-IP-HCU-Plugins**, damit sie in **Kernfunktionen** und **Optik** konsistent sind. Sie ist normativ formuliert: **MUSS** = verbindlich, **SOLL** = empfohlen, **KANN** = optional.

Ziel: Ein neues Plugin fühlt sich an wie aus derselben Produktfamilie – gleicher Dark-Glass-Look, gleiche Bedienmuster, gleiche technische Leitplanken (lokal, sicher, testbar).

---

## 1. Grundprinzipien (MUSS)

1. **Lokal & privat.** Scope `LOCAL`, kein Cloud-Zwang, keine Telemetrie. Persistenz ausschließlich unter `/data/`. Nichts auf ein konkretes Zuhause hartkodieren – alles über die Konfigseite.
2. **Pure, deterministische Engine.** Fachlogik in reinen Funktionen (gleiche Eingaben → gleiche Ausgaben): kein `fs`, kein Logging, kein Netzwerk, keine Globals. I/O strikt am Rand (Adapter). Dadurch property-/unit-testbar.
3. **Spec-treue Connect-API-Nutzung.** Niemals Feldnamen/Enums raten – gegen die offizielle Spec prüfen. Geräte-Payloads defensiv pro Feld parsen, nie das ganze Geräteobjekt strikt validieren (eQ-3 erweitert Felder laufend).
4. **Transparenz statt Blackbox.** Jede automatische Entscheidung wird im UI begründet (Modus + ausschlaggebender Faktor + Messwert-Chips).
5. **Vorhersagbar & sicher steuern.** Aktorik nur über dokumentierte Befehle; sicherheitskritische Zustände (z. B. Sturm) haben Vorrang; optimistische/erfundene Statusmeldungen vermeiden.
6. **Zweisprachig (DE/EN) zu 100 %.** Keine UI- oder Engine-Zeichenkette darf einsprachig bleiben.
7. **Qualitäts-Gate grün.** `tsc` (beide Configs), `eslint --max-warnings=0`, `vitest`-Suite und ein Image-Build müssen vor jedem Release bestehen.

---

## 2. Technik-Stack (MUSS/SOLL)

| Bereich | Vorgabe |
| --- | --- |
| Sprache | TypeScript **strict**, ESM, `.js`-Importsuffixe, `exactOptionalPropertyTypes: true` |
| Engine | Pure Module, keine Seiteneffekte; Adapter kapseln HCU/HTTP/FS |
| Connect | WebSocket-Client streng nach Spec (Header, Envelope, Enums) |
| Server | **Fastify**; REST unter `/api/*`; SPA-Fallback via `setNotFoundHandler` |
| Frontend | **Preact** + Signals, **ESBuild**-Bundle, **ohne CDN**; Charts: Chart.js/eigene Canvas; Karten: Leaflet |
| Validierung | **Zod**-Schema als Single Source of Truth für die Config |
| Tests | **Vitest** + **fast-check** (Property-Tests für die Engine) |
| Lint/Format | ESLint (`--max-warnings=0`) + Prettier |
| Container | Multi-Stage-Docker, **arm64**, Auslieferung als **`.tar.gz`** |
| Base-Image | `ghcr.io/homematicip/alpine-node-typescript` (Runtime hat kein `npm`) |

---

## 3. Design-System / Optik (MUSS)

Der visuelle Kern ist ein **dunkles, geschichtetes „Dark-Glass"-Theme** mit Amber-Akzent. Neue Plugins **MÜSSEN** dieselben Tokens verwenden. Kopiervorlage für `:root` (verbindliche Werte):

```css
:root {
  /* Flächen – tiefes, geschichtetes Dunkel */
  --color-bg: #05070d;
  --color-bg-elev: #090d16;
  --color-card: #101725;
  --color-card-hover: #16202f;
  --color-card-border: #232c3b;
  --color-card-border-strong: #36404f;
  --color-text: #e8edf6;
  --color-muted: #9aa6b8;
  --color-faint: #6b7686;

  /* Akzent (Amber) + semantische Status */
  --color-accent: #f59e0b;
  --color-accent-strong: #fbbf24;
  --color-accent-contrast: #1a1205;
  --color-info: #3b82f6;
  --color-success: #22c55e;
  --color-warn: #f0b300;
  --color-danger: #ef4444;

  /* Tastatur-Fokus (a11y) */
  --focus-ring: 0 0 0 3px rgba(245, 158, 11, 0.45);

  /* Abstands-Skala (4px-Basis) */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;

  /* Radius + Elevation */
  --radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
  --shadow-1: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-2: 0 4px 12px rgba(0,0,0,0.35);
  --shadow-3: 0 10px 30px rgba(0,0,0,0.45);
}
```

### 3.1 Regeln

- **Nie** rohe Hex-Werte in Komponenten – immer Tokens. Kein Light-on-Dark-Rest (weiße Karten/Buttons mit dunkler Schrift).
- **Karten:** Hintergrund `--color-card`, Rand `--color-card-border`, Radius `--radius-lg`, Schatten `--shadow-2`.
- **Form-Elemente** (input/select/textarea): Radius `--radius-sm`, Padding `--sp-2 --sp-3`, `min-height: 36px`, Hintergrund `--color-bg-elev`.
- **Rechteckige Buttons:** Radius `--radius-sm`, Padding `--sp-2 --sp-4`, `font-weight: 600`. **Pills/Segment-Schalter/runde Icon-Buttons/Toggles** behalten ihre bewusste Form.
- **Chips/Badges:** `--radius-pill`, ~11.5px.
- **Mindest-Schriftgröße 11px** für lesbaren Text (bewusste Mikro-Badges ausgenommen).
- **Fokus:** global `:focus-visible { box-shadow: var(--focus-ring) }`.
- Drittanbieter-Widgets (z. B. Leaflet-Controls) **MÜSSEN** auf das dunkle Theme überschrieben werden (gescoped, ggf. `!important`, da deren CSS später lädt).

### 3.2 Typografie-Skala

- Basis: System-Stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', …`), 14px, `line-height: 1.5`.
- `h1` 1.5rem/700, Karten-Titel (h2/h3 in Karten) ~1.02rem/650, `letter-spacing: -0.01em`.
- Zahlen: `font-variant-numeric: tabular-nums` für Messwerte.

---

## 4. UI-Architektur & Bausteine (MUSS/SOLL)

### 4.1 Shell

- **Header** mit Marke/Logo, **Versions-Badge** (Klick → Updates-Seite; zeigt Punkt bei verfügbarem Update), Nachrichten-Glocke und ggf. einem globalen Schalter.
- **Modul-Navigation** (oben/seitlich): pro Modul Icon + Label. Aktives Modul hervorgehoben (Amber-Verlauf, `--color-accent-contrast`).
- **Einstellungen-Hub:** eine Landing-Page mit Karten-Links zu den Unter-Tabs (Räume/Quellen, Darstellung & Sprache, Benachrichtigungen, Diagnose, Logs & Debug, Updates, Hilfe …).

### 4.2 Panel-/Karten-Muster (verbindlich)

Jeder Tab ist ein `module-panel` mit:
- `module-panel__head` → `h1` + `module-panel__badge` (Kurz-Status rechts),
- optional `module-panel__intro` (1–2 Sätze Erklärung),
- Inhalt in `module-panel__card`-Karten; Kennzahlen als `module-panel__metric`, Hinweise als `module-panel__hint`.

### 4.3 Komponenten-Inventar (SOLL wiederverwenden)

- **KPI-Karte** (Titel + große Kennzahl + Hint).
- **Segment-Schalter** (`.seg`/`.seg__btn`) für 2–3 Optionen (z. B. AUTO/DE/EN).
- **Toggle/Switch** für boolesche Optionen.
- **Reason-Chips** zur Begründung von Entscheidungen.
- **Interaktive Diagramme** (Crosshair + Werte-Tooltip, „expand"-Vollbild, pixelgenaues 1:1-Rendering, keine Verzerrung).
- **Karten** (Leaflet) auf dunklem Base-Layer, Controls dunkel überschrieben.
- **Responsive Tabellen:** auf schmalen Screens `overflow-x:auto` in der Karte statt Seitenüberlauf.
- **Zustände:** jede datengetriebene Ansicht hat klare **Lade-/Leer-/Fehler-Zustände** (kein „leeres Nichts").

### 4.4 Pflicht-Tabs/Funktionen für jedes Plugin

- **Darstellung & Sprache** (AUTO/DE/EN, Ambient-Toggle, Benachrichtigungssprache).
- **Diagnose** (Verbindungsstatus, Logs).
- **Logs & Debug** inkl. Button **„Alle Informationen"** → 360°-Export (alle `/api/*`-Antworten + Browser-/System-Infos) in **einer `.txt`**.
- **Updates** (laufende Version/Build, Changelog, GitHub-Link, Update-Hinweis).
- **Hilfe** (kompakter Funktionsüberblick mit Kurzerklärungen).

### 4.5 Responsive Breakpoints (SOLL)

`max-width: 720px` (Stapeln/Tabellen scrollen), `860px` (2→1 Spalte), `min-width: 1100px` (mehr Spalten). Mobile zuerst testen (390×844), Desktop 1440×900.

---

## 5. Internationalisierung (MUSS)

- **Inline-Paare** statt Katalog: `t('Deutsch', 'English')`, reaktiv über ein `lang`-Signal.
- **Server-/Engine-Strings** über `tServer(germanString)` am Render-Rand übersetzen (exakte Map + parametrische Regex für eingebettete Zahlen).
- **Formatierung:** `fmtNum`/`fmtTime`/`locale()` (DE Komma / EN Punkt). **24h-Zeit und °C bleiben Standard.**
- **Sprachwahl pro Gerät** in localStorage; `AUTO` = Browsersprache mit **Deutsch als Fallback**; `<html lang>` synchron halten.
- **Benachrichtigungssprache** ist eine **installationsweite Config-Option** (Default `de`), serverseitig in die Nachrichten-Erzeugung verdrahtet.

---

## 6. Backend-Architektur & Kontrakte (MUSS)

### 6.1 Boot/Env

- `readEnv()` liest `*_DATA_DIR` (Default `/data`), `*_DASHBOARD_PORT`, `*_NO_CONNECT`, `*_CONNECT_URL`, `*_AUTH_TOKEN`, `*_TOKEN_PATH`.
- **Token-Reihenfolge:** Env-Var → `*_TOKEN_PATH` → `/TOKEN` (vom HCU gemountet).
- Remote-Dev: mit Token + `wss://<hcu>.local:9001`; installiert: `wss://host.containers.internal:9001`.

### 6.2 Connect-API-Kontrakt

- **Handshake-Header:** `authtoken: <raw>` (kein `Bearer`), `plugin-id: <pluginId>` (kebab-case), optional `hmip-system-events: true`.
- **PluginMessage-Envelope:** genau **vier** Felder `id`, `pluginId`, `type`, `body`. Unsolicited → frische UUID; Antworten echoen die Request-`id`.
- **Discovery feature-basiert** klassifizieren (`shutterLevel`, `actualTemperature`, `windowState`, …), nicht über das DeviceType-Enum.
- **Anti-Pattern:** keine erfundenen Enum-Werte; `dataType: ENUM` in Config-Dropdowns meiden (als `STRING` mit dokumentierten Werten umsetzen).

### 6.3 Snapshot + Live

- Engine erzeugt pro Zyklus einen **versionierten Snapshot** (Status, Modus-Info, Geräte/Räume, geplante Aktionen, Empfehlungen).
- Dashboard liest `/api/state` periodisch **und** abonniert **SSE** (`/api/stream`) für Live-Updates ohne Reload.

### 6.4 REST-Oberfläche (SOLL, einheitliche Namen)

`/api/state`, `/api/config` (Secrets maskiert), `/api/diagnostics`, `/api/metrics`, `/api/decisions`, `/api/trends`, `/api/connect/log`, `/api/messages`, `/api/notifications`, `/api/sources/discover`, plus plugin-spezifische Aktionen. Fehler einheitlich als `{ error: { code, message } }`.

### 6.5 Persistenz

- Nur unter `/data/`; **atomare** Schreibvorgänge (temp + rename); defensives Lesen mit Schema-Fallback. Kein Secret ins Log.

### 6.6 Benachrichtigungen (KANN, aber Muster vorgeben)

- Service kapselt Store + optionalen Telegram-Versand; Per-Event-Toggles; **Sprach-Option**; Dedup gegen Spam; nur **eigene** Geräte dürfen unsolicited STATUS_EVENTs erhalten.

---

## 7. Verpackung & Metadaten (MUSS)

- **Image:** `arm64`, Multi-Stage (Build-Stage kompiliert + `npm prune --omit=dev`, Runtime kopiert `node_modules`/`dist`/`public`). Export als `.tar.gz` (`docker save | gzip`).
- **Versionierung:** Single Source of Truth in `package.json`. **Jeder Build = neue Versionsnummer.** Synchron halten: `package.json`, `Dockerfile` (ARG **und** LABEL `version` **und** changelog), `CHANGELOG.md`, SPA-`version.ts` (`APP_VERSION`), Changelog-Array im Updates-Tab.
- **Eindeutiger `BUILD_ID`** (`<version>+<utc-stamp>[.<git-sha>]`) in Runtime-Env + Discovery-Banner, damit der Live-Build identifizierbar ist.
- **Plugin-Metadaten-LABEL** `de.eq3.hmip.plugin.metadata` (einzeilig, JSON, vom HCU-Validator strikt geprüft):
  - `pluginId`, `issuer`, `version`, `hcuMinVersion`, `scope` → **String** (Pflicht).
  - `friendlyName`, `description` → `Map<String,String>` mit ISO-639-1-Keys (`de` Pflicht).
  - **`changelog` → String** (NICHT als Map; sonst „Plugin nicht valide"). Keine `%`, keine einfachen Anführungszeichen im LABEL-Wert.
  - `logsEnabled` → boolean (optional, aktiviert das HCUweb-Log-Panel).

Beispiel-Skelett:

```dockerfile
ARG <PLUGIN>_VERSION=1.0.0
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"de.<issuer>.plugin.<name>","version":"1.0.0","issuer":"<Name>","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"…","en":"…"},"description":{"de":"…","en":"…"},"changelog":"1.0.0 — …","logsEnabled":true}'
EXPOSE 8089
HEALTHCHECK CMD wget --quiet --spider http://localhost:8089/api/state || exit 1
```

---

## 8. Release-Checkliste (MUSS, vor jedem Release)

1. Versionsnummer überall synchron erhöht (siehe §7).
2. `tsc -p tsconfig.json` **und** `tsc -p tsconfig.spa.json` grün.
3. `eslint . --max-warnings=0` grün.
4. `vitest run` grün (bekannte, isoliert grüne Flakes dokumentieren).
5. LABEL-JSON parst sauber; `feature.type`/Enum-Werte gegen Spec geprüft; `deviceId` konsistent über DISCOVER/STATUS/CONTROL.
6. `npm run build` + `npm run build:image` → Artefakt `<name>-<version>-arm64.tar.gz` existiert.
7. **Datenschutz-Gate (öffentliches Repo):** `git grep --cached` zeigt **null** private Tokens/Hosts/Orte; `.tmp-assets/`, `.kiro/` u. ä. sind ge-`.gitignore`-t.
8. **Kein Publish** (Push auf `main`/GitHub-Release) ohne ausdrückliche Freigabe bzw. HCU-Verifizierung.

---

## 9. Verzeichnis-/Modul-Konvention (SOLL)

```
src/
  plugin/
    index.ts            # Boot, Orchestrator, Env, Notifications-Wiring
    connect/            # Connect-API-Client, Envelope, Discovery, System-State
    engine/             # PURE Fachlogik (keine I/O) + Submodule
    dashboard/
      server.ts         # Fastify + /api/* + SPA-Fallback
      public/           # index.html, styles.css (Tokens!), Icons, sw.js
      spa/              # Preact-App
        i18n.ts         # t / tServer / fmtNum / fmtTime / langPref
        app.tsx         # Shell, Modul-Nav, Router
        tabs/ components/
    notifications/      # Store + Telegram + Sprach-Option
    persistence/        # atomare /data-Reads/Writes
  shared/               # Zod-Schema + Typen
tests/                  # unit / property / integration
```

---

## 10. Kurz-Checkliste „fühlt sich an wie die Familie?"

- [ ] Dark-Glass-Theme aus den `:root`-Tokens, Amber-Akzent, Fokus-Ring.
- [ ] `module-panel` + Karten + Badge + Intro-Muster.
- [ ] 100 % DE/EN inkl. Engine-Strings; Sprachwahl pro Gerät (AUTO/DE/EN).
- [ ] Transparente Entscheidungen (Modus + Faktor + Chips).
- [ ] Pflicht-Tabs: Darstellung & Sprache, Diagnose, Logs & Debug (+360°-Export), Updates, Hilfe.
- [ ] Live via SSE; Lade-/Leer-/Fehler-Zustände überall.
- [ ] Responsive (Mobile zuerst), Tabellen scrollen statt überlaufen, Mindestschrift 11px.
- [ ] Lokal/`/data`, kein Cloud-Zwang; Connect-API spec-treu; arm64-`.tar.gz` + striktes Metadaten-LABEL.
- [ ] Qualitäts-Gate grün; jede Build-Nummer neu; Datenschutz-Gate vor Push.

---

*Abgeleitet aus dem Heat-Shield-Plugin (`de.fr.renner.plugin.heatshield`). Diese Datei ist als Vorlage gedacht – Tokens und Muster 1:1 übernehmen, fachliche Engine ersetzen.*
