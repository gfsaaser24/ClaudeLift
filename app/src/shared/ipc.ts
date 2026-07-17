/**
 * Shared IPC contract for ClaudeLift.
 *
 * Single source of truth for every payload that crosses the
 * renderer ⇄ main boundary: zod schemas, inferred TS types, and
 * channel-name constants. All later tasks (EngineService, state,
 * watcher, Notion, renderer store/views) consume these names.
 *
 * Rule from the plan: zod-validate every payload crossing IPC or
 * process boundaries. Main-process handlers parse requests with the
 * request schemas; the renderer-side wrapper parses responses with
 * the response schemas exported here.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Engine `list --json` raw shape (snake_case, binding per Task 1)
// ---------------------------------------------------------------------------

export const EngineTaskSchema = z.object({
  task_id: z.string(),
  source: z.enum(['cowork', 'code']),
  title: z.string(),
  model: z.string(),
  space_name: z.string(),
  cwd: z.string(),
  created_at_ms: z.number().int(),
  last_activity_ms: z.number().int(),
  archived: z.boolean(),
  error: z.string(),
  has_transcript: z.boolean(),
  transcript_path: z.string().nullable(),
  task_dir: z.string().nullable(),
  task_meta_file: z.string().nullable()
})

export type EngineTask = z.infer<typeof EngineTaskSchema>

// ---------------------------------------------------------------------------
// CoworkTask (camelCase mirror of the engine shape)
// ---------------------------------------------------------------------------

export const CoworkTaskSchema = z.object({
  taskId: z.string(),
  source: z.enum(['cowork', 'code']),
  title: z.string(),
  model: z.string(),
  spaceName: z.string(),
  cwd: z.string(),
  createdAtMs: z.number().int(),
  lastActivityMs: z.number().int(),
  archived: z.boolean(),
  error: z.string(),
  hasTranscript: z.boolean(),
  transcriptPath: z.string().nullable(),
  taskDir: z.string().nullable(),
  taskMetaFile: z.string().nullable()
})

export type CoworkTask = z.infer<typeof CoworkTaskSchema>

/**
 * snake_case → camelCase mapper for one element of the engine's
 * `list --json` output. Validates the raw engine shape with zod
 * before mapping; throws ZodError on contract drift.
 */
export function taskFromEngine(raw: unknown): CoworkTask {
  const t = EngineTaskSchema.parse(raw)
  return {
    taskId: t.task_id,
    source: t.source,
    title: t.title,
    model: t.model,
    spaceName: t.space_name,
    cwd: t.cwd,
    createdAtMs: t.created_at_ms,
    lastActivityMs: t.last_activity_ms,
    archived: t.archived,
    error: t.error,
    hasTranscript: t.has_transcript,
    transcriptPath: t.transcript_path,
    taskDir: t.task_dir,
    taskMetaFile: t.task_meta_file
  }
}

// ---------------------------------------------------------------------------
// Export options + NDJSON progress events (Task-1 union, engine snake_case)
// ---------------------------------------------------------------------------

export const ExportFormatSchema = z.enum(['html', 'md', 'json', 'csv'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

export const TaskSourceSchema = z.enum(['cowork', 'code', 'both'])
export type TaskSource = z.infer<typeof TaskSourceSchema>

export const ExportOptionsSchema = z.object({
  taskIds: z.array(z.string()),
  outputDir: z.string(),
  formats: z.array(ExportFormatSchema),
  noFiles: z.boolean(),
  includeAuth: z.boolean(),
  purgeSource: z.boolean(),
  source: TaskSourceSchema,
  coworkRoot: z.string().optional()
})

export type ExportOptions = z.infer<typeof ExportOptionsSchema>

export const ProgressEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('task_start'),
    task_id: z.string(),
    index: z.number().int(),
    total: z.number().int()
  }),
  z.object({
    event: z.literal('task_done'),
    task_id: z.string(),
    target: z.string()
  }),
  z.object({
    event: z.literal('task_skipped'),
    task_id: z.string(),
    reason: z.string()
  }),
  z.object({
    event: z.literal('purged'),
    task_id: z.string(),
    path: z.string()
  }),
  z.object({
    event: z.literal('done'),
    exported: z.number().int(),
    total: z.number().int()
  })
])

