# Build the OTA release asset set from the compiled dist/ output.
# Run AFTER "npm run build". Produces, under .tmp-assets/ota/:
#   heatshield-ota-<v>.json         bundle (format/version/files{path:base64})
#   heatshield-ota-<v>.json.sha256  sha256 of the bundle file
#   ota-manifest-<v>.json           version/minCoreVersion/sha256/assetUrl/bundleName
# The bundle carries dist/ota/main.js + dist/plugin/dashboard/public/*.
# minCoreVersion defaults to the current package version. Does NOT publish.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$pkg = Get-Content -Raw -Path (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$pkgVersion = [string]$pkg.version
$version = 'v' + $pkgVersion
# Minimum core version this OTA payload needs. Keep this at the LAST core
# version that changed something outside the payload (loader/native deps/port).
# The OTA loader + core shipped in v2.0.22, so payloads flow to every
# OTA-capable install by default. RAISE this only when a payload genuinely
# needs a newer image (then those installs get the Regular-Update banner).
$minCore = if ($env:OTA_MIN_CORE) { $env:OTA_MIN_CORE } else { 'v2.0.22' }
$repo = 'fabiorenner-hub/hmip-hcu-heatshield'

$distMain = Join-Path $repoRoot 'dist/ota/main.js'
$publicDir = Join-Path $repoRoot 'dist/plugin/dashboard/public'
if (-not (Test-Path $distMain)) { throw 'missing dist/ota/main.js - run npm run build first' }

$files = [ordered]@{}
$files['main.js'] = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($distMain))

if (Test-Path $publicDir) {
    $base = (Resolve-Path $publicDir).Path
    foreach ($f in (Get-ChildItem -Path $publicDir -Recurse -File)) {
        $rel = 'public/' + ($f.FullName.Substring($base.Length + 1) -replace '\\', '/')
        $files[$rel] = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($f.FullName))
    }
}

$bundle = [ordered]@{ format = 'heatshield-ota-1'; version = $version; files = $files }
$bundleJson = ($bundle | ConvertTo-Json -Depth 5 -Compress)

$outDir = Join-Path $repoRoot '.tmp-assets/ota'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$bundleName = 'heatshield-ota-' + $pkgVersion + '.json'
$bundlePath = Join-Path $outDir $bundleName
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($bundlePath, $bundleJson, $utf8)

$sha = (Get-FileHash -Algorithm SHA256 -Path $bundlePath).Hash.ToLower()
[System.IO.File]::WriteAllText(($bundlePath + '.sha256'), ($sha + '  ' + $bundleName + "`n"), $utf8)

$assetUrl = 'https://github.com/' + $repo + '/releases/download/' + $version + '/' + $bundleName
$manifest = [ordered]@{
    version        = $version
    minCoreVersion = $minCore
    sha256         = $sha
    assetUrl       = $assetUrl
    bundleName     = $bundleName
}
$manifestName = 'ota-manifest-' + $pkgVersion + '.json'
$manifestPath = Join-Path $outDir $manifestName
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 3), $utf8)

$sizeMb = [math]::Round((Get-Item $bundlePath).Length / 1MB, 2)
$fileCount = $files.Count
Write-Host '==> OTA assets written to .tmp-assets/ota' -ForegroundColor Green
Write-Host ('    bundle   : ' + $bundleName + ' - ' + $sizeMb + ' MB - ' + $fileCount + ' files')
Write-Host ('    sha256   : ' + $sha)
Write-Host ('    manifest : ' + $manifestName + ' - minCore ' + $minCore)
