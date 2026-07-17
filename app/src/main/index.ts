/**
 * Main-process entry (Task 8 + integration wiring).
 *
 * Single-instance lock, window lifecycle (saved bounds with on-screen
 * validation, minimize/close-to-tray, one-time tray hint), tray, service
 * construction (StateStore → EngineService → WatcherService), watcher →
 * renderer event wiring, and IPC handler registration.
 */
import { app, BrowserWindow, Notification, dialog, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import { EVENT_CHANNELS, type EventChannel } from '../shared/ipc'
import { EngineService } from './engine'
import { registerAllHandlers, watcherRootsOverride } from './ipc-handlers'
import { getStateStore, type StateStore } from './state'
import { createTray, showWindow } from './tray'
import { WatcherService } from './watcher'

const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 720
const BOUNDS_SAVE_DEBOUNCE_MS = 500
/** Minimum time the splash stays up so it doesn't flash — the window
 *  usually loads in well under a second. */
const SPLASH_MIN_MS = 2200

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let splashShownAt = 0
let isQuitting = false
let quitCleanupDone = false

function getWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null
}

/** Frameless branded splash shown while the main window boots. */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#FDEDE1',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const splashHtml = app.isPackaged
    ? join(process.resourcesPath, 'splash', 'splash.html')
    : join(__dirname, '../../resources/splash/splash.html')
  void splash.loadFile(splashHtml)
  splash.once('ready-to-show', () => splash.show())
  return splash
}

function closeSplash(): void {
  if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

function sendToRenderer(channel: EventChannel, payload?: unknown): void {
  const win = getWindow()
  if (win === null) return
  if (payload === undefined) win.webContents.send(channel)
  else win.webContents.send(channel, payload)
}

/**
 * One-time (store flag `trayHintShown`) toast explaining that the app kept
 * running — Win11 hides new tray icons behind the overflow chevron.
 */
function maybeShowTrayHint(state: StateStore): void {
  if (state.getFlag('trayHintShown')) return
  state.setFlag('trayHintShown')
  if (Notification.isSupported()) {
    new Notification({
      title: 'Still running',
      body: 'ClaudeLift minimized to the tray.'
    }).show()
  }
}

/**
 * Saved window bounds, but only when they still intersect a connected
 * display's work area (monitor unplugged / resolution changed → default).
 */
function restoredBounds(state: StateStore): { x?: number; y?: number; width: number; height: number } {
  const saved = state.getWindowBounds()
  if (saved === null) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const area = screen.getDisplayMatching(saved).workArea
  const intersects =
    saved.x < area.x + area.width &&
    saved.x + saved.width > area.x &&
    saved.y < area.y + area.height &&
    saved.y + saved.height > area.y
  if (!intersects) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  return saved
}

function createWindow(state: StateStore): BrowserWindow {
  const win = new BrowserWindow({
    ...restoredBounds(state),
    minWidth: 480,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    // Hold the splash for a minimum on-screen time so it doesn't flash;
    // keep the main window hidden behind it until then.
    const remaining = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt))
    setTimeout(() => {
      closeSplash()
      if (!state.getSettings().startMinimized) win.show() // else stays in the tray
    }, remaining)
  })

  // Debounced bounds persistence; getNormalBounds() ignores the transient
  // maximized/minimized rects so restores land on the true normal bounds.
  let boundsTimer: NodeJS.Timeout | null = null
  const scheduleBoundsSave = (): void => {
    if (boundsTimer !== null) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (win.isDestroyed()) return
      state.saveWindowBounds(win.getNormalBounds())
    }, BOUNDS_SAVE_DEBOUNCE_MS)
  }
  win.on('resize', scheduleBoundsSave)
  win.on('move', scheduleBoundsSave)

  // Electron types the 'minimize' listener as `() => void`, but the runtime
  // still passes an Event — the optional param keeps both happy.
  win.on('minimize', (event?: Electron.Event) => {
    if (!state.getSettings().minimizeToTray) return
    event?.preventDefault()
    win.hide()
    maybeShowTrayHint(state)
  })

  win.on('close', (event) => {
    if (isQuitting) return
    if (!state.getSettings().closeToTray) return
    event.preventDefault()
    win.hide()
    maybeShowTrayHint(state)
  })

  win.on('closed', () => {
    if (boundsTimer !== null) clearTimeout(boundsTimer)
    if (mainWindow === win) mainWindow = null
  })

  // window.open / target=_blank (NotionView uses it for page links): send
  // external http(s) URLs to the system browser and deny everything —
  // this app never opens child Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Navigation lockdown: rendered markdown (bundle preview) can carry
  // arbitrary links, and a plain <a href> click navigates the privileged
  // renderer in-place — setWindowOpenHandler does not cover that. Only the
  // app's own document may load (dev: the vite dev-server origin from
  // ELECTRON_RENDERER_URL / packaged: the file: index.html) plus
  // about:blank; blocked http(s) URLs go to the system browser instead.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const isInternalUrl = (url: string): boolean => {
    if (url === 'about:blank') return true
    if (!app.isPackaged && rendererUrl) {
      try {
        return new URL(url).origin === new URL(rendererUrl).origin
      } catch {
        return false
      }
    }
    return url.startsWith('file:')
  }
  const blockExternalNavigation = (event: Electron.Event, url: string): void => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', blockExternalNavigation)
  win.webContents.on('will-redirect', blockExternalNavigation)

  // Diagnosability: a dead renderer otherwise fails silently (blank window).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[lifecycle] renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  // In dev, electron-vite serves the renderer and injects ELECTRON_RENDERER_URL
  // (read into `rendererUrl` above, where it also anchors isInternalUrl).
  if (!app.isPackaged && rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getWindow()
    if (win !== null) showWindow(win)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Diagnosability: log GPU/utility/etc. process crashes (renderer crashes
  // are logged per-window via 'render-process-gone').
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[lifecycle] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
        (details.name !== undefined ? ` name=${details.name}` : '')
    )
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.editmypodcast.claudelift')

    const state = getStateStore()
    const engine = new EngineService()
    const watcher = new WatcherService()

    splashWindow = createSplash()
    splashShownAt = Date.now()
    // Safety net: never let the splash outlive a stalled main-window boot.
    setTimeout(closeSplash, 12000)

    const win = createWindow(state)
    mainWindow = win

    registerAllHandlers({ ipcMain, dialog, shell, engine, state, watcher, getWindow })

    watcher.onDirty(() => sendToRenderer(EVENT_CHANNELS.tasksChanged))
    watcher.onStateChange((watcherState) => sendToRenderer(EVENT_CHANNELS.watcherState, watcherState))

    const settings = state.getSettings()
    if (settings.watcherEnabled) watcher.start(watcherRootsOverride(settings))

    createTray(win, {
      getSettings: () => state.getSettings(),
      onRefresh: () => sendToRenderer(EVENT_CHANNELS.tasksChanged),
      // TODO(Task-10): also open the export modal preselecting the most
      // recent task; until then "Export latest…" surfaces the window.
      onExportLatest: () => showWindow(win),
      onQuit: () => {
        isQuitting = true
        app.quit()
      }
    })

    app.on('before-quit', (event) => {
      isQuitting = true
      if (quitCleanupDone) return
      event.preventDefault()
      quitCleanupDone = true
      // shutdown() (not cancelExport()) so queued jobs are dropped and the
      // live engine child is killed whatever command it is running
      // (import/seed/list included), regardless of export tag.
      engine.shutdown()
      void watcher.stop().finally(() => app.quit())
    })
  })
}