export type ProgressEvent = z.infer<typeof ProgressEventSchema>

export const ExportResultSchema = z.object({
  exported: z.number().int()
})

export type ExportResult = z.infer<typeof ExportResultSchema>

// ---------------------------------------------------------------------------
// Import / seed
// ---------------------------------------------------------------------------

export const ImportOptionsSchema = z.object({
  bundleDir: z.string(),
  workspace: z.string().optional(),
  remaps: z.array(z.object({ src: z.string(), dst: z.string() })),
  keepTaskId: z.boolean(),
  skipAuth: z.boolean(),
  force: z.boolean(),
  dryRun: z.boolean(),
  /** Optional `--cowork-root` override, mirroring list/export. */
  coworkRoot: z.string().optional()
})

export type ImportOptions = z.infer<typeof ImportOptionsSchema>

export const ImportResultSchema = z.object({
  newTaskId: z.string().nullable(),
  stdout: z.string()
})

export type ImportResult = z.infer<typeof ImportResultSchema>

export const SeedOptionsSchema = z.object({
  bundleDir: z.string(),
  mode: z.enum(['brief', 'standard', 'full']),
  outputPath: z.string().optional()
})

export type SeedOptions = z.infer<typeof SeedOptionsSchema>

export const SeedResultSchema = z.object({
  outputPath: z.string(),
  chars: z.number().int()
})

export type SeedResult = z.infer<typeof SeedResultSchema>

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export const BundleInfoSchema = z.object({
  dir: z.string(),
  taskId: z.string(),
  title: z.string(),
  exportedAt: z.string(),
  sourcePlatform: z.string(),
  sizeBytes: z.number(),
  formats: z.array(z.string()),
  hasSeed: z.boolean(),
  hasAuth: z.boolean(),
  /**
   * manifest `source_user_folders` — the ImportModal's remap editor needs
   * one row per entry. Additive with a default so payloads from older
   * scanners still parse.
   */
  userFolders: z.array(z.string()).default([])
})

export type BundleInfo = z.infer<typeof BundleInfoSchema>

export const ReadMarkdownRequestSchema = z.object({
  bundleDir: z.string()
})

export type ReadMarkdownRequest = z.infer<typeof ReadMarkdownRequestSchema>

/** `bundles:readMarkdown` response — session.md capped at 2 MB. */
export const ReadMarkdownResultSchema = z.object({
  text: z.string(),
  truncated: z.boolean()
})

export type ReadMarkdownResult = z.infer<typeof ReadMarkdownResultSchema>

export const OpenFolderRequestSchema = z.object({
  dir: z.string()
})

