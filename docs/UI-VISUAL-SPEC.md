# HCU-Plugin – Visuelle & Effekt-Spezifikation („so sieht es aus")

Ergänzung zu `PLUGIN-DESIGN-SPEC.md` (§3). Hier stehen die **exakten** Werte für Optik und Effekte – aus dem Heat-Shield-CSS übernommen, 1:1 kopierbar. Ziel: ein „Dark-Glass"-Look mit Amber-Akzent, weicher Tiefe, dezenten Glows und ruhigen, premium-haften Bewegungen.

---

## 1. Gesamteindruck

Tiefes, fast schwarzes Blau als Grund, darauf **frostige Glas-Karten** (halbtransparent, `backdrop-filter`-Blur + leichte Sättigung), oben ein heller Sheen-Verlauf (Licht von oben links), unten satte Kontaktschatten für echte Elevation. Akzent ist **Amber** (`#f59e0b`/`#fbbf24`) mit weichem Glow. Bewegungen sind kurz und gedämpft; ein optionaler **dynamischer Ambient-Hintergrund** „atmet" mit Tageszeit und Wetter.

---

## 2. Glass-Tokens (exakt, verbindlich)

```css
:root {
  --glass-bg: rgba(10, 15, 26, 0.5);
  --glass-bg-strong: rgba(10, 15, 26, 0.66);
  --glass-border: rgba(255, 255, 255, 0.09);
  --glass-highlight: rgba(255, 255, 255, 0.06);
  --glass-edge: rgba(255, 255, 255, 0.16);
  --glass-blur: 22px;

  --glow-accent: 0 0 14px rgba(245, 158, 11, 0.32);

  /* Lichtkante oben-links → Glas-Anmutung */
  --glass-sheen: linear-gradient(
    157deg,
    rgba(255, 255, 255, 0.11) 0%,
    rgba(255, 255, 255, 0) 64%
  );

  /* Schatten-Stack: Innenkante (Highlight) + 1px Innenlinie + Kontaktschatten + weicher Ambient-Drop */
  --glass-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 0 0 1px rgba(255, 255, 255, 0.025),
    0 1px 2px rgba(0, 0, 0, 0.3),
    0 14px 38px rgba(0, 0, 0, 0.44);
  --glass-shadow-hover:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04),
    0 18px 48px rgba(0, 0, 0, 0.5);
}
```

---

## 3. Oberflächen-Rezept (Glas-Karte)

Jede „echte" Karte (Dashboard-Kacheln, Twin-Karten, Forecast-Cards, Nachrichten):

```css
.glass-surface {
  background: var(--glass-sheen), var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);                /* 14px */
  backdrop-filter: blur(var(--glass-blur)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.4);
  box-shadow: var(--glass-shadow);
  transition:
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}
/* Hover-Lift nur auf Zeigegeräten (kein „Springen" auf Touch) */
@media (hover: hover) {
  .glass-surface:hover {
    transform: translateY(-3px);
    box-shadow: var(--glass-shadow-hover);
    border-color: var(--glass-edge);
  }
}
```

Regeln:
- **Saturate** an den Blur koppeln (1.1–1.4), damit Farben hinter dem Glas leben.
- Die `--glass-sheen`-Lage **immer zuerst** im `background` (liegt optisch oben), dann die Glas-Grundfarbe.
- Schlichte Inhalts-Karten (`module-panel__card`) nutzen die einfachere Variante (`--color-card` + `--shadow-2`, Radius `--radius-lg`); die Glas-Variante ist für „Hero"-Flächen (Twin, KPIs, Header).

---

## 4. Hintergrund

### 4.1 Statischer Grund (immer)

```css
body {
  background:
    radial-gradient(1100px 540px at 82% -12%, rgba(245, 158, 11, 0.07), transparent 60%),
    radial-gradient(900px 500px at 12% 8%, rgba(59, 130, 246, 0.06), transparent 62%),
    linear-gradient(180deg, #070a12 0%, #04060c 100%),
    var(--color-bg);
}
```

Zwei sehr dezente Farbglühen (Amber oben rechts, Blau oben links) über einem fast schwarzen Vertikalverlauf.

### 4.2 Dynamischer Ambient-Hintergrund (optional, pro Gerät schaltbar)

