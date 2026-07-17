$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
py -3.14 -m pip install --quiet "pyinstaller==6.21.0"
if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed (exit $LASTEXITCODE)" }
py -3.14 -m PyInstaller --noconfirm --clean --onedir --console --name cowork-export `
  --distpath "$root\app\resources\engine" --workpath "$root\build\pyi" --specpath "$root\build" `
  "$root\cowork_export.py"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed (exit $LASTEXITCODE) - a stale engine exe may remain in app\resources\engine" }
& "$root\app\resources\engine\cowork-export\cowork-export.exe" list --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sidecar smoke test failed" }
Write-Host "engine OK: $root\app\resources\engine\cowork-export\cowork-export.exe"
