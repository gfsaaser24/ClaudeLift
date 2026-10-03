/**
 * Complete zustand app store for ClaudeLift (Task 9).
 *
 * OWNERSHIP: this file is owned by the shell task. View agents (Tasks
 * 10-15) consume it but MUST NOT edit it — everything the views need
 * (state, actions, derived selectors) already lives here.
 *
 * Conventions (binding):
 * - Every window.api response is zod-parsed with the shared response
 *   schemas from src/shared/ipc.ts before it enters the store.
 * - Engine/IPC error convention: invoke rejections carry JSON in
 *   Error.message — slice from the first '{' and JSON.parse to
 *   {kind, message, stderr}. Use `parseIpcError` / `errorText` below.
 * - `evt:` push channels are subscribed exactly once (module-level
 *   guard inside initApp; off*() first so HMR never double-subscribes).
 * - `evt:exportProgress` events accumulate in `exportProgress` keyed by
 *   task_id; the batch-level `done` event (no task_id) accumulates
 *   under EXPORT_BATCH_KEY.
 */
import { create } from 'zustand'
import { z } from 'zod'
import {
  AppSettingsSchema,
  BundleInfoSchema,
  ClaudeAiPullProgressSchema,
  ClaudeAiPullResultSchema,
  ClaudeAiSessionStatusSchema,
  ClaudeConsoleInfoSchema,
  ClaudeConsoleProgressSchema,
  ClaudeConsolePullResultSchema,
  ConvertProgressEventSchema,
  ConvertResultSchema,
  DESKTOP_RUNNING_MARKER,
  DiagnosticsSchema,
  ExportResultSchema,
  ImportAllProgressEventSchema,
  ImportAllResultSchema,
  ListWorkspacesResultSchema,
  NotionExportStateSchema,
  NotionStatusSchema,
  ProgressEventSchema,
  TasksListResultSchema,
  WatcherStateSchema
} from '../shared/ipc'
import type {
  AppSettings,
  AppSettingsPatch,
  BundleInfo,
  ClaudeAiPullProgress,
  ClaudeAiPullResult,
  ClaudeAiSessionStatus,
  ClaudeConsoleInfo,
  ClaudeConsoleProgress,
  ClaudeConsolePullResult,
  ConvertClaudeAiOptions,
  ConvertProgressEvent,
  ConvertResult,
  CoworkTask,
  Diagnostics,
  ExportOptions,
  ImportAllOptions,
  ImportAllProgressEvent,
  ImportAllResult,
  NotionExportRequest,
  NotionExportState,
  NotionStatus,
  ProgressEvent,
  PullChatsMode,
  TaskSource,
  TasksListRequest,
  WatcherState,
  WorkspaceInfo
} from '../shared/ipc'

// ---------------------------------------------------------------------------
// Error helpers (JSON-in-message convention)
// ---------------------------------------------------------------------------

const EngineErrorInfoSchema = z.object({
  kind: z.string(),
  message: z.string(),
  stderr: z.string().optional()
})

export type EngineErrorInfo = z.infer<typeof EngineErrorInfoSchema>

/**
 * Extract the structured engine error from an ipcRenderer.invoke
 * rejection. Rejections carry JSON in Error.message — slice from the
 * first '{' and JSON.parse to {kind, message, stderr}. Returns null
 * when the message carries no parseable engine error.
 */
export function parseIpcError(err: unknown): EngineErrorInfo | null {
  if (!(err instanceof Error)) return null
  const start = err.message.indexOf('{')
  if (start === -1) return null
  try {
    return EngineErrorInfoSchema.parse(JSON.parse(err.message.slice(start)))
  } catch {
    return null
  }
}

/**
 * True when the engine refused to write because Claude Desktop is running
 * (exit 3 from import / import-all / import-space without --allow-running).
 */
export function isDesktopRunningError(info: EngineErrorInfo | null): boolean {
  if (info === null) return false
  return `${info.message}
${info.stderr ?? ''}`.includes(DESKTOP_RUNNING_MARKER)
}