Wenn aktiv, ersetzt eine aus **Sonnenhöhe + Bewölkung + Sturm** berechnete Fläche den Body-Hintergrund; die Glas-Karten lassen ihn durchscheinen. Phasen und exakte Werte:

```text
storm        radial(120% 80% at 50% -10%, rgba(90,110,140,.16), transparent 60%)
             + linear(180deg, #0e141d, #080c12 55%, #04060a)
night (<-6°) radial(90% 60% at 70% -10%, rgba(60,85,150,.16), transparent 55%)
             + linear(180deg, #04060f, #060a18 60%, #080c1f)
dawn (<8°)   klar:   radial(rgba(255,170,100,.22)) + linear(#0a1424,#221f3c 50%,#6e3f2c)
             wolkig: radial(rgba(120,120,140,.16)) + linear(#0c1322,#23263a 55%,#3c2e36)
day  (≥8°)   klar:   radial(rgba(255,205,120,.20)) + linear(#07203f,#173a5e 55%,#336184)
             wolkig: radial(rgba(150,165,185,.16)) + linear(#141d2b,#29384b 55%,#3f5468)
```

`cloudy = cloud01 > 0.6`. Default: **aus** (das ruhigere Standard-Theme ist Default).

---

## 5. Header & Navigation

```css
.app__header {
  background: rgba(11, 15, 23, 0.72);
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
  border-bottom: 1px solid var(--glass-border);
  /* sticky, schwebt über dem scrollenden Inhalt */
}

/* Aktiver Tab/Modul: Amber-Verlauf + Glow + Innen-Highlight */
.app__tab--active,
.app__module--active {
  background: linear-gradient(180deg, var(--color-accent-strong) 0%, var(--color-accent) 100%);
  color: var(--color-accent-contrast);
  box-shadow:
    0 4px 12px rgba(245, 158, 11, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
```

Icon-Buttons (rund, Glas):

```css
.icon-btn {
  background: var(--glass-sheen), var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight), 0 2px 5px rgba(0, 0, 0, 0.32);
  transition:
    border-color 0.14s ease, box-shadow 0.14s ease,
    background 0.14s ease, transform 0.14s cubic-bezier(0.22, 1, 0.36, 1);
}
.icon-btn:hover {
  border-color: var(--color-accent);
  transform: translateY(-1px);
  box-shadow: inset 0 1px 0 var(--glass-highlight), 0 7px 18px rgba(0, 0, 0, 0.42), var(--glow-accent);
}
```

---

## 6. Bewegungs- & Easing-System (verbindlich)

| Zweck | Dauer | Easing |
| --- | --- | --- |
| Micro (Farbe/Border/Hintergrund) | `0.12–0.15s` | `ease` |
| Button-Press (`transform`) | `0.05s` | `ease` |
| Premium-Lift (Karten/Icon-Hover) | `0.2s` (Karte) / `0.14s` (Icon) | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Badge-Positionsfahrt | `0.35s` | `cubic-bezier(0.22, 0.61, 0.36, 1)` |
| Popover-Einblendung | `0.14s` | `ease-out` |

Hover-Lift: `translateY(-1px)` (kleine Elemente) bis `-3px` (Karten). **Niemals** lange/auffällige Animationen.

**Pflicht:** `prefers-reduced-motion` respektieren:

```css
@media (prefers-reduced-motion: reduce) {
  *, .skeleton, .twin-sun-rays { animation: none !important; transition: none !important; }
}
```

---

## 7. Keyframes (exakt)

```css
/* Sturm-Indikator: pulsierender roter Glow */
@keyframes storm-blink {
  from { box-shadow: 0 0 0 rgba(255, 0, 0, 0); }
  to   { box-shadow: 0 0 12px rgba(255, 30, 30, 0.7); }
}
/* .mode-header--storm { animation: storm-blink 1.2s infinite alternate; } */

/* „läuft gerade"-Puls (z. B. fahrender Rollladen) */
@keyframes twin-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }              /* dezenter Opacity-Puls, 1.4s ease-in-out infinite */
}

/* Popover sanft öffnen */
@keyframes twin-popover-in {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to   { opacity: 1; transform: none; }     /* 0.14s ease-out */
}

/* laufendes Glyph (z. B. Bewegungssymbol) */
@keyframes glyph-run { 0%,100% { } 50% { } } /* 1.2s ease-in-out infinite, leichte Verschiebung */

/* Ladeskelett: Schimmer */
@keyframes skeleton-shimmer {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }     /* background-size: 400% 100%, 1.4s ease infinite */
}
```

