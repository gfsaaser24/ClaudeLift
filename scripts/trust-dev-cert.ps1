#Requires -RunAsAdministrator
# Trusts the dev code-signing certificate machine-wide so that binaries signed
# with build\cert\dev-cert.pfx verify as Status=Valid.
#
# RUN THIS FROM AN ELEVATED (Run as administrator) POWERSHELL:
#   powershell -ExecutionPolicy Bypass -File scripts\trust-dev-cert.ps1
#
# Prerequisite: scripts\make-dev-cert.ps1 must have been run first (it creates
# build\cert\dev-cert.cer). This script imports the PUBLIC certificate only -
# no private key material leaves build\cert\.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$cerPath = "$root\build\cert\dev-cert.cer"

if (-not (Test-Path $cerPath)) {
  throw "Certificate not found: $cerPath - run scripts\make-dev-cert.ps1 first."
}

Write-Host "Importing $cerPath into LocalMachine\Root (trusted root CAs)..."
$rootCert = Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\Root

Write-Host "Importing $cerPath into LocalMachine\TrustedPublisher..."
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

Write-Host ""
Write-Host "Done. Trusted '$($rootCert.Subject)' (thumbprint $($rootCert.Thumbprint))."
Write-Host "Get-AuthenticodeSignature on the installer / app / sidecar exes should now"
Write-Host "report Status: Valid (was: UnknownError while the chain was untrusted)."
Write-Host ""
Write-Host "To undo later:"
Write-Host "  Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\TrustedPublisher |"
Write-Host "    Where-Object Thumbprint -eq '$($rootCert.Thumbprint)' | Remove-Item"
