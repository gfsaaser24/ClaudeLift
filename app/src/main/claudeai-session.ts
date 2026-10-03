/**
 * claude.ai session route: ClaudeLift's own claude.ai window.
 *
 * The primary way to pull a claude.ai account — no Claude Desktop, no
 * Developer Mode, no keystrokes. The user signs in once in a normal
 * claude.ai page that ClaudeLift opens; the cookies live in a dedicated
 * persistent session (`persist:claudeai`) that the app's own windows never
 * use. A pull then loads claude.ai in a hidden window of that session, runs
 * scripts/pull-claude-projects.js in the page (the same script the DevTools
 * route types into Claude Desktop) and saves the script's download.
 *
 * Security: the claude.ai windows get no preload and no IPC
 * (contextIsolation + sandbox, nodeIntegration off). Their main frame may
 * only navigate to https://claude.ai and the sign-in providers it redirects
 * to; sub-frames may not load file: or other non-web schemes; popups are
 * allowed only for the sign-in window and only to allowed URLs. Permission
 * requests (camera, notifications, …) are denied.
 *
 * Pure helpers (URL allow-list, login-URL check, console-line parsing,
 * download-name matching, org-list parsing) are exported for unit tests.
 */
import { BrowserWindow, session } from 'electron'
import type { DownloadItem, Session, WebContents } from 'electron'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ClaudeAiPullProgress,
  ClaudeAiPullResult,
  ClaudeAiSessionStatus,
  PullChatsMode
} from '../shared/ipc'
import { BridgeError, buildPullScript, pullFileName, pullScriptPath } from './devtools-bridge'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The dedicated persistent session. Never used for the app's own windows. */
export const CLAUDE_PARTITION = 'persist:claudeai'
const CLAUDE_ORIGIN = 'https://claude.ai'
const LOGIN_URL = 'https://claude.ai/login'
const HOME_URL = 'https://claude.ai/'
const ORGS_URL = 'https://claude.ai/api/organizations'
/** Sub-folder of settings.outputDir that receives the pull files. */
export const PULL_DIR_NAME = 'claude-account-pulls'

const SIGN_IN_POLL_MS = 2000
const STATUS_FETCH_TIMEOUT_MS = 15_000
const PROGRESS_MS = 3000
const PULL_TIMEOUT_MS = 60 * 60 * 1000
const LOAD_TIMEOUT_MS = 90_000
/** Time for claude.ai's client-side redirects (e.g. to /login) after load. */
const SETTLE_MS = 1500
/** After the script returns, its download must start within this time. */
const DOWNLOAD_START_GRACE_MS = 60_000
const MAX_LINE_CHARS = 2000

const SIGN_IN_FIRST = 'Sign in first: you are not signed in to claude.ai in ClaudeLift. Press "Sign in" and sign in.'

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Hosts the sign-in flow may visit (exact match). */
const PROVIDER_HOSTS: readonly string[] = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'challenges.cloudflare.com'
]

/** Domains the sign-in flow may visit, including their sub-domains (SSO providers). */
const PROVIDER_DOMAINS: readonly string[] = [
  'claude.ai',
  'anthropic.com',
  'workos.com',
  'okta.com',
  'oktapreview.com',
  'okta-emea.com',
  'auth0.com',
  'onelogin.com'
]

/** Google's per-country sign-in hosts (accounts.google.de, accounts.google.co.uk, …). */
const GOOGLE_COUNTRY_RE = /^accounts\.google\.(?:com?\.)?[a-z]{2,3}$/

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * May a claude.ai session window's MAIN frame go to `raw`? Only https URLs
 * on claude.ai and the sign-in providers claude.ai redirects to (plus
 * about:blank, which sign-in popups start on). Never file:, http:, data: …
 */
