/**
 * DevTools bridge: drives the claude.ai DevTools console of Claude Desktop
 * (Windows only).
 *
 * Claude Desktop refuses --remote-debugging-port, so the only supported way
 * to run code in the signed-in claude.ai page is the DevTools window the user
 * opens (Help → Troubleshooting → Enable Developer Mode, then Ctrl+Shift+I on
 * the claude.ai view). This module finds that window by title, screenshots it
 * without stealing focus (PrintWindow), and — only when asked to run a pull —
 * brings it to the front, verifies it IS in front, clicks the console prompt
 * and pastes JS through the clipboard (never through SendKeys, which mangles
 * + ^ % ~ ( ) { }).
 *
 * All Win32 work runs in short-lived `powershell.exe -EncodedCommand`
 * children. The P/Invoke type is compiled once per app session into a cached
 * DLL under userData (falls back to compiling inline when that fails).
 *
 * Pure helpers (title matching, PowerShell JSON parsing, pull-file matching,
 * size-stability tracking) are exported for unit tests.
 */
import { app, clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ClaudeConsoleInfo,
  ClaudeConsoleProgress,
  ClaudeConsolePullRequest,
  ClaudeConsolePullResult,
  PullChatsMode,
  WindowRect
} from '../shared/ipc'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Every DevTools window title starts with this. */
const DEVTOOLS_PREFIX = 'Developer Tools - '
/** The claude.ai DevTools (NOT "Developer Tools - file:///…app.asar…", the app shell). */
export const CLAUDE_CONSOLE_PREFIX = 'Developer Tools - https://claude.ai'
const CLAUDE_CONSOLE_RE = /^Developer Tools - https:\/\/claude\.ai(?:[/?#]|$)/i
/** Same rule, PowerShell `-match` flavor (case-insensitive by default). */
const CLAUDE_CONSOLE_PS_RE = '^Developer Tools - https://claude\\.ai([/?#]|$)'

const POLL_MS = 1000
const STABLE_MS = 3000
const PROGRESS_MS = 3000
const PULL_TIMEOUT_MS = 60 * 60 * 1000
const PS_TIMEOUT_MS = 30_000
/** Screenshots wider than this are scaled down before PNG encoding. */
const SCREENSHOT_MAX_WIDTH = 1000

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type BridgeErrorKind = 'validation' | 'aborted' | 'crash'

/** Error with an IPC error kind (cancel → 'aborted', bad state → 'validation'). */
export class BridgeError extends Error {
  readonly kind: BridgeErrorKind
  constructor(kind: BridgeErrorKind, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.kind = kind
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new BridgeError('validation', 'Driving the Claude Desktop DevTools window only works on Windows.')
  }
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** True for the claude.ai DevTools window title (not the app-shell DevTools). */
export function isClaudeConsoleTitle(title: string): boolean {
  return CLAUDE_CONSOLE_RE.test(title)
}

export const PsWindowSchema = z.object({
  hwnd: z.number().int(),
  title: z.string(),
  left: z.number().int(),
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
  minimized: z.boolean()
})

export type PsWindow = z.infer<typeof PsWindowSchema>

/** First claude.ai DevTools window of a window list, or null. */
export function pickClaudeConsole(windows: readonly PsWindow[]): PsWindow | null {
  return windows.find((w) => isClaudeConsoleTitle(w.title)) ?? null
}

/**
 * True when only Claude Desktop's own shell DevTools is open
 * ("Developer Tools - file:///…app.asar…"). That is what Developer → Show Dev
 * Tools (Ctrl+Alt+I) opens; its console is not the claude.ai page and cannot
 * read the account. Show All Dev Tools opens the claude.ai one too.
 */
export function onlyShellDevtools(windows: readonly PsWindow[]): boolean {
  return (
    pickClaudeConsole(windows) === null &&
    windows.some((w) => /^Developer Tools - file:\/\/\/.*app\.asar/i.test(w.title))
  )
}

/**
 * Parse the JSON document a bridge script printed. Scripts print exactly one
 * JSON line, but PowerShell can put noise (warnings, a BOM, CLIXML) around
 * it — take the LAST line that parses as a JSON object.
 */
export function parsePowerShellJson(stdout: string): unknown {
  const lines = stdout
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // try the previous candidate
    }
  }
  throw new Error(`PowerShell printed no JSON result:\n${stdout.slice(0, 2000)}`)
}

const PsFailureSchema = z.object({ ok: z.literal(false), error: z.string() })

/** Throw the script's own error message when it reported `{ok:false}`. */
function unwrapPsResult<T extends z.ZodTypeAny>(raw: unknown, schema: T): z.infer<T> {
  const failure = PsFailureSchema.safeParse(raw)
  if (failure.success) throw new BridgeError('crash', failure.data.error)
  return schema.parse(raw)
}

const FindOutputSchema = z.object({
  ok: z.literal(true),
  // ConvertTo-Json renders a one-item array inside a hashtable as an array,
  // but accept a lone object too, to be safe.
  windows: z.union([z.array(PsWindowSchema), PsWindowSchema.transform((w) => [w])]).nullable()
})

/** Parse the find script's stdout into the DevTools window list. */
export function parseFindOutput(stdout: string): PsWindow[] {
  return unwrapPsResult(parsePowerShellJson(stdout), FindOutputSchema).windows ?? []
}

/** File name the pull script downloads for `runId`. */
export function pullFileName(runId: string): string {
  return `claudelift-pull-${runId}.json`
}

/**
 * The finished pull file among `names` (a Downloads listing), or null.
 * Accepts the browser's " (1)" de-dupe suffix; ignores partial downloads
 * (.crdownload / .tmp / .part never end in .json).
 */
export function matchPullFile(names: readonly string[], runId: string): string | null {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^claudelift-pull-${escaped}(?: \\(\\d+\\))?\\.json$`, 'i')
  const hits = names.filter((name) => re.test(name))
  if (hits.length === 0) return null
  // Prefer the exact name over a de-duped copy.
  return hits.find((name) => name.toLowerCase() === pullFileName(runId).toLowerCase()) ?? hits[0]
}

export interface StabilityState {
  size: number
  /** When `size` was first seen (ms epoch). */
  since: number
}

/**
 * Size-stability tracker for a file that is still being written: returns the
 * next state and whether the size has been non-zero and unchanged for at
 * least `stableMs`.
 */
export function updateStability(
  prev: StabilityState | null,
  size: number,
  nowMs: number,
  stableMs: number = STABLE_MS
): { state: StabilityState; stable: boolean } {
  if (prev === null || prev.size !== size) {
    return { state: { size, since: nowMs }, stable: false }
  }
  return { state: prev, stable: size > 0 && nowMs - prev.since >= stableMs }
}

/** The JS typed into the console: the options global, then the pull script. */
export function buildPullScript(script: string, opts: { runId: string; chats: PullChatsMode }): string {
  return `globalThis.__CLAUDELIFT_PULL_OPTS = ${JSON.stringify({ runId: opts.runId, chats: opts.chats })};\n${script}`
}

/** PowerShell single-quoted string literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `-EncodedCommand` payload: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function toRect(w: PsWindow): WindowRect {
  return { left: w.left, top: w.top, right: w.right, bottom: w.bottom }
}

// ---------------------------------------------------------------------------
// PowerShell plumbing
// ---------------------------------------------------------------------------

const CSHARP_SOURCE = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ClaudeLiftWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
  public static string Title(IntPtr h) {
    var s = new StringBuilder(1024);
    GetWindowText(h, s, 1024);
    return s.ToString();
  }
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  // The first window above \`target\` in z-order that really covers (x, y).
  // Click-through overlays (WS_EX_TRANSPARENT, e.g. cursor or screen-capture
  // overlays), hidden, minimized and DWM-cloaked windows do not count:
  // clicks pass through them to the console.
  public static IntPtr Covering(IntPtr target, int x, int y) {
    for (IntPtr w = GetWindow(target, 3); w != IntPtr.Zero; w = GetWindow(w, 3)) {
      if (!IsWindowVisible(w) || IsIconic(w)) continue;
      if ((GetWindowLong(w, -20) & 0x20) != 0) continue;
      int cloaked;
      if (DwmGetWindowAttribute(w, 14, out cloaked, 4) == 0 && cloaked != 0) continue;
      RECT r;
      GetWindowRect(w, out r);
      if (x >= r.L && x < r.R && y >= r.T && y < r.B) return w;
    }
    return IntPtr.Zero;
  }
  public static IntPtr[] List(string prefix) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && Title(h).StartsWith(prefix, StringComparison.Ordinal)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
`

const SOURCE_HASH = createHash('sha256').update(CSHARP_SOURCE).digest('hex').slice(0, 12)

/** Cached DLL path once compiled; null = compile inline in every script. */
let assemblyPath: string | null = null
let assemblyReady: Promise<void> | null = null

function inlineTypeLoader(): string {
  return `if (-not ('ClaudeLiftWin' -as [type])) {\nAdd-Type -TypeDefinition @'\n${CSHARP_SOURCE}\n'@\n}`
}

function typeLoader(): string {
  return assemblyPath !== null ? `Add-Type -Path ${psQuote(assemblyPath)}` : inlineTypeLoader()
}

/** Wrap a script body: strict errors, UTF-8 out, one JSON line on failure. */
function wrapScript(body: string, assemblies: string[] = []): string {
  const loadAssemblies = assemblies.map((a) => `Add-Type -AssemblyName ${a}`).join('\n')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'function Emit($obj) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 6 -InputObject $obj)) }',
    'try {',
    loadAssemblies,
    typeLoader(),
    '[void][ClaudeLiftWin]::SetProcessDPIAware()',
    body,
    '} catch {',
    '  Emit @{ ok = $false; error = $_.Exception.Message }',
    '}'
  ].join('\n')
}

interface PsResult {
  code: number | null
  stdout: string
  stderr: string
}

function runPowerShell(script: string, timeoutMs: number = PS_TIMEOUT_MS): Promise<PsResult> {
  return new Promise((resolvePs, rejectPs) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => {
      child.kill()
      rejectPs(new BridgeError('crash', `PowerShell did not finish within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      rejectPs(new BridgeError('crash', `Could not start PowerShell: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePs({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })
  })
}

/** Run a wrapped bridge script and return its parsed JSON result. */
async function runBridgeScript(body: string, assemblies: string[] = [], timeoutMs?: number): Promise<unknown> {
  await ensureAssembly()
  const result = await runPowerShell(wrapScript(body, assemblies), timeoutMs)
  try {
    return parsePowerShellJson(result.stdout)
  } catch {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 2000)
    throw new BridgeError('crash', `PowerShell bridge failed (exit ${String(result.code)})${detail ? `: ${detail}` : ''}`)
  }
}

/**
 * Compile the P/Invoke type into a cached DLL once per session (Add-Type of a
 * DLL is far cheaper than compiling C# on every 2 s poll). Any failure keeps
 * the inline fallback — never fatal.
 */
function ensureAssembly(): Promise<void> {
  if (assemblyReady !== null) return assemblyReady
  assemblyReady = (async () => {
    try {
      const dir = join(app.getPath('userData'), 'devtools-bridge')
      const finalPath = join(dir, `claudelift-win-${SOURCE_HASH}.dll`)
      if (existsSync(finalPath)) {
        assemblyPath = finalPath
        return
      }
      await mkdir(dir, { recursive: true })
      const tmpPath = join(dir, `claudelift-win-${SOURCE_HASH}-${process.pid}-${Date.now()}.tmp.dll`)
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `Add-Type -OutputType Library -OutputAssembly ${psQuote(tmpPath)} -TypeDefinition @'`,
        CSHARP_SOURCE,
        "'@",
        "[Console]::Out.WriteLine('{\"ok\":true}')"
      ].join('\n')
      const result = await runPowerShell(script, 60_000)
      if (!existsSync(tmpPath)) throw new Error(result.stderr || 'no assembly written')
      try {
        await rename(tmpPath, finalPath)
      } catch {
        await unlink(tmpPath).catch(() => undefined)
      }
      if (existsSync(finalPath)) assemblyPath = finalPath
    } catch {
      assemblyPath = null
    }
  })()
  return assemblyReady
}

// ---------------------------------------------------------------------------
// find / screenshot (read-only, never change focus)
// ---------------------------------------------------------------------------

const FIND_BODY = `
$items = @()
foreach ($h in [ClaudeLiftWin]::List(${psQuote(DEVTOOLS_PREFIX)})) {
  $r = New-Object ClaudeLiftWin+RECT
  [void][ClaudeLiftWin]::GetWindowRect($h, [ref]$r)
  $items += @{ hwnd = $h.ToInt64(); title = [ClaudeLiftWin]::Title($h); left = $r.L; top = $r.T; right = $r.R; bottom = $r.B; minimized = [ClaudeLiftWin]::IsIconic($h) }
}
Emit @{ ok = $true; windows = $items }
`

/** Every visible "Developer Tools - …" window. */
async function listDevtools(): Promise<PsWindow[]> {
  assertWindows()
  const raw = await runBridgeScript(FIND_BODY)
  return unwrapPsResult(raw, FindOutputSchema).windows ?? []
}

/** Locate the claude.ai DevTools window; null when it is not open. */
async function locateConsole(): Promise<PsWindow | null> {
  return pickClaudeConsole(await listDevtools())
}

/** Is the claude.ai DevTools window open? Read-only. */
export async function findClaudeConsole(): Promise<ClaudeConsoleInfo> {
  if (process.platform !== 'win32') {
    return { supported: false, found: false, title: null, rect: null, minimized: false, shellOnly: false }
  }
  const windows = await listDevtools()
  const win = pickClaudeConsole(windows)
  if (win === null) {
    return { supported: true, found: false, title: null, rect: null, minimized: false, shellOnly: onlyShellDevtools(windows) }
  }
  return { supported: true, found: true, title: win.title, rect: toRect(win), minimized: win.minimized, shellOnly: false }
}

/** Re-check that `hwnd` is still the claude.ai DevTools window (PowerShell side). */
function verifyWindowSnippet(hwnd: number): string {
  return `
$h = [IntPtr]([int64]${hwnd})
if (-not [ClaudeLiftWin]::IsWindow($h)) { throw 'The DevTools window was closed.' }
$t = [ClaudeLiftWin]::Title($h)
if ($t -notmatch ${psQuote(CLAUDE_CONSOLE_PS_RE)}) { throw ('The window is no longer the claude.ai DevTools (title: ' + $t + ').') }
`
}

const ScreenshotOutputSchema = z.object({ ok: z.literal(true), png: z.string().nullable() })

/** PrintWindow screenshot of `hwnd` as base64 PNG (null when minimized). */
async function screenshotWindow(hwnd: number): Promise<string | null> {
  const body = `${verifyWindowSnippet(hwnd)}
if ([ClaudeLiftWin]::IsIconic($h)) { Emit @{ ok = $true; png = $null }; return }
$r = New-Object ClaudeLiftWin+RECT
[void][ClaudeLiftWin]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { Emit @{ ok = $true; png = $null }; return }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][ClaudeLiftWin]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$maxW = ${SCREENSHOT_MAX_WIDTH}
if ($w -gt $maxW) {
  $nh = [int]($hh * $maxW / $w)
  $small = New-Object System.Drawing.Bitmap $maxW, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $maxW, $nh); $g2.Dispose(); $bmp.Dispose(); $bmp = $small
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Emit @{ ok = $true; png = [Convert]::ToBase64String($ms.ToArray()) }
`
  const raw = await runBridgeScript(body, ['System.Drawing'])
  return unwrapPsResult(raw, ScreenshotOutputSchema).png
}

/** Screenshot of the claude.ai DevTools window, no focus change. Null when not open. */
export async function screenshotConsole(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const win = await locateConsole()
  if (win === null) return null
  return screenshotWindow(win.hwnd)
}

// ---------------------------------------------------------------------------
// typing into the console
// ---------------------------------------------------------------------------

/**
 * One foreground-and-type pass. 'prime' clears the prompt, pastes the
 * clipboard (a harmless probe — this triggers Chrome's paste warning when
 * pasting is still blocked), clears it again and types `allow pasting` +
 * Enter (lifts the block; otherwise a harmless SyntaxError line). 'paste'
 * clears the prompt, pastes the clipboard and presses Enter. Every send is
 * preceded by a foreground check; the script throws (typing nothing more)
 * the moment the DevTools window is not in front.
 */
function typingScript(hwnd: number, mode: 'prime' | 'paste'): string {
  const steps =
    mode === 'prime'
      ? `
Send '^v'; Start-Sleep -Milliseconds 300
Front; Send '^a'; Send '{BACKSPACE}'
Send 'allow pasting'; Send '{ENTER}'; Start-Sleep -Milliseconds 400
Front; Send '^a'; Send '{BACKSPACE}'
`
      : `
Send '^v'; Start-Sleep -Milliseconds 700
Front; Send '{ENTER}'; Start-Sleep -Milliseconds 300
`
  return `${verifyWindowSnippet(hwnd)}
function Front { if ([ClaudeLiftWin]::GetForegroundWindow() -ne $h) { throw 'The DevTools window is not in front; stopped typing.' } }
function Send($keys) { [System.Windows.Forms.SendKeys]::SendWait($keys) }
if ([ClaudeLiftWin]::IsIconic($h)) { [void][ClaudeLiftWin]::ShowWindow($h, 9) } else { [void][ClaudeLiftWin]::ShowWindow($h, 5) }
# An Alt tap lets this background process take the foreground.
[ClaudeLiftWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[ClaudeLiftWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][ClaudeLiftWin]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500
if ([ClaudeLiftWin]::GetForegroundWindow() -ne $h) { throw 'Could not bring the DevTools window to the front; nothing was typed.' }
$r = New-Object ClaudeLiftWin+RECT
[void][ClaudeLiftWin]::GetWindowRect($h, [ref]$r)
$x = [int](($r.L + $r.R) / 2)
# The console prompt row (or the empty area below it, which also focuses
# the prompt) sits just above the bottom edge.
$y = $r.B - 32
if ($y -lt ($r.T + 80)) { throw 'The DevTools window is too small to click its console prompt.' }
$cover = [ClaudeLiftWin]::Covering($h, $x, $y)
if ($cover -ne [IntPtr]::Zero) {
  $name = [ClaudeLiftWin]::Title($cover)
  throw ("Another window covers the DevTools console" + $(if ($name) { " ($name)" } else { '' }) + '; nothing was typed.')
}
$saved = New-Object ClaudeLiftWin+POINT
[void][ClaudeLiftWin]::GetCursorPos([ref]$saved)
[void][ClaudeLiftWin]::SetCursorPos($x, $y)
[ClaudeLiftWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[ClaudeLiftWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[void][ClaudeLiftWin]::SetCursorPos($saved.X, $saved.Y)
Front; Send '^a'; Send '{BACKSPACE}'
${steps}
Emit @{ ok = $true }
`
}

const OkSchema = z.object({ ok: z.literal(true) })

async function typeIntoConsole(hwnd: number, mode: 'prime' | 'paste'): Promise<void> {
  const raw = await runBridgeScript(typingScript(hwnd, mode), ['System.Windows.Forms'], 60_000)
  unwrapPsResult(raw, OkSchema)
}

interface SavedClipboard {
  text: string
  html: string
  rtf: string
  image: Electron.NativeImage | null
}

function saveClipboard(): SavedClipboard {
  const image = clipboard.readImage()
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image
  }
}