Skeleton-Fläche: linearer Verlauf über `background-size: 400% 100%` + obige Animation = wandernder Glanz.

---

## 8. Spezial-Effekte (Detail-Glanz)

- **Akzent-Glow** `--glow-accent` für „aktiv/fokussiert/wichtig". Zeiger der Windrose: `filter: drop-shadow(0 0 4px var(--color-accent))`.
- **Icon-Tiefe:** KPI-Icons `filter: drop-shadow(0 1px 3px rgba(0,0,0,0.45))`.
- **Hover-Helligkeit** bei farbigen Segmenten: `filter: brightness(1.2)` (z. B. Risk-Bar-Segmente).
- **Kontaktschatten unter Marker:** separater Layer, `radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.85), transparent 76%)` + `filter: blur(4px)` (weicher „Boden"-Schatten).
- **Live-Metrik-Chips:** `backdrop-filter: blur(6px)`, `box-shadow: 0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)`, linker Statusbalken `border-left: 3px solid <statusfarbe>`.
- **Fokus (a11y):** `:focus-visible { box-shadow: var(--focus-ring); }` (`0 0 0 3px rgba(245,158,11,0.45)`).
- **Eigene Scrollbars** (Timelines): Thumb `linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))`, Track `rgba(255,255,255,0.05)`, beide `border-radius: 999px`.

---

## 9. Modus-Farbpalette (Mode-Header / Statusakzente)

```css
:root {
  --mode-normal: #4a5568;
  --mode-summer-watch: #ffb366;
  --mode-active-heat-protection: #ff8c42;
  --mode-heatwave: #e63946;
  --mode-night-cooling: #4361ee;
  --mode-storm: #7a0c0c;       /* zusätzlich storm-blink-Animation */
  --mode-vacation: #8e44ad;
  --mode-maintenance: #6c757d;
}
```

Der Mode-Header trägt die jeweilige Modusfarbe als Hintergrund; nur **STORM** pulsiert (Sicherheitssignal).

---

## 10. Light-Mode (automatisch via `prefers-color-scheme: light`)

Das Glas-System hat eine helle Spiegelung – dieselben Variablen, andere Werte:

```css
@media (prefers-color-scheme: light) {
  :root {
    --glass-bg: rgba(255, 255, 255, 0.5);
    --glass-bg-strong: rgba(255, 255, 255, 0.68);
    --glass-border: rgba(20, 30, 50, 0.12);
    --glass-highlight: rgba(255, 255, 255, 0.55);
    --glass-edge: rgba(20, 30, 50, 0.2);
    --glass-sheen: linear-gradient(157deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 64%);
    --glass-shadow:
      inset 0 1px 0 rgba(255,255,255,0.7),
      inset 0 0 0 1px rgba(255,255,255,0.3),
      0 1px 2px rgba(20,30,50,0.1),
      0 14px 34px rgba(20,30,50,0.16);
    /* Flächen-Tokens (--color-bg/-card/...) ebenfalls auf helle Werte spiegeln */
  }
}
```

Wichtig: Komponenten **immer** über die Tokens stylen, dann funktioniert Hell/Dunkel automatisch.

---

## 11. Do / Don't

**Do**
- Glas nur dort, wo Tiefe gewünscht ist; Inhalt bleibt gut lesbar (Text `--color-text`, nie auf hellem Glas dunkel/auf dunklem Glas dunkel).
- Effekte **dezent**: ein Glow, ein Lift, ein kurzer Übergang – nicht stapeln.
- `saturate` + `blur` zusammen; Sheen-Lage oben.

**Don't**
- Keine harten reinweißen Flächen/Borders im Dark-Mode (kein Light-on-Dark-Rest).
- Keine langen/springenden Animationen; Hover-Effekte nicht auf Touch erzwingen (`@media (hover: hover)`).
- Keine rohen Schatten/Radii – immer `--shadow-*` / `--radius-*` bzw. die Glas-Stacks.
- `prefers-reduced-motion` nie ignorieren.

---

*Werte verifiziert aus `src/plugin/dashboard/public/styles.css` und `spa/ambient.ts` (Heat Shield). 1:1 übernehmen; nur fachliche Inhalte ersetzen.*
