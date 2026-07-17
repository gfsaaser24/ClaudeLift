/**
 * registerAllHandlers: single entry point for every `ipcMain.handle`
 * registration. Delegates the engine-backed channels (tasks:*,
 * bundles:import, bundles:seed) to registerTaskHandlers, the
 * filesystem-backed bundle channels (bundles:scan/readMarkdown/openFolder)
 * to registerBundleHandlers (Task 12), the notion:* channels to
 * registerNotionHandlers (Task 13), and registers the rest here:
 * settings, folder picker, diagnostics.
 *
 * ERROR CONVENTION — identical to register-tasks.ts (its `toIpcError` is
 * module-private, so the tiny serializer is mirrored here): handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 */
import { app } from 'electron'
import type { BrowserWindow, Dialog, IpcMain, Shell } from 'electron'
import { ZodError } from 'zod'
import {
  AppSettingsPatchSchema,
  ENGINE_VERSION,
  INVOKE_CHANNELS,
  PickFolderRequestSchema,
  type AppSettings,
  type Diagnostics
} from '../shared/ipc'
import { EngineError, type EngineService } from './engine'
import { registerBundleHandlers } from './register-bundles'
import { registerMcpHandlers } from './register-mcp'
import { registerNotionHandlers } from './register-notion'
import { registerTaskHandlers, type SendToRenderer } from './register-tasks'
import type { StateStore } from './state'
import { discoverRoots, type WatcherService } from './watcher'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

/** Serialize any thrown value into the plain-Error-with-JSON-message shape. */
function toIpcError(err: unknown): Error {
  let shape: IpcErrorShape
  if (err instanceof EngineError) {
    shape = { kind: err.kind, message: err.message, stderr: err.stderr }
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

/**
 * Explicit watcher roots derived from settings: a non-null
 * `coworkRootOverride` pins the watcher to that single root; null means
 * auto-discover (WatcherService's own discovery).
 */
export function watcherRootsOverride(settings: AppSettings): string[] | undefined {
  return settings.coworkRootOverride !== null ? [settings.coworkRootOverride] : undefined
}

export interface RegisterAllOptions {
  ipcMain: IpcMain
  dialog: Dialog
  shell: Shell
  engine: EngineService
  state: StateStore
  watcher: WatcherService
  getWindow: () => BrowserWindow | null
}

export function registerAllHandlers(options: RegisterAllOptions): void {
  const { ipcMain, dialog, shell, engine, state, watcher, getWindow } = options

  const sendToRenderer: SendToRenderer = (channel, payload) => {
    getWindow()?.webContents.send(channel, payload)
  }

  registerTaskHandlers(ipcMain, engine, sendToRenderer)

  // -- settings ---------------------------------------------------------------

  ipcMain.handle(INVOKE_CHANNELS.settingsGet, () => {
    try {
      return state.getSettings()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.settingsSet, async (_event, payload: unknown) => {
    try {
      const patch = AppSettingsPatchSchema.parse(payload)
      const merged = state.setSettings(patch)
      // Live-apply: watcher toggle / root override changes take effect
      // immediately (restart also covers an override change while enabled).
      if (patch.watcherEnabled !== undefined || patch.coworkRootOverride !== undefined) {
        await watcher.stop()
        if (merged.watcherEnabled) watcher.start(watcherRootsOverride(merged))
      }
      return merged
    } catch (err) {
      throw toIpcError(err)
    }
  })

  // Danger zone: wipe ALL persisted state (settings, Notion config/journal,
  // flags, bounds) and respond with the fresh defaults. The renderer drives
  // the relaunch-free reset from that response — no extra event is pushed.
  ipcMain.handle(INVOKE_CHANNELS.settingsClearAll, () => {
    try {
      state.clearAll()
      return state.getSettings()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  // -- app --------------------------------------------------------------------

  ipcMain.handle(INVOKE_CHANNELS.appPickFolder, async (_event, payload: unknown) => {
    try {
      const req = PickFolderRequestSchema.parse(payload)
      const dialogOptions = {
        title: `Select a folder — ${req.purpose}`,
        properties: ['openDirectory' as const]
      }
      const win = getWindow()
      const result =
        win === null
          ? await dialog.showOpenDialog(dialogOptions)
          : await dialog.showOpenDialog(win, dialogOptions)
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.appDiagnostics, () => {
    try {
      const diagnostics: Diagnostics = {
        appVersion: app.getVersion(),
        engineVersion: ENGINE_VERSION,
        // Discovered directly (not watcher.state().roots) so the roots show
        // even while the watcher is disabled.
        scannedRoots: discoverRoots(state.getSettings().coworkRootOverride),
        watcher: watcher.state()
      }
      return diagnostics
    } catch (err) {
      throw toIpcError(err)
    }
  })

  // -- bundles (Task 12) ----------------------------------------------------------

  registerBundleHandlers({ ipcMain, shell, getState: () => state })

  // -- notion (Task 13) -----------------------------------------------------------

  registerNotionHandlers({ ipcMain, state, engine, getWindow })

  // -- mcp server -----------------------------------------------------------------

  registerMcpHandlers({ ipcMain, shell })
}