function restoreClipboard(saved: SavedClipboard): void {
  const data: Electron.Data = {}
  if (saved.text !== '') data.text = saved.text
  if (saved.html !== '') data.html = saved.html
  if (saved.rtf !== '') data.rtf = saved.rtf
  if (saved.image !== null) data.image = saved.image
  if (Object.keys(data).length === 0) clipboard.clear()
  else clipboard.write(data)
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let typing = false

/**
 * Run `js` in the claude.ai DevTools console: brings the window to the
 * front, verifies it is in front before every keystroke batch, lifts
 * Chrome's paste block (`allow pasting`), pastes `js` via the clipboard and
 * presses Enter. The user's clipboard is restored afterwards.
 *
 * Returns the window it typed into.
 */
export async function runInConsole(js: string): Promise<{ hwnd: number; title: string }> {
  assertWindows()
  if (typing) throw new BridgeError('validation', 'ClaudeLift is already typing into the DevTools window.')
  typing = true
  try {
    const win = await locateConsole()
    if (win === null) {
      throw new BridgeError(
        'validation',
        'The claude.ai DevTools window is not open. In Claude Desktop turn on Developer Mode, then press Ctrl+Shift+I on the claude.ai view.'
      )
    }
    const saved = saveClipboard()
    try {
      clipboard.writeText('0')
      await typeIntoConsole(win.hwnd, 'prime')
      clipboard.writeText(js)
      await typeIntoConsole(win.hwnd, 'paste')
      await delay(500) // let the paste settle before the clipboard changes back
    } finally {
      restoreClipboard(saved)
    }
    return { hwnd: win.hwnd, title: win.title }
  } finally {
    typing = false
  }
}

// ---------------------------------------------------------------------------
// account pull
// ---------------------------------------------------------------------------

/** dev: <repo>/scripts/…; packaged: resources/scripts/… (electron.builder.yml extraResources). */
export function pullScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scripts', 'pull-claude-projects.js')
    : join(__dirname, '../../../scripts/pull-claude-projects.js')
}

