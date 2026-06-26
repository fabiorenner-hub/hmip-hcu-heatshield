<#
.SYNOPSIS
  Versioned, reproducible build of the Heat Shield HMIP plugin image.

.DESCRIPTION
  Single source of truth for the version is package.json. This script:
    1. Reads "version" from package.json.
    2. Computes a unique BUILD_ID stamp: <version>+<UTC timestamp>[.<git short sha>].
    3. Builds the arm64 image via buildx, baking HEATSHIELD_VERSION and
       BUILD_ID into the runtime env + the metadata LABEL.
    4. Tags the image:  heatshield:<version>, heatshield:latest,
       de/fr/renner/plugin/heatshield:<version>
    5. Exports a gzip artefact: .tmp-assets/heatshield-<version>-arm64.tar.gz

  The running plugin reports HEATSHIELD_BUILD in the dashboard discovery
  banner, and HCUweb shows the LABEL version on the plugin card — so the
  live build is always identifiable.

.NOTES
  Run from the repo root:  npm run build:image
  Requires: Docker Desktop with buildx, the arm64 builder available.
#>

$ErrorActionPreference = 'Stop'

# Resolve repo root = parent of this script's folder.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# --- 1. Version from package.json ----------------------------------------
$pkg = Get-Content -Raw -Path (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$version = $pkg.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'Could not read version from package.json'
}

# --- 2. Build stamp ------------------------------------------------------
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$gitSha = ''
try {
    $gitSha = (git rev-parse --short HEAD 2>$null).Trim()
} catch {
    $gitSha = ''
}
$buildId = if ($gitSha) { "$version+$stamp.$gitSha" } else { "$version+$stamp" }

Write-Host "==> Building Heat Shield $version" -ForegroundColor Cyan
Write-Host "    BUILD_ID = $buildId" -ForegroundColor DarkCyan

# --- 3. Tags + paths -----------------------------------------------------
$tags = @(
    "heatshield:$version",
    'heatshield:latest',
    "de/fr/renner/plugin/heatshield:$version"
)
$tagArgs = @()
foreach ($t in $tags) { $tagArgs += @('-t', $t) }

$assetsDir = Join-Path $repoRoot '.tmp-assets'
if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir | Out-Null }
$tarPath = Join-Path $assetsDir "heatshield-$version-arm64.tar"
$gzPath = Join-Path $assetsDir "heatshield-$version-arm64.tar.gz"
$logPath = Join-Path $assetsDir 'docker-build.log'

# --- 4. Build ------------------------------------------------------------
$buildArgs = @(
    'buildx', 'build',
    '--platform=linux/arm64',
    '--load',
    '--progress=plain',
    '--build-arg', "HEATSHIELD_VERSION=$version",
    '--build-arg', "BUILD_ID=$buildId"
) + $tagArgs + @('.')

Write-Host "==> docker $($buildArgs -join ' ')" -ForegroundColor DarkGray
# Native commands write progress to stderr; under EAP=Stop that would
# throw on the first stderr line. Drop to Continue and gate on the
# real exit code instead.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& docker @buildArgs 2>&1 | Tee-Object -FilePath $logPath | Out-Null
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($buildExit -ne 0) {
    throw "docker buildx build failed (exit $buildExit). See $logPath"
}

# Fail loudly on any BuildKit warning so they never silently accumulate.
$warnings = Select-String -Path $logPath -Pattern 'WARN' -CaseSensitive:$false
if ($warnings) {
    Write-Host '==> BuildKit warnings:' -ForegroundColor Yellow
    $warnings | ForEach-Object { Write-Host "    $($_.Line)" -ForegroundColor Yellow }
}

# --- 5. Export + gzip ----------------------------------------------------
Write-Host "==> Exporting de/fr/renner/plugin/heatshield:$version" -ForegroundColor Cyan
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& docker save "de/fr/renner/plugin/heatshield:$version" -o $tarPath 2>&1 | Out-Null
$saveExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($saveExit -ne 0) { throw "docker save failed (exit $saveExit)" }

if (Test-Path $gzPath) { Remove-Item $gzPath -Force }
$src = [System.IO.File]::OpenRead($tarPath)
try {
    $dst = [System.IO.File]::Create($gzPath)
    try {
        $gz = New-Object System.IO.Compression.GZipStream($dst, [System.IO.Compression.CompressionLevel]::Optimal)
        try { $src.CopyTo($gz) } finally { $gz.Dispose() }
    } finally { $dst.Dispose() }
} finally { $src.Dispose() }
Remove-Item $tarPath -Force

$sizeMb = [math]::Round((Get-Item $gzPath).Length / 1MB, 1)
Write-Host ''
Write-Host "==> Done." -ForegroundColor Green
Write-Host "    Version : $version"
Write-Host "    Build   : $buildId"
Write-Host "    Artefact: $gzPath ($sizeMb MB)"
Write-Host "    Upload this .tar.gz in HCUweb. The dashboard 'Plugin-Build' line"
Write-Host "    will read: $buildId"