export function isAllowedSessionUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  const url = parseUrl(raw)
  if (url === null || url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  if (PROVIDER_HOSTS.includes(host) || GOOGLE_COUNTRY_RE.test(host)) return true
  return PROVIDER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** Sub-frames (embeds, captchas) may load web content, never file: or other local schemes. */
export function isAllowedSubframeUrl(raw: string): boolean {
  const url = parseUrl(raw)
  if (url === null) return false
  return ['https:', 'about:', 'blob:', 'data:'].includes(url.protocol)
}

/** True for a page on https://claude.ai itself. */
export function isClaudeUrl(raw: string): boolean {
  return parseUrl(raw)?.origin === CLAUDE_ORIGIN
}

/** True for claude.ai's sign-in pages (where a signed-out session lands). */
export function isLoginUrl(raw: string): boolean {
  const url = parseUrl(raw)
  if (url === null || url.origin !== CLAUDE_ORIGIN) return false
  return /^\/(?:login|logout|magic-link)(?:\/|$)/i.test(url.pathname)
}

/**
 * The text of a `[pull]` console line of the pull script, or null for any
 * other console message. The script logs `console.log('%c[pull]', css, …)`;
 * Chromium reports that either formatted ("[pull] text") or raw
 * ("%c[pull] color:…;font-weight:bold text") — the %c and its CSS argument
 * are removed.
 */
export function parsePullConsoleLine(message: string): string | null {
  const match = /^(%c)?\[pull\]([\s\S]*)$/.exec(message.trim())
  if (match === null) return null
  let rest = match[2].trim()
  if (match[1] !== undefined) {
    // The CSS argument directly follows the format string: one token with a ':'.
    rest = rest.replace(/^[a-z-]+\s*:\S*\s*/i, '')
  }
  rest = rest.replace(/%c/g, '')
  return rest.length > MAX_LINE_CHARS ? `${rest.slice(0, MAX_LINE_CHARS)}…` : rest
}

/** Is `filename` the download of pull `runId`? (Other downloads are ignored.) */
export function isPullDownload(filename: string, runId: string): boolean {
  return filename.toLowerCase() === pullFileName(runId).toLowerCase()
}

const OrgListSchema = z.array(z.looseObject({ name: z.string().nullish() }))

/**
 * Signed in = `GET /api/organizations` answered 200 with a non-empty array.
 * Only the org names are kept.
 */
export function orgsFromResponse(status: number, body: unknown): { signedIn: boolean; orgNames: string[] } {
  if (status !== 200) return { signedIn: false, orgNames: [] }
  const parsed = OrgListSchema.safeParse(body)
  if (!parsed.success || parsed.data.length === 0) return { signedIn: false, orgNames: [] }
  const orgNames = parsed.data.map((org) => (org.name ?? '').trim()).filter((name) => name !== '')
  return { signedIn: true, orgNames }
}

/** Folder that receives the pull files: `<outputDir>/claude-account-pulls`. */
export function pullsDir(outputDir: string): string {
  return join(outputDir, PULL_DIR_NAME)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// session + windows
// ---------------------------------------------------------------------------

let claudeSes: Session | null = null

/** The `persist:claudeai` session (created on first use, after app ready). */
function claudeSession(): Session {
  if (claudeSes === null) {
    const ses = session.fromPartition(CLAUDE_PARTITION)
    // The default user agent is kept on purpose (claude.ai and Google check it).
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    claudeSes = ses
  }
  return claudeSes
}

/** True when `wc` belongs to the claude.ai session (those pages get no IPC). */
export function isClaudeSessionContents(wc: WebContents): boolean {
  return claudeSes !== null && wc.session === claudeSes
}

function sessionWebPreferences(): Electron.WebPreferences {
  return {
    partition: CLAUDE_PARTITION,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: false
  }
}

/** Every open window of the claude.ai session (sign-in, its popups, hidden pull). */
const sessionWindows = new Set<BrowserWindow>()

function track(win: BrowserWindow): void {
  sessionWindows.add(win)
  win.once('closed', () => sessionWindows.delete(win))
}

/** Navigation and popup lockdown for a claude.ai session window. */
function harden(win: BrowserWindow, allowPopups: boolean): void {
  const wc = win.webContents
  wc.on('will-navigate', (details) => {
    if (!isAllowedSessionUrl(details.url)) details.preventDefault()
  })
  wc.on('will-frame-navigate', (details) => {
    const ok = details.isMainFrame ? isAllowedSessionUrl(details.url) : isAllowedSubframeUrl(details.url)
    if (!ok) details.preventDefault()
  })
  wc.on('will-redirect', (details) => {
    const ok = details.isMainFrame ? isAllowedSessionUrl(details.url) : isAllowedSubframeUrl(details.url)
    if (!ok) details.preventDefault()
  })
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    if (!allowPopups || !isAllowedSessionUrl(url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        width: 520,
        height: 700,
        autoHideMenuBar: true,
        webPreferences: sessionWebPreferences()
      }
    }
  })
  wc.on('did-create-window', (child) => {
    track(child)
    harden(child, true)
  })
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

let statusListener: ((status: ClaudeAiSessionStatus) => void) | null = null

/** Where status changes go (sign-in detected, sign-in window closed). */
export function setStatusListener(listener: ((status: ClaudeAiSessionStatus) => void) | null): void {
  statusListener = listener
}

function emitStatus(status: ClaudeAiSessionStatus): void {
  statusListener?.(status)
}

let signInWin: BrowserWindow | null = null
let signInTimer: ReturnType<typeof setInterval> | null = null

function signInWindowOpen(): boolean {
  return signInWin !== null && !signInWin.isDestroyed()
}

const InPageOrgsSchema = z.object({ status: z.number().int(), body: z.unknown() })

const IN_PAGE_ORGS_JS = `fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } })
  .then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => null) : null }))`

/**
 * `GET /api/organizations` with the session's cookies. When the answer is
 * not JSON (e.g. a Cloudflare check page), ask an open claude.ai page of
 * the session to make the same request instead.
 */
async function fetchOrganizations(): Promise<{ status: number; body: unknown }> {
  const res = await claudeSession().fetch(ORGS_URL, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS)
  })
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null }
  }
  const page = [...sessionWindows].find(
    (w) => !w.isDestroyed() && !w.webContents.isLoading() && isClaudeUrl(w.webContents.getURL())
  )
  if (page !== undefined) {
    try {
      return InPageOrgsSchema.parse(await page.webContents.executeJavaScript(IN_PAGE_ORGS_JS, true))
    } catch {
      // fall through to the session answer
    }
  }
  return { status: res.status, body: null }
}