/** Human-readable message for any thrown value (engine-aware). */
export function errorText(err: unknown): string {
  const info = parseIpcError(err)
  if (info) return info.message
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export type ViewName = 'tasks' | 'bundles' | 'migrate' | 'notion' | 'settings'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

export interface TaskFilters {
  /** Case-insensitive substring match on title + taskId. */
  search: string
  /** Exact spaceName match, or the sentinel 'all'. */
  space: string | 'all'
  /**
   * Engine list source. Kept in sync with settings.source by
   * loadSettings/patchSettings; refreshTasks always lists with
   * settings.source (persist a change via patchSettings({source})).
   */
  source: TaskSource
  sort: 'recent' | 'created' | 'title'
  showArchived: boolean
}

export interface ExportModalState {
  open: boolean
  tasks: CoworkTask[]
}

/**
 * Key in `exportProgress` under which batch-level progress events that
 * carry no task_id (the final `{"event":"done"}`) accumulate.
 */
export const EXPORT_BATCH_KEY = '__batch__'

/** Which Migrate-view flow owns the running/last migrate job. */
export type MigrateOwner = 'cowork' | 'claudeai' | 'account'

/** Result of a migrate action: the engine result, or the structured error. */
export type MigrateOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: EngineErrorInfo }

export interface MigrateJob {
  kind: 'convert' | 'importAll'
  owner: MigrateOwner
}

/** The DevTools account pull (Migrate card C) — live while running, last state after. */
export interface ConsolePullState {
  runId: string
  running: boolean
  phase: ClaudeConsoleProgress['phase']
  elapsedSec: number
  /** Latest console screenshot (base64 PNG); kept when a tick has none. */
  screenshot: string | null
  fileBytes: number | null
}

/** The sign-in route's account pull (Migrate card C) — live while running, last state after. */
export interface ClaudeAiPullState {
  runId: string
  running: boolean
  phase: ClaudeAiPullProgress['phase']
  elapsedSec: number
  fileBytes: number | null
  /** `[pull]` console lines of the pull script, oldest first (capped). */
  lines: string[]
}

/** Keep at most this many pull log lines in the store. */
const PULL_LOG_MAX_LINES = 500

