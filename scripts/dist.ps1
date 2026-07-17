# Dist-build wrapper (invoked by `npm run dist` in app/).
#
# electron-builder never reads build\cert\dev-cert.pass on its own, so a fresh
# shell would otherwise sign with an empty/wrong password. This wrapper wires
# the dev-cert password (and pfx path) into the env vars electron-builder and
# scripts/sign-sidecar.cjs expect, then runs the build.
#
# Swapping to a real cert: point electron.builder.yml's certificateFile at it
# and set CSC_KEY_PASSWORD (and CSC_LINK) in the environment before running -
# pre-set env vars win over the dev-cert defaults below.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$appDir = Join-Path $root "app"
$passFile = Join-Path $root "build\cert\dev-cert.pass"
$pfxFile = Join-Path $root "build\cert\dev-cert.pfx"

if (-not $env:CSC_KEY_PASSWORD) {
  if (-not (Test-Path $passFile)) {
    throw "dist: signing password not found at $passFile - run scripts\make-dev-cert.ps1 first."
  }
  $rawPass = Get-Content $passFile -Raw
  if ([string]::IsNullOrWhiteSpace($rawPass)) {
    throw "dist: $passFile is empty - re-run scripts\make-dev-cert.ps1 to regenerate it."
  }
  $env:CSC_KEY_PASSWORD = $rawPass.Trim()
}

if (-not $env:CSC_LINK) {
  if (-not (Test-Path $pfxFile)) {
    throw "dist: certificate not found at $pfxFile - run scripts\make-dev-cert.ps1 first."
  }
  $env:CSC_LINK = (Resolve-Path $pfxFile).Path
}

Push-Location $appDir
try {
  npm run build:mcp
  if ($LASTEXITCODE -ne 0) { throw "dist: build:mcp (MCP server bundle) failed (exit $LASTEXITCODE)" }
  npx electron-vite build
  if ($LASTEXITCODE -ne 0) { throw "dist: electron-vite build failed (exit $LASTEXITCODE)" }
  npx electron-builder --win --config electron.builder.yml --config.extraMetadata.version=0.5.0
  if ($LASTEXITCODE -ne 0) { throw "dist: electron-builder failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