export type OpenFolderRequest = z.infer<typeof OpenFolderRequestSchema>

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const AppSettingsSchema = z.object({
  minimizeToTray: z.boolean(),
  closeToTray: z.boolean(),
  startMinimized: z.boolean(),
  watcherEnabled: z.boolean(),
  outputDir: z.string(),
  formats: z.array(z.string()),
  source: TaskSourceSchema,
  coworkRootOverride: z.string().nullable(),
  bundleViewMode: z.enum(['card', 'list']).default('card')
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPatchSchema = AppSettingsSchema.partial()

export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>

/**
 * `settings:clearAll` response — the fresh default settings after ALL
 * persisted state (settings, Notion journal, etc.) has been wiped.
 */
export type SettingsClearAllResult = AppSettings

// ---------------------------------------------------------------------------
// Tasks list request
// ---------------------------------------------------------------------------

export const TasksListRequestSchema = z.object({
  source: TaskSourceSchema,
  coworkRoot: z.string().optional()
})

export type TasksListRequest = z.infer<typeof TasksListRequestSchema>

export const TasksListResultSchema = z.array(CoworkTaskSchema)

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionConfigSchema = z.object({
  parentPageId: z.string().nullable(),
  databaseId: z.string().nullable(),
  dataSourceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  maxUploadBytes: z.number().nullable()
})

export type NotionConfig = z.infer<typeof NotionConfigSchema>

export const NotionExportStateSchema = z.object({
  taskId: z.string(),
  status: z.enum([
    'queued',
    'zipping',
    'uploading',
    'creating',
    'appending',
    'done',
    'error'
  ]),
  message: z.string(),
  pageUrl: z.string().nullable()
})

export type NotionExportState = z.infer<typeof NotionExportStateSchema>

export const NotionConnectRequestSchema = z.object({
  token: z.string()
})

export type NotionConnectRequest = z.infer<typeof NotionConnectRequestSchema>

export const NotionSetParentPageRequestSchema = z.object({
  url: z.string()
})

export type NotionSetParentPageRequest = z.infer<
  typeof NotionSetParentPageRequestSchema
>

/** `notion:export {taskId|bundleDir}` — at least one selector required. */
export const NotionExportRequestSchema = z
  .object({
    taskId: z.string().optional(),
    bundleDir: z.string().optional()
  })
  .refine((req) => req.taskId !== undefined || req.bundleDir !== undefined, {
    message: 'notion:export requires taskId or bundleDir'
  })

export type NotionExportRequest = z.infer<typeof NotionExportRequestSchema>

export const NotionRetryRequestSchema = z.object({
  taskId: z.string()
})

export type NotionRetryRequest = z.infer<typeof NotionRetryRequestSchema>

/** `notion:status` / `notion:connect` / `notion:setParentPage` response. */
export const NotionStatusSchema = z.object({
  connected: z.boolean(),
  config: NotionConfigSchema,
  /**
   * Hydrated Notion export journal — the per-task last-known export states
   * persisted by main. Defaults to [] so payloads from a producer that has
   * not hydrated it yet still parse; renderer code that parses responses
   * through this schema always sees an array.
   */
  journal: z.array(NotionExportStateSchema).default([])
})

/**
 * Input type on purpose: producers (main) may omit `journal` until they
 * hydrate it, while schema-parsed responses always carry it (default []).
 */
export type NotionStatus = z.input<typeof NotionStatusSchema>

// ---------------------------------------------------------------------------
// App-level: folder picker, diagnostics, watcher state
// ---------------------------------------------------------------------------

export const PickFolderRequestSchema = z.object({
  purpose: z.string()
})

export type PickFolderRequest = z.infer<typeof PickFolderRequestSchema>

/** `app:pickFolder` response — chosen directory, or null when cancelled. */
export const PickFolderResultSchema = z.string().nullable()

export const WatcherStateSchema = z.object({
  active: z.boolean(),
  roots: z.array(z.string())
})

export type WatcherState = z.infer<typeof WatcherStateSchema>

export const DiagnosticsSchema = z.object({
  appVersion: z.string(),
  engineVersion: z.string(),
  scannedRoots: z.array(z.string()),
  watcher: WatcherStateSchema
})

export type Diagnostics = z.infer<typeof DiagnosticsSchema>

// ---------------------------------------------------------------------------
// MCP server (bundled local Model Context Protocol server)
// ---------------------------------------------------------------------------

/**
 * `mcp:info` response — everything the Settings card needs to render the
 * config block, install button, and current-state badge without a second
 * round-trip.
 *
 * - `command` / `serverPath`: the canonical launch pair (the app's own
 *   binary run as node via ELECTRON_RUN_AS_NODE, and the bundled server.cjs).
 * - `configJson`: pretty-printed `{ mcpServers: { claudelift: … } }`, ready
 *   to copy into any MCP client config.
 * - `claudeDesktopConfigPath`: resolved claude_desktop_config.json path, or
 *   null when Claude Desktop is not installed.
 * - `installedInClaudeDesktop`: that config parses and already has
 *   `mcpServers.claudelift`.
 * - `serverExists`: server.cjs is present on disk (false in dev before
 *   `npm run build:mcp` has run).
 */
export const McpInfoSchema = z.object({
  command: z.string(),
  serverPath: z.string(),
  configJson: z.string(),
  claudeDesktopConfigPath: z.string().nullable(),
  installedInClaudeDesktop: z.boolean(),
  serverExists: z.boolean()
})

export type McpInfo = z.infer<typeof McpInfoSchema>

/**
 * `mcp:installToClaudeDesktop` response — a typed result the renderer
 * toasts directly. `ok:true` carries the config path that was written;
 * `ok:false` carries a human-readable reason (e.g. Claude Desktop missing).
 */
export const McpInstallResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() })
])