/** Unique-enough id for one pull run (also part of the download's file name). */
function newPullRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${rand}`
}

export interface AppState {
  view: ViewName
  tasks: CoworkTask[]
  tasksLoading: boolean
  tasksError: string | null
  filters: TaskFilters
  selection: Set<string>
  settings: AppSettings | null
  diagnostics: Diagnostics | null
  watcher: WatcherState | null
  exportModal: ExportModalState
  exportProgress: Record<string, ProgressEvent[]>
  exportRunning: boolean
  bundles: BundleInfo[]
  bundlesLoading: boolean
  notion: NotionStatus | null
  notionLog: NotionExportState[]
  toasts: Toast[]
  /** The convert-claudeai / import-all job currently running, if any. */
  migrateJob: MigrateJob | null
  /** evt:convertProgress events of the latest convert run, in order. */
  convertProgress: ConvertProgressEvent[]
  /** evt:importAllProgress events of the latest import-all run, in order. */
  importAllProgress: ImportAllProgressEvent[]
  /** Which flow started the latest import-all (its progress belongs there). */
  importAllOwner: MigrateOwner | null
  /** DevTools account pull state (null before the first run). */
  consolePull: ConsolePullState | null
  /** ClaudeLift's own claude.ai session (null before the first check). */
  claudeAiSession: ClaudeAiSessionStatus | null
  /** True while a status check is in flight. */
  claudeAiSessionChecking: boolean
  /** Sign-in route account pull state (null before the first run). */
  claudeAiPull: ClaudeAiPullState | null

  /**
   * One-time app wiring: loadSettings → refreshTasks + refreshBundles +
   * refreshNotion + refreshDiagnostics, plus evt:* subscriptions
   * (module-level once-guard; safe to call from a StrictMode effect).
   */
  initApp(): Promise<void>
  setView(view: ViewName): void
  /**
   * Re-list tasks via the engine, using settings.source +
   * settings.coworkRootOverride. `silent` keeps the current list
   * rendered while reloading (no tasksLoading flip, no error toast).
   */
  refreshTasks(silent?: boolean): Promise<void>
  setFilter(patch: Partial<TaskFilters>): void
  toggleSelect(taskId: string): void
  clearSelection(): void
  selectAll(ids: string[]): void
  openExportModal(tasks: CoworkTask[]): void
  closeExportModal(): void
  /**
   * Run an export. Sets exportRunning, clears exportProgress (which the
   * evt:exportProgress subscription then re-fills keyed by task_id),
   * toasts on done/error, refreshes bundles on success. Resolves true
   * only when the batch completed AND exported ≥1 task — cancelled,
   * failed, and nothing-exported runs resolve false.
   */
  runExport(opts: ExportOptions): Promise<boolean>
  cancelExport(): Promise<void>
  /**
   * Rescan bundles. `outputDir` documents which directory is being
   * scanned; the main process always scans the persisted
   * settings.outputDir (bundles:scan takes no arguments).
   */
  refreshBundles(outputDir?: string): Promise<void>
  loadSettings(): Promise<void>
  /** Optimistic settings patch via settings:set; refreshes diagnostics. */
  patchSettings(patch: AppSettingsPatch): Promise<void>
  refreshDiagnostics(): Promise<void>
  /**
   * Danger zone: invoke `settings:clearAll` — main wipes ALL persisted
   * state (settings, window state, Notion journal, flags) and responds
   * with fresh defaults. Updates settings, clears notion + notionLog,
   * resets filters, then re-syncs notion/diagnostics/tasks.
   */
  clearAllSettings(): Promise<void>
  refreshNotion(): Promise<void>
  notionConnect(token: string): Promise<void>
  notionDisconnect(): Promise<void>
  notionSetParentPage(url: string): Promise<void>
  notionExport(req: NotionExportRequest): Promise<void>
  notionRetry(taskId: string): Promise<void>
  /** Enumerate target workspaces (settings root override honored by main). */
  listWorkspaces(): Promise<WorkspaceInfo[]>
  /**
   * Run convert-claudeai. Clears convertProgress (re-filled by the
   * evt:convertProgress subscription); resolves with the counts or the
   * structured error (cancel = kind 'aborted'). Never throws.
   */
  runConvertClaudeAi(
    opts: ConvertClaudeAiOptions,
    owner?: MigrateOwner
  ): Promise<MigrateOutcome<ConvertResult>>
  /**
   * Run import-all for `owner`'s flow. Clears importAllProgress; resolves
   * with the counts or the structured error (Claude Desktop running →
   * isDesktopRunningError). Refreshes tasks on a real import. Never throws.
   */
  runImportAll(owner: MigrateOwner, opts: ImportAllOptions): Promise<MigrateOutcome<ImportAllResult>>
  cancelMigrate(): Promise<void>
  /** Read-only probe for the claude.ai DevTools window; null on IPC failure. */
  findClaudeConsole(): Promise<ClaudeConsoleInfo | null>
  /**
   * Type the account-pull script into the claude.ai DevTools console and
   * wait for its download. Progress (elapsed, screenshot) lands in
   * consolePull via evt:claudeConsoleProgress. Never throws.
   */
  runConsolePull(chats: PullChatsMode): Promise<MigrateOutcome<ClaudeConsolePullResult>>
  cancelConsolePull(): Promise<void>
  /** Re-check whether ClaudeLift's claude.ai session is signed in. Never throws. */
  refreshClaudeAiSession(): Promise<void>
  /** Open the "Sign in to claude.ai" window (status updates arrive by event). */
  claudeAiSignIn(): Promise<void>
  /** Remove the claude.ai sign-in stored in ClaudeLift. */
  claudeAiSignOut(): Promise<void>
  /**
   * Pull the account in a hidden claude.ai window of ClaudeLift's session.
   * `[pull]` lines and phases land in claudeAiPull via
   * evt:claudeAiPullProgress. Never throws.
   */
  runClaudeAiPull(chats: PullChatsMode): Promise<MigrateOutcome<ClaudeAiPullResult>>
  cancelClaudeAiPull(): Promise<void>
  pushToast(kind: ToastKind, text: string): void
  dismissToast(id: number): void
  /**
   * Derived: tasks with filters applied — search on title+taskId
   * (case-insensitive), space match on spaceName, archived filter, and
   * sort (recent = lastActivityMs desc, created = createdAtMs desc,
   * title = A→Z). Returns a fresh array; memoize in views if needed.
   */
  visibleTasks(): CoworkTask[]
}

// ---------------------------------------------------------------------------
// Module-level guards / counters
// ---------------------------------------------------------------------------

let appWired = false
let toastSeq = 0

const TOAST_DISMISS_MS = 5000
const BundlesScanResultSchema = z.array(BundleInfoSchema)

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>()((set, get) => ({
  view: 'tasks',
  tasks: [],
  tasksLoading: false,
  tasksError: null,
  filters: {
    search: '',
    space: 'all',
    source: 'cowork',
    sort: 'recent',
    showArchived: false
  },
  selection: new Set<string>(),
  settings: null,
  diagnostics: null,
  watcher: null,
  exportModal: { open: false, tasks: [] },
  exportProgress: {},
  exportRunning: false,
  bundles: [],
  bundlesLoading: false,
  notion: null,
  notionLog: [],
  toasts: [],
  migrateJob: null,
  convertProgress: [],
  importAllProgress: [],
  importAllOwner: null,
  consolePull: null,
  claudeAiSession: null,
  claudeAiSessionChecking: false,
  claudeAiPull: null,

  initApp: async () => {
    if (appWired) return
    appWired = true

    // HMR-safe: drop listeners a previous module instance may have left.
    window.api.offTasksChanged()
    window.api.offExportProgress()
    window.api.offNotionProgress()
    window.api.offWatcherState()
    window.api.offConvertProgress()
    window.api.offImportAllProgress()
    window.api.offClaudeConsoleProgress()
    window.api.offClaudeAiStatus()
    window.api.offClaudeAiPullProgress()

    window.api.onTasksChanged(() => {
      void get().refreshTasks(true)
    })

    window.api.onExportProgress((raw) => {
      const parsed = ProgressEventSchema.safeParse(raw)
      if (!parsed.success) return
      const evt = parsed.data
      const key = 'task_id' in evt ? evt.task_id : EXPORT_BATCH_KEY
      set((s) => ({
        exportProgress: {
          ...s.exportProgress,
          [key]: [...(s.exportProgress[key] ?? []), evt]
        }
      }))
    })

    window.api.onNotionProgress((raw) => {
      const parsed = NotionExportStateSchema.safeParse(raw)
      if (!parsed.success) return
      const entry = parsed.data
      set((s) => {
        const idx = s.notionLog.findIndex((e) => e.taskId === entry.taskId)
        return {
          notionLog:
            idx === -1
              ? [...s.notionLog, entry]
              : s.notionLog.map((e, i) => (i === idx ? entry : e))
        }
      })
    })

    window.api.onWatcherState((raw) => {
      const parsed = WatcherStateSchema.safeParse(raw)
      if (!parsed.success) return
      set({ watcher: parsed.data })
    })

    window.api.onConvertProgress((raw) => {
      const parsed = ConvertProgressEventSchema.safeParse(raw)
      if (!parsed.success) return
      set((s) => ({ convertProgress: [...s.convertProgress, parsed.data] }))
    })

    window.api.onImportAllProgress((raw) => {
      const parsed = ImportAllProgressEventSchema.safeParse(raw)
      if (!parsed.success) return
      set((s) => ({ importAllProgress: [...s.importAllProgress, parsed.data] }))
    })

    window.api.onClaudeConsoleProgress((raw) => {
      const parsed = ClaudeConsoleProgressSchema.safeParse(raw)
      if (!parsed.success) return
      const evt = parsed.data
      set((s) => {
        if (s.consolePull === null || s.consolePull.runId !== evt.runId || !s.consolePull.running) return {}
        return {
          consolePull: {
            ...s.consolePull,
            phase: evt.phase,
            elapsedSec: evt.elapsedSec,
            fileBytes: evt.fileBytes,
            screenshot: evt.screenshot ?? s.consolePull.screenshot
          }
        }
      })
    })

    window.api.onClaudeAiStatus((raw) => {
      const parsed = ClaudeAiSessionStatusSchema.safeParse(raw)
      if (!parsed.success) return
      const prev = get().claudeAiSession
      set({ claudeAiSession: parsed.data })
      if (parsed.data.signedIn && prev?.signedIn !== true) {
        get().pushToast('success', 'Signed in to claude.ai')
      }
    })

    window.api.onClaudeAiPullProgress((raw) => {
      const parsed = ClaudeAiPullProgressSchema.safeParse(raw)
      if (!parsed.success) return
      const evt = parsed.data
      set((s) => {
        const cur = s.claudeAiPull
        if (cur === null || cur.runId !== evt.runId || !cur.running) return {}
        const lines = evt.line === null ? cur.lines : [...cur.lines, evt.line].slice(-PULL_LOG_MAX_LINES)
        return {
          claudeAiPull: { ...cur, phase: evt.phase, elapsedSec: evt.elapsedSec, fileBytes: evt.fileBytes, lines }
        }
      })
    })

    await get().loadSettings()
    await Promise.all([
      get().refreshTasks(),
      get().refreshBundles(),
      get().refreshNotion(),
      get().refreshDiagnostics()
    ])
  },

  setView: (view) => set({ view }),

  refreshTasks: async (silent = false) => {
    if (get().settings === null) await get().loadSettings()
    const settings = get().settings
    if (settings === null) return // loadSettings failed and already toasted
    if (!silent) set({ tasksLoading: true })
    try {
      const req: TasksListRequest = {
        source: settings.source,
        ...(settings.coworkRootOverride !== null
          ? { coworkRoot: settings.coworkRootOverride }
          : {})
      }
      const tasks = TasksListResultSchema.parse(await window.api.tasksList(req))
      set((s) => {
        const ids = new Set(tasks.map((t) => t.taskId))
        const selection = new Set(
          [...s.selection].filter((id) => ids.has(id))
        )
        return { tasks, selection, tasksLoading: false, tasksError: null }
      })
    } catch (err) {
      const msg = errorText(err)
      set({ tasksLoading: false, tasksError: msg })
      if (!silent) get().pushToast('error', `Failed to list tasks: ${msg}`)
    }
  },

  setFilter: (patch) =>
    set((s) => ({ filters: { ...s.filters, ...patch } })),

  toggleSelect: (taskId) =>
    set((s) => {
      const selection = new Set(s.selection)
      if (selection.has(taskId)) selection.delete(taskId)
      else selection.add(taskId)
      return { selection }
    }),

  clearSelection: () => set({ selection: new Set<string>() }),

  selectAll: (ids) => set({ selection: new Set(ids) }),

  openExportModal: (tasks) => set({ exportModal: { open: true, tasks } }),

  closeExportModal: () => set({ exportModal: { open: false, tasks: [] } }),

  runExport: async (opts) => {
    if (get().exportRunning) {
      get().pushToast('info', 'An export is already running')
      return false
    }
    set({ exportRunning: true, exportProgress: {} })
    try {
      const result = ExportResultSchema.parse(
        await window.api.tasksExport(opts)
      )
      set({ exportRunning: false })
      const failed = opts.taskIds.length - result.exported
      get().pushToast(
        failed > 0 ? 'info' : 'success',
        failed > 0
          ? `Export finished — ${result.exported} of ${opts.taskIds.length} exported, ${failed} skipped`
          : `Export complete — ${result.exported} of ${opts.taskIds.length} task${
              opts.taskIds.length === 1 ? '' : 's'
            } exported`
      )
      await get().refreshBundles(opts.outputDir)
      if (opts.purgeSource) await get().refreshTasks(true)
      return result.exported > 0
    } catch (err) {
      set({ exportRunning: false })
      if (parseIpcError(err)?.kind === 'aborted') {
        get().pushToast('info', 'Export cancelled')
      } else {
        get().pushToast('error', `Export failed: ${errorText(err)}`)
      }
      return false
    }
  },

  cancelExport: async () => {
    try {
      await window.api.tasksExportCancel()
    } catch (err) {
      get().pushToast('error', `Cancel failed: ${errorText(err)}`)
    }
  },

  refreshBundles: async (_outputDir) => {
    set({ bundlesLoading: true })
    try {
      const bundles = BundlesScanResultSchema.parse(
        await window.api.bundlesScan()
      )
      set({ bundles, bundlesLoading: false })
    } catch (err) {
      set({ bundlesLoading: false })
      get().pushToast('error', `Failed to scan bundles: ${errorText(err)}`)
    }
  },

  loadSettings: async () => {
    try {
      const settings = AppSettingsSchema.parse(await window.api.settingsGet())
      set((s) => ({
        settings,
        filters: { ...s.filters, source: settings.source }
      }))
    } catch (err) {
      get().pushToast('error', `Failed to load settings: ${errorText(err)}`)
    }
  },

  patchSettings: async (patch) => {
    const prev = get().settings
    if (prev !== null) set({ settings: { ...prev, ...patch } }) // optimistic
    try {
      const settings = AppSettingsSchema.parse(
        await window.api.settingsSet(patch)
      )
      set((s) => ({
        settings,
        filters:
          patch.source !== undefined
            ? { ...s.filters, source: settings.source }
            : s.filters
      }))
      await get().refreshDiagnostics()
    } catch (err) {
      if (prev !== null) set({ settings: prev }) // roll back
      get().pushToast('error', `Failed to save settings: ${errorText(err)}`)
    }
  },

  refreshDiagnostics: async () => {
    try {
      const diagnostics = DiagnosticsSchema.parse(
        await window.api.appDiagnostics()
      )
      set({ diagnostics })
    } catch (err) {
      get().pushToast('error', `Diagnostics unavailable: ${errorText(err)}`)
    }
  },

  clearAllSettings: async () => {
    // The preload wires `settingsClearAll` in the wave that implements the
    // main handler — tolerate (and surface) an older bridge at runtime.
    const api = window.api as typeof window.api & {
      settingsClearAll?: () => Promise<AppSettings>
    }
    if (typeof api.settingsClearAll !== 'function') {
      get().pushToast('error', 'Clear all settings is unavailable in this build')
      return
    }
    try {
      const settings = AppSettingsSchema.parse(await api.settingsClearAll())
      set({
        settings,
        notion: null,
        notionLog: [],
        filters: {
          search: '',
          space: 'all',
          source: settings.source,
          sort: 'recent',
          showArchived: false
        }
      })
      get().pushToast('success', 'All settings cleared — defaults restored')
      await Promise.all([
        get().refreshNotion(),
        get().refreshDiagnostics(),
        get().refreshTasks(true)
      ])
    } catch (err) {
      get().pushToast('error', `Clear all settings failed: ${errorText(err)}`)
    }
  },

  refreshNotion: async () => {
    try {
      const notion = NotionStatusSchema.parse(await window.api.notionStatus())
      // Seed the export log from the persisted journal so it (and Retry)
      // survives app restarts. Entries updated live via evt:notionProgress
      // win over the snapshot; journal-only entries are appended.
      set((s) => {
        const merged = new Map(notion.journal.map((e) => [e.taskId, e]))
        for (const entry of s.notionLog) merged.set(entry.taskId, entry)
        return { notion, notionLog: [...merged.values()] }
      })
    } catch (err) {
      get().pushToast('error', `Notion status failed: ${errorText(err)}`)
    }
  },

  notionConnect: async (token) => {
    try {
      const notion = NotionStatusSchema.parse(
        await window.api.notionConnect({ token })
      )
      set({ notion })
      const name = notion.config.workspaceName
      get().pushToast(
        'success',
        name !== null ? `Connected to Notion: ${name}` : 'Connected to Notion'
      )
    } catch (err) {
      get().pushToast('error', `Notion connect failed: ${errorText(err)}`)
    }
  },

  notionDisconnect: async () => {
    try {
      await window.api.notionDisconnect()
      await get().refreshNotion()
      get().pushToast('info', 'Disconnected from Notion')
    } catch (err) {
      get().pushToast('error', `Notion disconnect failed: ${errorText(err)}`)
    }
  },

  notionSetParentPage: async (url) => {
    try {
      const notion = NotionStatusSchema.parse(
        await window.api.notionSetParentPage({ url })
      )
      set({ notion })
      get().pushToast('success', 'Notion parent page saved')
    } catch (err) {
      get().pushToast('error', errorText(err))
    }
  },

  notionExport: async (req) => {
    try {
      await window.api.notionExport(req)
    } catch (err) {
      get().pushToast('error', `Notion export failed: ${errorText(err)}`)
    }
  },

  notionRetry: async (taskId) => {
    try {
      await window.api.notionRetry({ taskId })
    } catch (err) {
      get().pushToast('error', `Notion retry failed: ${errorText(err)}`)
    }
  },

  listWorkspaces: async () => {
    try {
      return ListWorkspacesResultSchema.parse(
        await window.api.migrateListWorkspaces({})
      )
    } catch (err) {
      get().pushToast('error', `Failed to list workspaces: ${errorText(err)}`)
      return []
    }
  },

  runConvertClaudeAi: async (opts, owner = 'claudeai') => {
    if (get().migrateJob !== null) {
      return { ok: false, error: { kind: 'validation', message: 'Another migration step is already running' } }
    }
    set({ migrateJob: { kind: 'convert', owner }, convertProgress: [] })
    try {
      const result = ConvertResultSchema.parse(
        await window.api.migrateConvertClaudeAi(opts)
      )
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: parseIpcError(err) ?? { kind: 'crash', message: errorText(err) }
      }
    } finally {
      set({ migrateJob: null })
    }
  },

  runImportAll: async (owner, opts) => {
    if (get().migrateJob !== null) {
      return { ok: false, error: { kind: 'validation', message: 'Another migration step is already running' } }
    }
    set({
      migrateJob: { kind: 'importAll', owner },
      importAllProgress: [],
      importAllOwner: owner
    })
    try {
      const result = ImportAllResultSchema.parse(
        await window.api.migrateImportAll(opts)
      )
      if (!result.dryRun) void get().refreshTasks(true)
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: parseIpcError(err) ?? { kind: 'crash', message: errorText(err) }
      }
    } finally {
      set({ migrateJob: null })
    }
  },

  cancelMigrate: async () => {
    try {
      await window.api.migrateCancel()
    } catch (err) {
      get().pushToast('error', `Cancel failed: ${errorText(err)}`)
    }
  },

  findClaudeConsole: async () => {
    try {
      return ClaudeConsoleInfoSchema.parse(await window.api.claudeConsoleFind())
    } catch {
      return null
    }
  },

  runConsolePull: async (chats) => {
    if (get().consolePull?.running === true || get().claudeAiPull?.running === true) {
      return { ok: false, error: { kind: 'validation', message: 'A pull is already running' } }
    }
    const runId = newPullRunId()
    set({
      consolePull: { runId, running: true, phase: 'typing', elapsedSec: 0, screenshot: null, fileBytes: null }
    })
    try {
      const result = ClaudeConsolePullResultSchema.parse(
        await window.api.claudeConsoleRunPull({ runId, chats })
      )
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: parseIpcError(err) ?? { kind: 'crash', message: errorText(err) }
      }
    } finally {
      set((s) => (s.consolePull?.runId === runId ? { consolePull: { ...s.consolePull, running: false } } : {}))
    }
  },

  cancelConsolePull: async () => {
    try {
      await window.api.claudeConsoleCancel()
    } catch (err) {
      get().pushToast('error', `Cancel failed: ${errorText(err)}`)
    }
  },

  refreshClaudeAiSession: async () => {
    set({ claudeAiSessionChecking: true })
    try {
      set({ claudeAiSession: ClaudeAiSessionStatusSchema.parse(await window.api.claudeAiStatus()) })
    } catch (err) {
      get().pushToast('error', `claude.ai sign-in check failed: ${errorText(err)}`)
    } finally {
      set({ claudeAiSessionChecking: false })
    }
  },

  claudeAiSignIn: async () => {
    try {
      set({ claudeAiSession: ClaudeAiSessionStatusSchema.parse(await window.api.claudeAiSignIn()) })
    } catch (err) {
      get().pushToast('error', `Could not open the sign-in window: ${errorText(err)}`)
    }
  },

  claudeAiSignOut: async () => {
    try {
      set({ claudeAiSession: ClaudeAiSessionStatusSchema.parse(await window.api.claudeAiSignOut()) })
      get().pushToast('info', 'Signed out of claude.ai in ClaudeLift')
    } catch (err) {
      get().pushToast('error', `Sign out failed: ${errorText(err)}`)
    }
  },

  runClaudeAiPull: async (chats) => {
    if (get().claudeAiPull?.running === true || get().consolePull?.running === true) {
      return { ok: false, error: { kind: 'validation', message: 'A pull is already running' } }
    }
    const runId = newPullRunId()
    set({
      claudeAiPull: { runId, running: true, phase: 'checking', elapsedSec: 0, fileBytes: null, lines: [] }
    })
    try {
      const result = ClaudeAiPullResultSchema.parse(await window.api.claudeAiRunPull({ runId, chats }))
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: parseIpcError(err) ?? { kind: 'crash', message: errorText(err) }
      }
    } finally {
      set((s) => (s.claudeAiPull?.runId === runId ? { claudeAiPull: { ...s.claudeAiPull, running: false } } : {}))
    }
  },

  cancelClaudeAiPull: async () => {
    try {
      await window.api.claudeAiCancel()
    } catch (err) {
      get().pushToast('error', `Cancel failed: ${errorText(err)}`)
    }
  },

  pushToast: (kind, text) => {
    toastSeq += 1
    const id = toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => {
      get().dismissToast(id)
    }, TOAST_DISMISS_MS)
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  visibleTasks: () => {
    const { tasks, filters } = get()
    const query = filters.search.trim().toLowerCase()
    const out = tasks.filter((t) => {
      if (!filters.showArchived && t.archived) return false
      if (filters.space !== 'all' && t.spaceName !== filters.space) return false
      if (
        query !== '' &&
        !t.title.toLowerCase().includes(query) &&
        !t.taskId.toLowerCase().includes(query)
      ) {
        return false
      }
      return true
    })
    switch (filters.sort) {
      case 'recent':
        out.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
        break
      case 'created':
        out.sort((a, b) => b.createdAtMs - a.createdAtMs)
        break
      case 'title':
        out.sort((a, b) => a.title.localeCompare(b.title))
        break
    }
    return out
  }
}))
