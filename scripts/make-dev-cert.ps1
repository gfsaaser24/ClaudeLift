# Creates (or reuses) a self-signed code-signing certificate for dev builds and
# exports it to build\cert\dev-cert.pfx (+ .cer for trust-dev-cert.ps1).
#
# Password resolution:
#   1. $env:CSC_KEY_PASSWORD if set
#   2. existing build\cert\dev-cert.pass
#   3. freshly generated random 24-char password
# The effective password is always written to build\cert\dev-cert.pass
# (gitignored via build/) so the pfx and the pass file never drift apart -
# scripts/sign-sidecar.cjs and the dist build read it from there.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# Reuse an existing dev cert instead of piling up duplicates in the store.
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq "CN=EditMyPodcast Dev" -and $_.NotAfter -gt (Get-Date).AddDays(30) -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if ($cert) {
  Write-Host "Reusing existing certificate $($cert.Thumbprint) (expires $($cert.NotAfter.ToString('yyyy-MM-dd')))"
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=EditMyPodcast Dev" `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(3)
  Write-Host "Created new certificate $($cert.Thumbprint)"
}

$certDir = "$root\build\cert"
New-Item -ItemType Directory -Force $certDir | Out-Null
$passFile = "$certDir\dev-cert.pass"

if ($env:CSC_KEY_PASSWORD) {
  $plain = $env:CSC_KEY_PASSWORD
  Write-Host "Using password from CSC_KEY_PASSWORD"
} else {
  # PS5.1: Get-Content -Raw returns $null for an empty file, so never call
  # .Trim() on it directly - guard with [string]::IsNullOrWhiteSpace instead.
  $existingPass = $null
  if (Test-Path $passFile) { $existingPass = Get-Content $passFile -Raw }
  if (-not [string]::IsNullOrWhiteSpace($existingPass)) {
    $plain = $existingPass.Trim()
    Write-Host "Using existing password from build\cert\dev-cert.pass"
  } else {
    # Random 24-char password (unambiguous alphanumerics - safe for signtool args).
    $alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $plain = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
    Write-Host "Generated random 24-char password"
  }
}

# Keep pass file in sync with whatever password protects the pfx.
Set-Content -Path $passFile -Value $plain -Encoding Ascii -NoNewline

$pfxPassword = ConvertTo-SecureString $plain -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$certDir\dev-cert.pfx" -Password $pfxPassword | Out-Null
Export-Certificate    -Cert $cert -FilePath "$certDir\dev-cert.cer" -Force | Out-Null

Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "PFX:        $certDir\dev-cert.pfx"
Write-Host "CER:        $certDir\dev-cert.cer"
Write-Host "Pass file:  $passFile"
Write-Host ""
Write-Host "Next: run scripts\trust-dev-cert.ps1 from an ELEVATED PowerShell so signed"
Write-Host "binaries verify as 'Valid' on this machine (until then they verify as"
Write-Host "'UnknownError' = signed but chain untrusted, which is expected)."
