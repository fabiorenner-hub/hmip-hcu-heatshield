# Publish a ROLLING experimental OTA prerelease (B5).
#
# Builds the plugin + the experimental OTA asset set, then ensures a single
# GitHub prerelease with the fixed tag `experimental` exists and (re)uploads the
# two OTA assets to it (--clobber). Because it is a PRERELEASE, GitHub excludes
# it from `releases/latest`, so stable-channel HCUs never receive it; only an
# HCU switched to the "Experimental" channel picks it up.
#
# Requires: gh CLI authenticated (repo + workflow scope). Does NOT bump the
# version, touch main, or create a normal release. Safe to run repeatedly — it
# just replaces the rolling prerelease's assets with a fresh build stamp.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$repo = 'fabiorenner-hub/hmip-hcu-heatshield'
$tag = 'experimental'

Write-Host '==> Building plugin + experimental OTA assets' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
# Mirror the freshly built public assets (app.js/css/sw.js) into dist so the
# OTA bundle carries the latest SPA. robocopy rc < 8 = success.
robocopy 'src/plugin/dashboard/public' 'dist/plugin/dashboard/public' /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (rc=$LASTEXITCODE)" }
$global:LASTEXITCODE = 0 # robocopy uses rc 1-7 for success; reset so it is not misread below
# build-ota.ps1 sets $ErrorActionPreference='Stop', so a real failure throws.
& (Join-Path $PSScriptRoot 'build-ota.ps1') -Experimental

$outDir = Join-Path $repoRoot '.tmp-assets/ota'
$bundle = Join-Path $outDir 'heatshield-ota-exp.json'
$bundleSha = $bundle + '.sha256'
$manifest = Join-Path $outDir 'ota-manifest-exp.json'
foreach ($f in @($bundle, $bundleSha, $manifest)) {
    if (-not (Test-Path $f)) { throw "missing experimental asset: $f" }
}

# Ensure the rolling prerelease exists (create once, marked --prerelease).
$exists = $true
try { gh release view $tag -R $repo 1>$null 2>$null; if ($LASTEXITCODE -ne 0) { $exists = $false } }
catch { $exists = $false }

if (-not $exists) {
    Write-Host "==> Creating rolling prerelease '$tag'" -ForegroundColor Cyan
    gh release create $tag -R $repo --prerelease --title 'Experimental (rolling test build)' `
        --notes 'Rolling experimental test build. Same version as stable + a build stamp; no changelog. Only HCUs on the Experimental update channel receive this.'
    if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }
}

Write-Host '==> Uploading experimental OTA assets (clobber)' -ForegroundColor Cyan
gh release upload $tag $bundle $bundleSha $manifest -R $repo --clobber
if ($LASTEXITCODE -ne 0) { throw 'gh release upload failed' }

Write-Host '==> Experimental OTA published.' -ForegroundColor Green
Write-Host '    On the HCU: Updates tab -> Channel: Experimental -> Check now / auto.'