export type McpInstallResult = z.infer<typeof McpInstallResultSchema>

/** `mcp:revealServer` response — true when the file existed and was revealed. */
export const McpRevealResultSchema = z.boolean()

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

/** Renderer → main request/response channels (`ipcRenderer.invoke`). */
export const INVOKE_CHANNELS = {
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
  /** Wipes ALL persisted state; responds with fresh defaults (AppSettings). */
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
} as const

/** Contract map for the preload's channel-literal duplication (`satisfies`). */
export type InvokeChannelMap = typeof INVOKE_CHANNELS
export type InvokeChannel = (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS]

/** Main → renderer push channels (`webContents.send`). */
export const EVENT_CHANNELS = {
  tasksChanged: 'evt:tasksChanged',
  exportProgress: 'evt:exportProgress',
  notionProgress: 'evt:notionProgress',
  watcherState: 'evt:watcherState'
} as const

export type EventChannelMap = typeof EVENT_CHANNELS
export type EventChannel = EventChannelMap[keyof EventChannelMap]

// ---------------------------------------------------------------------------
// window.api surface (implemented by the preload, consumed by the renderer)
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void

/**
 * The typed bridge the preload exposes as `window.api`.
 *
 * `on*` subscribes and returns an unsubscribe function — prefer it over
 * `off*(cb)`: functions crossing the contextBridge may not keep reference
 * identity, so the returned closure is the reliable way to detach a single
 * listener. `off*()` with no argument removes ALL listeners for that event
 * channel (useful for HMR-safe re-registration).
 */
export interface CoworkExporterApi {
  tasksList(req: TasksListRequest): Promise<CoworkTask[]>
  tasksExport(opts: ExportOptions): Promise<ExportResult>
  tasksExportCancel(): Promise<void>
  bundlesScan(): Promise<BundleInfo[]>
  bundlesImport(opts: ImportOptions): Promise<ImportResult>
  bundlesSeed(opts: SeedOptions): Promise<SeedResult>
  bundlesReadMarkdown(req: ReadMarkdownRequest): Promise<ReadMarkdownResult>
  bundlesOpenFolder(req: OpenFolderRequest): Promise<void>
  settingsGet(): Promise<AppSettings>
  settingsSet(patch: AppSettingsPatch): Promise<AppSettings>
  settingsClearAll(): Promise<AppSettings>
  notionConnect(req: NotionConnectRequest): Promise<NotionStatus>
  notionDisconnect(): Promise<void>
  notionStatus(): Promise<NotionStatus>
  notionSetParentPage(req: NotionSetParentPageRequest): Promise<NotionStatus>
  notionExport(req: NotionExportRequest): Promise<void>
  notionRetry(req: NotionRetryRequest): Promise<void>
  appPickFolder(req: PickFolderRequest): Promise<string | null>
  appDiagnostics(): Promise<Diagnostics>
  mcpInfo(): Promise<McpInfo>
  mcpInstallToClaudeDesktop(): Promise<McpInstallResult>
  mcpRevealServer(): Promise<boolean>

  onTasksChanged(cb: () => void): Unsubscribe
  offTasksChanged(cb?: () => void): void
  onExportProgress(cb: (event: ProgressEvent) => void): Unsubscribe
  offExportProgress(cb?: (event: ProgressEvent) => void): void
  onNotionProgress(cb: (state: NotionExportState) => void): Unsubscribe
  offNotionProgress(cb?: (state: NotionExportState) => void): void
  onWatcherState(cb: (state: WatcherState) => void): Unsubscribe
  offWatcherState(cb?: (state: WatcherState) => void): void
}

// ---------------------------------------------------------------------------
// Engine sidecar version (pinned)
// ---------------------------------------------------------------------------

/**
 * Version of the bundled cowork-export sidecar (TOOL_VERSION in
 * cowork_export.py). `app:diagnostics` reports this constant instead of
 * spawning the engine for a live probe; bump alongside engine rebuilds.
 */
export const ENGINE_VERSION = '0.5.0-desktop'
