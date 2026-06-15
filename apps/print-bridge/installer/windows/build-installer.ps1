# Builds the Windows .exe installer for the OrderHub Print Bridge.
#
# Runs the pkg toolchain to produce the standalone Node binary, then
# invokes NSIS (`makensis.exe`) to wrap it in a self-extracting
# installer that registers a Windows Service.
#
# Pre-requisites on the build host:
#   * pnpm + Node 20+
#   * NSIS 3.x (chocolatey: `choco install nsis`)
#   * Optional: signtool.exe + code-signing cert for production builds
#
# Outputs: dist/print-bridge/orderhub-print-bridge-windows-x64.exe
#
# Usage (PowerShell):
#   .\build-installer.ps1
#   .\build-installer.ps1 -SigningCertThumbprint "ABCD…"

param(
  [string]$SigningCertThumbprint = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeDir   = Resolve-Path "$ScriptDir\..\.."
$RootDir     = Resolve-Path "$BridgeDir\..\.."
$OutDir      = "$RootDir\dist\print-bridge"
$BinStaging  = "$BridgeDir\dist-bin"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinStaging | Out-Null

# Read version from package.json so the installer + service description
# match the binary that's actually shipping.
$packageJson = Get-Content "$BridgeDir\package.json" -Raw | ConvertFrom-Json
$Version = $packageJson.version

Write-Host "→ Building bridge TypeScript..."
Push-Location $BridgeDir
pnpm build
if ($LASTEXITCODE -ne 0) { throw "tsc failed" }

Write-Host "→ Bundling standalone Windows binary with pkg..."
& pnpm exec pkg . --targets node18-win-x64 --output "$BinStaging\orderhub-print-bridge.exe"
if ($LASTEXITCODE -ne 0) { throw "pkg failed" }
Pop-Location

Write-Host "→ Locating makensis..."
$Makensis = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
if (-not $Makensis) {
  $Candidates = @(
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "${env:ProgramFiles}\NSIS\makensis.exe"
  )
  foreach ($p in $Candidates) {
    if (Test-Path $p) { $Makensis = $p; break }
  }
}
if (-not $Makensis) {
  throw "makensis.exe not found. Install NSIS: choco install nsis"
}

Write-Host "→ Running makensis..."
& $Makensis "/DPRODUCT_VERSION=$Version" "$ScriptDir\installer.nsi"
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }

$InstallerPath = "$OutDir\orderhub-print-bridge-windows-x64.exe"
if (-not (Test-Path $InstallerPath)) {
  throw "Installer did not appear at $InstallerPath"
}

# Code-sign if a cert thumbprint was supplied. Without it, Windows
# SmartScreen will flag the .exe as "unrecognized" the first time —
# operators can still install via "More info → Run anyway" but it's
# friction we want to remove for production builds.
if ($SigningCertThumbprint) {
  Write-Host "→ Signing with cert $SigningCertThumbprint..."
  & signtool sign /sha1 $SigningCertThumbprint `
    /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
    "$InstallerPath"
  if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
}

Write-Host ""
Write-Host "✓ Built $InstallerPath"
Get-Item $InstallerPath | Format-List Name, Length, LastWriteTime
