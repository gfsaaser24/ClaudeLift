/**
 * Preload bridge: exposes `window.api` — one typed wrapper per invoke
 * channel (thin `ipcRenderer.invoke` passthroughs) plus on/off subscribe
 * helpers for the `evt:` push channels. ONLY the channels named in the
 * shared IPC contract are reachable from the renderer.
 *
 * IMPORTANT — no runtime imports besides 'electron' here. The preload runs
 * sandboxed (`sandbox: true`), where `require()` only resolves 'electron'
 * and a handful of builtins; `externalizeDepsPlugin()` would leave a value
 * import of ../shared/ipc as `require('zod')` and crash the bridge at load.
 * Channel names are therefore duplicated as literals below and locked to
 * the shared contract at compile time via `satisfies` on type-only imports.
 * Response zod-parsing happens renderer-side with schemas from shared/ipc.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  CoworkExporterApi,
  EventChannel,
  EventChannelMap,
  InvokeChannel,
  InvokeChannelMap,
  NotionExportState,
  ProgressEvent,
  Unsubscribe,
  WatcherState
} from '../shared/ipc'

const CH = {
  tasksList: 'tasks:list',
  tasksExport: 'tasks:export',
  tasksExportCancel: 'tasks:exportCancel',
  bundlesScan: 'bundles:scan',
  bundlesImport: 'bundles:import',
  bundlesSeed: 'bundles:seed',
  bundlesReadMarkdown: 'bundles:readMarkdown',
  bundlesOpenFolder: 'bundles:openFolder',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsClearAll: 'settings:clearAll',
  notionConnect: 'notion:connect',
  notionDisconnect: 'notion:disconnect',
  notionStatus: 'notion:status',
  notionSetParentPage: 'notion:setParentPage',
  notionExport: 'notion:export',
  notionRetry: 'notion:retry',
  appPickFolder: 'app:pickFolder',
  appDiagnostics: 'app:diagnostics',
  mcpInfo: 'mcp:info',
  mcpInstallToClaudeDesktop: 'mcp:installToClaudeDesktop',
  mcpRevealServer: 'mcp:revealServer'
} as const satisfies InvokeChannelMap

const EV = {
  tasksChanged: 'evt:tasksChanged',
  exportProgress: 'evt:exportProgress',
  notionProgress: 'evt:notionProgress',
  watcherState: 'evt:watcherState'
} as const satisfies EventChannelMap

function invoke<T>(channel: InvokeChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

interface EventBridge<Args extends unknown[]> {
  on(cb: (...args: Args) => void): Unsubscribe
  off(cb?: (...args: Args) => void): void
}

/**
 * on/off helpers for one `evt:` channel. `on` returns an unsubscribe
 * closure (always reliable). `off(cb)` detaches that callback when its
 * identity survived the contextBridge crossing; `off()` with no argument
 * detaches every listener on the channel.
 */
function eventBridge<Args extends unknown[]>(
  channel: EventChannel
): EventBridge<Args> {
  const proxies = new Map<
    (...args: Args) => void,
    (event: IpcRendererEvent, ...args: unknown[]) => void
  >()

  const off = (cb?: (...args: Args) => void): void => {
    if (cb === undefined) {
      proxies.clear()
      ipcRenderer.removeAllListeners(channel)
      return
    }
    const listener = proxies.get(cb)
    if (listener !== undefined) {
      proxies.delete(cb)
      ipcRenderer.removeListener(channel, listener)
    }
  }

  const on = (cb: (...args: Args) => void): Unsubscribe => {
    if (proxies.has(cb)) off(cb) // never double-subscribe the same callback
    const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      cb(...(args as Args))
    }
    proxies.set(cb, listener)
    ipcRenderer.on(channel, listener)
    return () => {
      if (proxies.get(cb) === listener) proxies.delete(cb)
      ipcRenderer.removeListener(channel, listener)
    }
  }

  return { on, off }
}

const tasksChanged = eventBridge<[]>(EV.tasksChanged)
const exportProgress = eventBridge<[ProgressEvent]>(EV.exportProgress)
const notionProgress = eventBridge<[NotionExportState]>(EV.notionProgress)
const watcherState = eventBridge<[WatcherState]>(EV.watcherState)

const api: CoworkExporterApi = {
  tasksList: (req) => invoke(CH.tasksList, req),
  tasksExport: (opts) => invoke(CH.tasksExport, opts),
  tasksExportCancel: () => invoke(CH.tasksExportCancel),
  bundlesScan: () => invoke(CH.bundlesScan),
  bundlesImport: (opts) => invoke(CH.bundlesImport, opts),
  bundlesSeed: (opts) => invoke(CH.bundlesSeed, opts),
  bundlesReadMarkdown: (req) => invoke(CH.bundlesReadMarkdown, req),
  bundlesOpenFolder: (req) => invoke(CH.bundlesOpenFolder, req),
  settingsGet: () => invoke(CH.settingsGet),
  settingsSet: (patch) => invoke(CH.settingsSet, patch),
  settingsClearAll: () => invoke(CH.settingsClearAll),
  notionConnect: (req) => invoke(CH.notionConnect, req),
  notionDisconnect: () => invoke(CH.notionDisconnect),
  notionStatus: () => invoke(CH.notionStatus),
  notionSetParentPage: (req) => invoke(CH.notionSetParentPage, req),
  notionExport: (req) => invoke(CH.notionExport, req),
  notionRetry: (req) => invoke(CH.notionRetry, req),
  appPickFolder: (req) => invoke(CH.appPickFolder, req),
  appDiagnostics: () => invoke(CH.appDiagnostics),
  mcpInfo: () => invoke(CH.mcpInfo),
  mcpInstallToClaudeDesktop: () => invoke(CH.mcpInstallToClaudeDesktop),
  mcpRevealServer: () => invoke(CH.mcpRevealServer),

  onTasksChanged: tasksChanged.on,
  offTasksChanged: tasksChanged.off,
  onExportProgress: exportProgress.on,
  offExportProgress: exportProgress.off,
  onNotionProgress: notionProgress.on,
  offNotionProgress: notionProgress.off,
  onWatcherState: watcherState.on,
  offWatcherState: watcherState.off
}

contextBridge.exposeInMainWorld('api', api)