/** Is the claude.ai session signed in? Read-only. */
export async function status(): Promise<ClaudeAiSessionStatus> {
  const open = signInWindowOpen()
  try {
    const { status: code, body } = await fetchOrganizations()
    return { ...orgsFromResponse(code, body), signInWindowOpen: open, error: null }
  } catch (err) {
    return { signedIn: false, orgNames: [], signInWindowOpen: open, error: `Could not reach claude.ai: ${errMessage(err)}` }
  }
}

// ---------------------------------------------------------------------------
// sign in / sign out
// ---------------------------------------------------------------------------

function stopSignInPoll(): void {
  if (signInTimer !== null) clearInterval(signInTimer)
  signInTimer = null
}

/** Poll every 2 s while the sign-in window is open; close it once signed in. */
function startSignInPoll(win: BrowserWindow): void {
  stopSignInPoll()
  let inFlight = false
  signInTimer = setInterval(() => {
    if (inFlight || win.isDestroyed()) return
    inFlight = true
    void status()
      .then(async (current) => {
        if (!current.signedIn || win.isDestroyed()) return
        stopSignInPoll()
        await claudeSession().cookies.flushStore().catch(() => undefined)
        if (signInWin === win) signInWin = null
        emitStatus({ ...current, signInWindowOpen: false })
        if (!win.isDestroyed()) win.close()
      })
      .finally(() => {
        inFlight = false
      })
  }, SIGN_IN_POLL_MS)
}

/**
 * Open the visible "Sign in to claude.ai" window on the session (focus it
 * when already open). It closes itself once the session is signed in.
 */
export function openSignIn(): void {
  if (signInWin !== null && !signInWin.isDestroyed()) {
    if (signInWin.isMinimized()) signInWin.restore()
    signInWin.show()
    signInWin.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: 'Sign in to claude.ai',
    autoHideMenuBar: true,
    show: true,
    webPreferences: sessionWebPreferences()
  })
  signInWin = win
  track(win)
  harden(win, true)
  // Keep our title so the user knows which window this is.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.once('closed', () => {
    if (signInWin !== win) return
    signInWin = null
    stopSignInPoll()
    void status().then(emitStatus)
  })
  startSignInPoll(win)
  win.loadURL(LOGIN_URL).catch(() => {
    // A redirect (already signed in → /new) aborts the first load; harmless.
  })
}

/** Remove the claude.ai sign-in (cookies, storage, cache) and close the session windows. */
export async function signOut(): Promise<ClaudeAiSessionStatus> {
  cancelPull()
  stopSignInPoll()
  signInWin = null
  for (const win of [...sessionWindows]) {
    if (!win.isDestroyed()) win.destroy()
  }
  const ses = claudeSession()
  await ses.clearStorageData()
  await ses.clearCache().catch(() => undefined)
  await ses.clearAuthCache().catch(() => undefined)
  const signedOut: ClaudeAiSessionStatus = { signedIn: false, orgNames: [], signInWindowOpen: false, error: null }
  emitStatus(signedOut)
  return signedOut
}

// ---------------------------------------------------------------------------
// account pull in a hidden window
// ---------------------------------------------------------------------------

export interface ClaudeAiRunPullOptions {
  runId: string
  chats: PullChatsMode
  /** Folder that receives `claudelift-pull-<runId>.json` (created when missing). */
  outDir: string
}

