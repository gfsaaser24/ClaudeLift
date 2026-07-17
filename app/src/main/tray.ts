/**
 * TrayService (Task 8).
 *
 * The Tray instance is held in a module-scope variable so it is never
 * garbage-collected (a GC'd Tray silently vanishes from the notification
 * area). Win11 hides new tray icons behind the overflow chevron by design;
 * the one-time "Still running" Notification (index.ts) explains that.
 */
import { app, Menu, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '../shared/ipc'

/**
 * Stable tray GUID so Windows keeps the icon's notification-area position
 * across restarts. Passed ONLY when packaged: Windows ties a tray GUID to
 * the exe's signed path, and a dev electron.exe would poison the GUID
 * registration for the installed app.
 */
const TRAY_GUID = '7f9c1b2e-4a3d-4f6e-9b1a-c0e8f14d27a3'

export interface TrayCallbacks {
  /** Live settings snapshot (reserved for future settings-aware menu items). */
  getSettings: () => AppSettings
  /** "Refresh now" — same path as the renderer's manual refresh. */
  onRefresh: () => void
  /** "Export latest…" — surface the app (Task 10 wires the export modal). */
  onExportLatest: () => void
  /** "Quit" — caller sets its quitting flag and calls app.quit(). */
  onQuit: () => void
}

let tray: Tray | null = null

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', 'tray.ico')
    : join(__dirname, '../../resources/icons/tray.ico')
}

/** Restore (if minimized), show, and focus the window. */
export function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(win: BrowserWindow): void {
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    showWindow(win)
  }
}

/**
 * Create the tray icon with its context menu. Idempotent — a second call
 * returns the existing instance.
 */
export function createTray(win: BrowserWindow, callbacks: TrayCallbacks): Tray {
  if (tray !== null) return tray
  tray = app.isPackaged ? new Tray(trayIconPath(), TRAY_GUID) : new Tray(trayIconPath())
  tray.setToolTip('ClaudeLift')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow(win) },
      { label: 'Refresh now', click: () => callbacks.onRefresh() },
      { label: 'Export latest…', click: () => callbacks.onExportLatest() },
      { type: 'separator' },
      { label: 'Quit', click: () => callbacks.onQuit() }
    ])
  )
  tray.on('click', () => toggleWindow(win))
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
