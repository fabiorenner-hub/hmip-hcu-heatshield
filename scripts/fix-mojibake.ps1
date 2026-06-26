# Repairs single-round UTF-8->CP1252 mojibake by replacing the corrupted
# multi-codepoint sequences with the correct character. Safe on mixed-encoding
# files: a correctly-encoded character is a single codepoint and never matches
# the multi-codepoint mojibake sequence. All literals are built from code
# points so the shell transport cannot re-corrupt the script.

param([Parameter(Mandatory = $true)][string]$Path)

$c3 = [char]0xC3
$c2 = [char]0xC2
$e2 = [char]0xE2
$euro = [char]0x20AC   # CP1252 0x80
$dq2 = [char]0x201C    # CP1252 0x93
$dq3 = [char]0x201D    # CP1252 0x94
$lowq = [char]0x201E   # CP1252 0x84
$endash = [char]0x2013 # CP1252 0x96
$oe = [char]0x0153     # CP1252 0x9C
$Ydia = [char]0x0178   # CP1252 0x9F
$bull = [char]0xA6     # 0xA6
$cent = [char]0xA2     # 0xA2
$tm = [char]0x2122     # CP1252 0x99
$perm = [char]0x2030   # CP1252 0x89
$circ = [char]0x02C6   # CP1252 0x88
$dagger = [char]0x2020 # CP1252 0x86
$lsq = [char]0x2018    # CP1252 0x91
$rsq = [char]0x2019    # CP1252 0x92

$from = @(
  ($c3 + [char]0xA4),            # ä
  ($c3 + [char]0xB6),            # ö
  ($c3 + [char]0xBC),            # ü
  ($c3 + $lowq),                 # Ä  (C3 84)
  ($c3 + $endash),               # Ö  (C3 96)
  ($c3 + $oe),                   # Ü  (C3 9C)
  ($c3 + $Ydia),                 # ß  (C3 9F)
  ($c2 + [char]0xB0),            # °
  ($e2 + $euro + $dq2),          # – en dash (E2 80 93)
  ($e2 + $euro + $dq3),          # — em dash (E2 80 94)
  ($e2 + $euro + $bull),         # … ellipsis (E2 80 A6)
  ($e2 + $euro + $cent),         # • bullet (E2 80 A2)
  ($e2 + $euro + $tm),           # ’ rsquo (E2 80 99)
  ($e2 + $perm + $circ),         # ≈ (E2 89 88)
  ($e2 + $dagger + $rsq),        # → (E2 86 92)
  ($e2 + $dagger + $lsq),        # ↑ (E2 86 91)
  ($e2 + $dagger + $dq2),        # ↓ (E2 86 93)
  ($e2 + $perm + [char]0xA5),    # ≥ (E2 89 A5)
  ($e2 + $euro + [char]0x017E)   # „ low double quote (E2 80 9E)
)
$to = @(
  [char]0xE4, [char]0xF6, [char]0xFC, [char]0xC4, [char]0xD6, [char]0xDC,
  [char]0xDF, [char]0xB0, [char]0x2013, [char]0x2014, [char]0x2026,
  [char]0x2022, [char]0x2019, [char]0x2248, [char]0x2192, [char]0x2191,
  [char]0x2193, [char]0x2265, [char]0x201E
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
$before = $text
for ($i = 0; $i -lt $from.Count; $i++) {
  $text = $text.Replace([string]$from[$i], [string]$to[$i])
}

# Emoji (4-byte) mojibake sequences -> correct emoji.
$o = [char]0x0178; $a4 = [char]0xA4; $a1 = [char]0xA1
$efrom = @(
  ([char]0xF0 + $o + [char]0x201C + [char]0x0160), # 📊 1F4CA
  ([char]0xF0 + $o + [char]0x0152 + $a4),          # 🌤 1F324
  ([char]0xF0 + $o + [char]0x0152 + $a1),          # 🌡 1F321
  ([char]0xF0 + $o + [char]0x203A + $a1),          # 🛡 1F6E1
  ([char]0xE2 + [char]0x008F + [char]0xB8),        # ⏸ 23F8
  ([char]0xE2 + [char]0x2013 + [char]0xB6),        # ▶ 25B6
  ([char]0xE2 + [char]0x0153 + [char]0x2026),      # ✅ 2705 (check before ✈)
  ([char]0xE2 + [char]0x0153 + [char]0x02C6),      # ✈ 2708
  ([char]0x00EF + [char]0xB8 + [char]0x008F)       # ️ FE0F variation selector -> remove
)
$eto = @(
  [System.Char]::ConvertFromUtf32(0x1F4CA),
  [System.Char]::ConvertFromUtf32(0x1F324),
  [System.Char]::ConvertFromUtf32(0x1F321),
  [System.Char]::ConvertFromUtf32(0x1F6E1),
  [System.Char]::ConvertFromUtf32(0x23F8),
  [System.Char]::ConvertFromUtf32(0x25B6),
  [System.Char]::ConvertFromUtf32(0x2705),
  [System.Char]::ConvertFromUtf32(0x2708),
  ''
)
for ($i = 0; $i -lt $efrom.Count; $i++) {
  $text = $text.Replace([string]$efrom[$i], [string]$eto[$i])
}

if ($text -ne $before) {
  [System.IO.File]::WriteAllText($Path, $text, $utf8)
  "fixed: $Path"
} else {
  "no change: $Path"
}