interface ActivePull {
  runId: string
  abort: AbortController
}

let activePull: ActivePull | null = null

/** Stop waiting for the running pull (the console keeps running its script). */
export function cancelPull(): void {
  activePull?.abort.abort()
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BridgeError('aborted', 'Pull cancelled.')
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolveDelay()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function currentPullFile(dir: string, runId: string): Promise<{ path: string; size: number } | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const name = matchPullFile(names, runId)
  if (name === null) return null
  try {
    const st = await stat(join(dir, name))
    return { path: join(dir, name), size: st.size }
  } catch {
    return null
  }
}

/**
 * Type the account-pull script into the claude.ai console, then watch the
 * Downloads folder for `claudelift-pull-<runId>.json` until its size has been
 * stable for 3 s (poll 1 s, timeout 60 min, cancellable via cancelPull()).
 * `onProgress` gets the elapsed time and a fresh screenshot about every 3 s.
 */
export async function runPull(
  req: ClaudeConsolePullRequest,
  onProgress: (event: ClaudeConsoleProgress) => void
): Promise<ClaudeConsolePullResult> {
  assertWindows()
  if (activePull !== null) throw new BridgeError('validation', 'A pull is already running.')
  const abort = new AbortController()
  activePull = { runId: req.runId, abort }
  const { signal } = abort
  const startedAt = Date.now()
  const elapsed = (): number => Math.floor((Date.now() - startedAt) / 1000)

  let phase: ClaudeConsoleProgress['phase'] = 'typing'
  let fileBytes: number | null = null
  let hwnd: number | null = null
  let shotInFlight = false
  const emit = (screenshot: string | null): void => {
    onProgress({ runId: req.runId, phase, elapsedSec: elapsed(), screenshot, fileBytes })
  }
  const progressTimer = setInterval(() => {
    if (shotInFlight) return
    if (hwnd === null) {
      emit(null)
      return
    }
    shotInFlight = true
    screenshotWindow(hwnd)
      .catch(() => null)
      .then((png) => {
        if (!signal.aborted && activePull?.runId === req.runId) emit(png)
      })
      .finally(() => {
        shotInFlight = false
      })
  }, PROGRESS_MS)

  try {
    const scriptPath = pullScriptPath()
    let script: string
    try {
      script = await readFile(scriptPath, 'utf8')
    } catch {
      throw new BridgeError('crash', `Pull script not found: ${scriptPath}`)
    }
    emit(null)
    const target = await runInConsole(buildPullScript(script, req))
    hwnd = target.hwnd
    throwIfAborted(signal)

    phase = 'waiting'
    const downloadsDir = app.getPath('downloads')
    let stability: StabilityState | null = null
    while (true) {
      throwIfAborted(signal)
      if (Date.now() - startedAt > PULL_TIMEOUT_MS) {
        throw new BridgeError(
          'crash',
          `No ${pullFileName(req.runId)} appeared in ${downloadsDir} within 60 minutes. Check the DevTools console for errors.`
        )
      }
      const file = await currentPullFile(downloadsDir, req.runId)
      if (file !== null) {
        phase = 'saving'
        fileBytes = file.size
        const next = updateStability(stability, file.size, Date.now())
        stability = next.state
        if (next.stable) {
          return { file: file.path, sizeBytes: file.size, downloadsDir }
        }
      }
      await abortableDelay(POLL_MS, signal)
    }
  } finally {
    clearInterval(progressTimer)
    if (activePull?.abort === abort) activePull = null
  }
}
