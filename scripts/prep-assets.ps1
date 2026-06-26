# Optimize the user-provided renders/icons into the dashboard public assets.
# House renders -> JPG (opaque, ~720px). Icons -> PNG (transparency, ~96px).
Add-Type -AssemblyName System.Drawing

$src = ".tmp-assets/images"
$houseDir = "src/plugin/dashboard/public/assets/house"
$iconDir = "src/plugin/dashboard/public/assets/icons"
New-Item -ItemType Directory -Force -Path $houseDir | Out-Null
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$jpgEnc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$qp = New-Object System.Drawing.Imaging.EncoderParameters(1)
$qp.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]84)

function Resize([string]$inFile, [string]$outFile, [int]$size, [bool]$jpg) {
  $img = [System.Drawing.Image]::FromFile((Resolve-Path $inFile))
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  if (-not $jpg) { $g.Clear([System.Drawing.Color]::Transparent) }
  $g.DrawImage($img, 0, 0, $size, $size)
  if ($jpg) { $bmp.Save((Join-Path (Get-Location) $outFile), $jpgEnc, $qp) }
  else { $bmp.Save((Join-Path (Get-Location) $outFile), [System.Drawing.Imaging.ImageFormat]::Png) }
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}

# House renders -> day/night x open/half/closed. Kept as transparent PNG
# (the renders are RGBA cutouts; JPG would bake a black box behind them).
$house = @{
  "haus_tag_rollo_offen.png"          = "day-open.png"
  "haus_tag_rollo_50.png"             = "day-half.png"
  "haus_tag_rollo_geschlossen.png"    = "day-closed.png"
  "haus_nacht_rollo_offen.png"        = "night-open.png"
  "haus_nacht_rollo_50.png"           = "night-half.png"
  "haus_nacht_rollo_geschlossen.png"  = "night-closed.png"
}
foreach ($k in $house.Keys) { if (Test-Path "$src/$k") { Resize "$src/$k" "$houseDir/$($house[$k])" 680 $false } }

# Icons -> 96px PNG (transparency)
$icons = @{
  "icon-logo.png"          = "logo.png"
  "icon-beschattung.png"   = "beschattung.png"
  "icon-belüftung.png"     = "lueftung.png"
  "icon-kühlung.png"       = "klima.png"
  "icon-wetter.png"        = "forecast.png"
  "icon-einstellungen.png" = "einstellungen.png"
  "icon-sonne.png"         = "sonne.png"
  "icon-sonne2.png"        = "sonne2.png"
  "icon-feuchtigkeit.png"  = "feuchte.png"
}
foreach ($k in $icons.Keys) { if (Test-Path "$src/$k") { Resize "$src/$k" "$iconDir/$($icons[$k])" 96 $false } }

"house:"; Get-ChildItem $houseDir | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB)}}
"icons:"; Get-ChildItem $iconDir | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB)}}