interface ActivePull {
  runId: string
  abort: AbortController
}

let activePull: ActivePull | null = null

/** Cancel the running pull (no-op when idle). */
export function cancelPull(): void {
  activePull?.abort.abort()
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Load claude.ai; a client redirect that aborts the first load waits for the next one. */
async function loadClaude(wc: WebContents): Promise<void> {
  try {
    await wc.loadURL(HOME_URL)
  } catch (err) {
    if (!/ERR_ABORTED|\(-3\)/.test(errMessage(err))) {
      throw new BridgeError('crash', `Could not open claude.ai: ${errMessage(err)}`)
    }
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()))
    }
  }
}

/**
 * Pull the signed-in account: load https://claude.ai/ in a hidden window of
 * the session, run the pull script in the page and save its download to
 * `outDir`. `onProgress` gets `[pull]` console lines, phase changes and a
 * tick every 3 s. Timeout 60 min; cancel with cancelPull(). The hidden
 * window and every listener are always cleaned up.
 */
export async function runPull(
  opts: ClaudeAiRunPullOptions,
  onProgress: (event: ClaudeAiPullProgress) => void
): Promise<ClaudeAiPullResult> {
  if (activePull !== null) throw new BridgeError('validation', 'A pull is already running.')
  const abort = new AbortController()
  activePull = { runId: opts.runId, abort }
  const startedAt = Date.now()

  let phase: ClaudeAiPullProgress['phase'] = 'checking'
  let fileBytes: number | null = null
  let finished = false
  const emit = (line: string | null): void => {
    if (finished) return
    onProgress({
      runId: opts.runId,
      phase,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      line,
      fileBytes
    })
  }
  const setPhase = (next: ClaudeAiPullProgress['phase']): void => {
    phase = next
    emit(null)
  }
  const ticker = setInterval(() => emit(null), PROGRESS_MS)

  const cleanups: (() => void)[] = []
  let win: BrowserWindow | null = null
  let downloadItem: DownloadItem | null = null

  // One failure channel for cancel, timeout, crash, closed window, login page.
  let fail: (err: BridgeError) => void = () => undefined
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  failed.catch(() => undefined)
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed])

  const onAbort = (): void => fail(new BridgeError('aborted', 'Pull cancelled.'))
  abort.signal.addEventListener('abort', onAbort, { once: true })
  cleanups.push(() => abort.signal.removeEventListener('abort', onAbort))
  const timeout = setTimeout(
    () => fail(new BridgeError('crash', 'The pull did not finish within 60 minutes.')),
    PULL_TIMEOUT_MS
  )
  cleanups.push(() => clearTimeout(timeout))

  try {
    emit(null)
    const before = await race(status())
    if (!before.signedIn) {
      throw new BridgeError('validation', before.error !== null ? before.error : SIGN_IN_FIRST)
    }

    const scriptPath = pullScriptPath()
    let script: string
    try {
      script = await readFile(scriptPath, 'utf8')
    } catch {
      throw new BridgeError('crash', `Pull script not found: ${scriptPath}`)
    }
    await mkdir(opts.outDir, { recursive: true })
    const savePath = join(opts.outDir, pullFileName(opts.runId))

    // Catch this run's download (and only it) before the script runs.
    const ses = claudeSession()
    const downloaded = new Promise<string>((resolve, reject) => {
      const onWillDownload = (_event: Electron.Event, item: DownloadItem): void => {
        if (downloadItem !== null || !isPullDownload(item.getFilename(), opts.runId)) return
        downloadItem = item
        item.setSavePath(savePath)
        fileBytes = 0
        setPhase('saving')
        item.on('updated', () => {
          fileBytes = item.getReceivedBytes()
        })
        item.once('done', (_e, state) => {
          fileBytes = item.getReceivedBytes()
          if (state === 'completed') resolve(item.getSavePath() || savePath)
          else reject(new BridgeError('crash', `Saving the pull file was ${state}.`))
        })
      }
      ses.on('will-download', onWillDownload)
      cleanups.push(() => ses.removeListener('will-download', onWillDownload))
    })
    downloaded.catch(() => undefined)

    setPhase('loading')
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      title: 'ClaudeLift account pull',
      webPreferences: { ...sessionWebPreferences(), backgroundThrottling: false }
    })
    track(win)
    harden(win, false)
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.on('console-message', (details) => {
      const line = parsePullConsoleLine(details.message)
      if (line !== null) emit(line)
    })
    wc.on('render-process-gone', (_event, details) => {
      fail(new BridgeError('crash', `The claude.ai page stopped (${details.reason}).`))
    })
    wc.on('did-navigate', (_event, url) => {
      if (isLoginUrl(url)) fail(new BridgeError('validation', SIGN_IN_FIRST))
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && isLoginUrl(url)) fail(new BridgeError('validation', SIGN_IN_FIRST))
    })
    win.once('closed', () => fail(new BridgeError('crash', 'The claude.ai page was closed.')))

    const loadTimeout = delay(LOAD_TIMEOUT_MS).then(() => {
      throw new BridgeError('crash', 'claude.ai did not load within 90 seconds.')
    })
    loadTimeout.catch(() => undefined)
    await race(Promise.race([loadClaude(wc), loadTimeout]))
    await race(delay(SETTLE_MS))
    const url = wc.getURL()
    if (isLoginUrl(url)) throw new BridgeError('validation', SIGN_IN_FIRST)
    if (!isClaudeUrl(url)) {
      throw new BridgeError('crash', `claude.ai did not open (the page is at ${url === '' ? 'nothing' : url}).`)
    }

    if (downloadItem === null) setPhase('running')
    const scriptRun = wc.executeJavaScript(buildPullScript(script, opts), true)
    const scriptWatch = scriptRun.then(
      async () => {
        // The script clicks the download as its last step; give it time to start.
        const waitUntil = Date.now() + DOWNLOAD_START_GRACE_MS
        while (downloadItem === null && Date.now() < waitUntil) await delay(500)
        if (downloadItem === null) {
          throw new BridgeError('crash', 'The pull script finished but saved no file. See the log for the reason.')
        }
        return downloaded
      },
      (err: unknown) => {
        throw new BridgeError('crash', `The pull script failed: ${errMessage(err)}`)
      }
    )
    scriptWatch.catch(() => undefined)

    const file = await race(Promise.race([downloaded, scriptWatch]))
    const st = await stat(file)
    return { file, sizeBytes: st.size, outDir: opts.outDir }
  } catch (err) {
    const item = downloadItem as DownloadItem | null
    if (item !== null && item.getState() === 'progressing') item.cancel()
    throw err
  } finally {
    finished = true
    clearInterval(ticker)
    for (const cleanup of cleanups) cleanup()
    const hidden = win as BrowserWindow | null
    if (hidden !== null && !hidden.isDestroyed()) hidden.destroy()
    if (activePull?.abort === abort) activePull = null
  }
}

