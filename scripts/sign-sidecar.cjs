'use strict';

/**
 * electron-builder afterPack hook: Authenticode-signs the PyInstaller sidecar
 * (<appOutDir>/resources/engine/cowork-export/cowork-export.exe).
 *
 * electron-builder only signs the app executable + installer; extraResources
 * binaries are ours to sign. Uses PowerShell Set-AuthenticodeSignature with the
 * same certificate electron-builder is configured with: the pfx path comes from
 * win.signtoolOptions.certificateFile in electron.builder.yml (resolved
 * relative to app/), falling back to build/cert/dev-cert.pfx (see
 * scripts/make-dev-cert.ps1). Swapping a real cert into electron.builder.yml
 * + env therefore signs the sidecar with it too.
 *
 * Password source: CSC_KEY_PASSWORD (or WIN_CSC_KEY_PASSWORD) env var, falling
 * back to build/cert/dev-cert.pass only when neither is set.
 *
 * Accepted signature states:
 *   - 'Valid'        — signed, chain trusted (after scripts/trust-dev-cert.ps1)
 *   - 'UnknownError' — signed, but the self-signed chain is not trusted yet;
 *                      expected before trust-dev-cert.ps1 has been run.
 * Anything else fails the build.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEV_PFX_PATH = path.join(REPO_ROOT, 'build', 'cert', 'dev-cert.pfx');
const DEV_PASS_FILE = path.join(REPO_ROOT, 'build', 'cert', 'dev-cert.pass');
const TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

// Prefer the cert electron-builder itself is configured to sign with
// (win.signtoolOptions.certificateFile, relative to the workspace root app/);
// fall back to the dev pfx only when nothing is configured.
function resolvePfxPath(context) {
  const packager = context.packager || {};
  const winOptions = packager.platformSpecificBuildOptions || {};
  const configured = winOptions.signtoolOptions && winOptions.signtoolOptions.certificateFile;
  if (configured) {
    const appDir = packager.projectDir || path.join(REPO_ROOT, 'app');
    return path.resolve(appDir, configured);
  }
  return DEV_PFX_PATH;
}

// Prefer the password electron-builder uses (CSC_KEY_PASSWORD /
// WIN_CSC_KEY_PASSWORD); fall back to the dev pass file only when neither
// env var is set.
function resolvePassword() {
  const envPass = process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD;
  if (envPass) return envPass;
  if (fs.existsSync(DEV_PASS_FILE)) {
    const pass = fs.readFileSync(DEV_PASS_FILE, 'utf8').trim();
    if (pass) return pass;
  }
  throw new Error(
    'sign-sidecar: no certificate password found — expected the CSC_KEY_PASSWORD ' +
      `(or WIN_CSC_KEY_PASSWORD) env var, or ${DEV_PASS_FILE} (run scripts/make-dev-cert.ps1).`
  );
}

module.exports = async function signSidecar(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(
    context.appOutDir,
    'resources',
    'engine',
    'cowork-export',
    'cowork-export.exe'
  );
  if (!fs.existsSync(exePath)) {
    throw new Error(`sign-sidecar: sidecar not found at ${exePath} — was extraResources packed?`);
  }
  const pfxPath = resolvePfxPath(context);
  if (!fs.existsSync(pfxPath)) {
    throw new Error(
      `sign-sidecar: certificate not found at ${pfxPath} — check win.signtoolOptions.certificateFile ` +
        'in electron.builder.yml, or run scripts/make-dev-cert.ps1 for the dev cert.'
    );
  }

  // Password/paths travel via env vars, never via command line (no escaping issues,
  // not visible in process listings). Script is passed as -EncodedCommand for the
  // same reason.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:COWORK_SIGN_PFX, $env:COWORK_SIGN_PASS)',
    `$r = Set-AuthenticodeSignature -FilePath $env:COWORK_SIGN_TARGET -Certificate $cert -HashAlgorithm SHA256 -TimestampServer '${TIMESTAMP_SERVER}'`,
    'Write-Output ("SIGN_STATUS=" + $r.Status)',
    'Write-Output ("SIGN_MESSAGE=" + $r.StatusMessage)',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  let stdout;
  try {
    stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: {
          ...process.env,
          COWORK_SIGN_PFX: pfxPath,
          COWORK_SIGN_PASS: resolvePassword(),
          COWORK_SIGN_TARGET: exePath,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      }
    );
  } catch (err) {
    throw new Error(
      `sign-sidecar: Set-AuthenticodeSignature failed for ${exePath}\n` +
        `stdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`
    );
  }

  const match = /SIGN_STATUS=(\w+)/.exec(stdout);
  const status = match ? match[1] : '(none)';
  if (status !== 'Valid' && status !== 'UnknownError') {
    throw new Error(
      `sign-sidecar: unexpected signature status '${status}' on ${exePath} ` +
        `(expected Valid, or UnknownError before trust-dev-cert.ps1 has run)\n${stdout}`
    );
  }
  console.log(`  • sign-sidecar signed resources/engine/cowork-export/cowork-export.exe status=${status}`);
};