// ---------------------------------------------------------------------------
// page executor for the project push (project-push.ts)
// ---------------------------------------------------------------------------

/**
 * Open https://claude.ai/ in a hidden window of the session and return an
 * executor that runs JS in it (`executeJavaScript`, user gesture on). The
 * caller must dispose() it. Fails when the session is not signed in.
 */
export async function openPushPage(): Promise<{
  label: string
  runInPage(js: string): Promise<unknown>
  dispose(): void
}> {
  const current = await status()
  if (!current.signedIn) throw new BridgeError('validation', current.error ?? SIGN_IN_FIRST)
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    title: 'ClaudeLift project push',
    webPreferences: { ...sessionWebPreferences(), backgroundThrottling: false }
  })
  track(win)
  harden(win, false)
  const wc = win.webContents
  wc.setAudioMuted(true)
  let gone: string | null = null
  wc.on('render-process-gone', (_event, details) => {
    gone = `The claude.ai page stopped (${details.reason}).`
  })
  const dispose = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  try {
    const loadTimeout = delay(LOAD_TIMEOUT_MS).then(() => {
      throw new BridgeError('crash', 'claude.ai did not load within 90 seconds.')
    })
    loadTimeout.catch(() => undefined)
    await Promise.race([loadClaude(wc), loadTimeout])
    await delay(SETTLE_MS)
    const url = wc.getURL()
    if (isLoginUrl(url)) throw new BridgeError('validation', SIGN_IN_FIRST)
    if (!isClaudeUrl(url)) throw new BridgeError('crash', `claude.ai did not open (the page is at ${url || 'nothing'}).`)
  } catch (err) {
    dispose()
    throw err
  }
  return {
    label: "ClaudeLift's claude.ai sign-in",
    async runInPage(js: string): Promise<unknown> {
      if (gone !== null) throw new BridgeError('crash', gone)
      if (win.isDestroyed()) throw new BridgeError('crash', 'The claude.ai page was closed.')
      if (isLoginUrl(wc.getURL())) throw new BridgeError('validation', SIGN_IN_FIRST)
      return wc.executeJavaScript(js, true)
    },
    dispose
  }
}
