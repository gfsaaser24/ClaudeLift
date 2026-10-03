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
  /** Additive in engine 0.6 — defaults so an older sidecar still parses. */
  space_id: z.string().default(''),
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
  spaceId: z.string(),
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
    spaceId: t.space_id,
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

/**
 * `--space` value: 'auto' | 'none' | a space id. The id charset is strict
 * (no leading '-') so a value can never be parsed by argparse as a flag.
 */
export const SpaceChoiceSchema = z.union([
  z.enum(['auto', 'none']),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'not a valid space id')
])

export type SpaceChoice = z.infer<typeof SpaceChoiceSchema>

/**
 * Substring of the engine's exit-3 stderr when import / import-all /
 * import-space refuses to write because Claude Desktop is running. The
 * renderer keys its "quit Claude Desktop" guidance on it.
 */
export const DESKTOP_RUNNING_MARKER = 'Claude Desktop is running'

export const ImportOptionsSchema = z.object({
  bundleDir: z.string(),
  workspace: z.string().optional(),
  remaps: z.array(z.object({ src: z.string(), dst: z.string() })),
  keepTaskId: z.boolean(),
  skipAuth: z.boolean(),
  force: z.boolean(),
  dryRun: z.boolean(),
  /** Optional `--cowork-root` override, mirroring list/export. */
  coworkRoot: z.string().optional(),
  /**
   * `--space`: 'auto' (engine default — recreate the bundle's space by name
   * on the target account), 'none', or an existing target space id.
   */
  space: SpaceChoiceSchema.optional(),
  /** `--allow-running`: import even though Claude Desktop is running. */
  allowRunning: z.boolean().optional()
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
// Migrate: claude.ai export conversion, bulk import, space import, workspaces
// ---------------------------------------------------------------------------

/** `convert-claudeai --what` parts. */
export const ClaudeAiPartSchema = z.enum([
  'conversations',
  'projects',
  'memory',
  'design',
  'artifacts',
  /** Profile, memory, skills list, styles — from a DevTools account pull (`--pull`). */
  'account'
])
export type ClaudeAiPart = z.infer<typeof ClaudeAiPartSchema>

export const ConvertClaudeAiOptionsSchema = z.object({
  /** The claude.ai "Export data" folder (zips or extracted) or a single zip. */
  exportDir: z.string().min(1).optional(),
  /** `-o`: where bundles are written (conversations/, projects/, memory/). */
  outputDir: z.string().min(1),
  what: z.array(ClaudeAiPartSchema).min(1),
  /** `--formats` rendered per chat (engine default md; [] for none). */
  formats: z.array(ExportFormatSchema),
  /** `--since`: only chats updated on/after this ISO date (YYYY-MM-DD…). */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'since must be an ISO date (YYYY-MM-DD)')
    .optional(),
  /** `--match`: only chats whose title contains this text. */
  match: z.string().min(1).optional(),
  /** `--limit`: at most N chats (newest first). */
  limit: z.number().int().positive().optional(),
  /**
   * `--pull PATH` (repeatable): DevTools account-pull JSON files
   * (`claudelift-pull-<runId>.json`) merged into the conversion.
   */
  pull: z.array(z.string().min(1)).optional()
})

export type ConvertClaudeAiOptions = z.infer<typeof ConvertClaudeAiOptionsSchema>

/** NDJSON events from `convert-claudeai --progress-json`. */
export const ConvertProgressEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('project_done'),
    uuid: z.string(),
    name: z.string().nullish()
  }),
  z.object({
    event: z.literal('conversation_done'),
    index: z.number().int(),
    total: z.number().int(),
    uuid: z.string(),
    name: z.string().nullish()
  }),
  // Loose: newer engines add counters (e.g. for the `account` part); the
  // known ones are typed, any extra numeric ones surface as `extra`.
  z.looseObject({
    event: z.literal('done'),
    output: z.string(),
    conversations: z.number().int(),
    projects: z.number().int(),
    memory_files: z.number().int(),
    design_chats: z.number().int(),
    artifact_files: z.number().int()
  })
])

export type ConvertProgressEvent = z.infer<typeof ConvertProgressEventSchema>

/** Engine `done` keys that ConvertResult maps to named fields. */
const CONVERT_DONE_KNOWN_KEYS = new Set([
  'event',
  'output',
  'conversations',
  'projects',
  'memory_files',
  'design_chats',
  'artifact_files'
])

/** Extra numeric counters on a convert `done` event (keys as the engine sends them). */
export function convertDoneExtras(done: Record<string, unknown>): Record<string, number> {
  const extra: Record<string, number> = {}
  for (const [key, value] of Object.entries(done)) {
    if (CONVERT_DONE_KNOWN_KEYS.has(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) extra[key] = value
  }
  return extra
}

export const ConvertResultSchema = z.object({
  output: z.string(),
  conversations: z.number().int(),
  projects: z.number().int(),
  memoryFiles: z.number().int(),
  designChats: z.number().int(),
  artifactFiles: z.number().int(),
  /** Any additional numeric counters from the engine's `done` event. */
  extra: z.record(z.string(), z.number()).default({})
})

export type ConvertResult = z.infer<typeof ConvertResultSchema>

export const ImportAllOptionsSchema = z.object({
  /** Folder of bundles: an `export` output dir or a `convert-claudeai` output dir. */
  folder: z.string().min(1),
  /** `--workspace`: destination `<root>/<account>/<org>` dir. */
  workspace: z.string().optional(),
  coworkRoot: z.string().optional(),
  /** `--docs-root`: where project knowledge docs go (engine default ~/Claude/Projects). */
  docsRoot: z.string().optional(),
  dryRun: z.boolean(),
  allowRunning: z.boolean(),
  projectsOnly: z.boolean().optional(),
  tasksOnly: z.boolean().optional(),
  remaps: z.array(z.object({ src: z.string(), dst: z.string() })).optional()
})

export type ImportAllOptions = z.infer<typeof ImportAllOptionsSchema>

/** NDJSON events from `import-all --progress-json`. */
export const ImportAllProgressEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('space'),
    name: z.string().nullish(),
    space_id: z.string(),
    detail: z.string()
  }),
  z.object({
    event: z.literal('account_memory'),
    name: z.string().nullish(),
    detail: z.string().nullish()
  }),
  z.object({
    event: z.literal('task'),
    index: z.number().int(),
    total: z.number().int(),
    bundle: z.string(),
    detail: z.string()
  }),
  z.object({
    event: z.literal('task_failed'),
    index: z.number().int(),
    total: z.number().int(),
    bundle: z.string(),
    detail: z.string()
  }),
  z.object({
    event: z.literal('done'),
    spaces: z.number().int(),
    tasks_imported: z.number().int(),
    tasks_failed: z.number().int(),
    dry_run: z.boolean(),
    workspace: z.string()
  })
])

export type ImportAllProgressEvent = z.infer<typeof ImportAllProgressEventSchema>

export const ImportAllResultSchema = z.object({
  spaces: z.number().int(),
  tasksImported: z.number().int(),
  tasksFailed: z.number().int(),
  dryRun: z.boolean(),
  workspace: z.string()
})

export type ImportAllResult = z.infer<typeof ImportAllResultSchema>

export const ImportSpaceOptionsSchema = z.object({
  /** Folder with space.json (+ memory/, docs/). */
  spaceBundleDir: z.string().min(1),
  workspace: z.string().optional(),
  coworkRoot: z.string().optional(),
  docsRoot: z.string().optional(),
  dryRun: z.boolean(),
  allowRunning: z.boolean()
})

export type ImportSpaceOptions = z.infer<typeof ImportSpaceOptionsSchema>

export const ImportSpaceResultSchema = z.object({
  spaceId: z.string(),
  created: z.boolean(),
  name: z.string().nullable(),
  /** Engine log lines (the plan on a dry run). */
  stdout: z.string()
})

export type ImportSpaceResult = z.infer<typeof ImportSpaceResultSchema>

/** `migrate:listWorkspaces` request — optional root override. */
export const ListWorkspacesRequestSchema = z.object({
  coworkRoot: z.string().optional()
})

export type ListWorkspacesRequest = z.infer<typeof ListWorkspacesRequestSchema>

/**
 * One Cowork workspace dir on this machine: `<root>/<account>/<org>`.
 * `email` / `accountName` come from the first `local_*.json` task in it
 * that records them (null when the workspace has no task yet).
 */
export const WorkspaceInfoSchema = z.object({
  path: z.string(),
  root: z.string(),
  accountId: z.string(),
  orgId: z.string(),
  email: z.string().nullable(),
  accountName: z.string().nullable(),
  taskCount: z.number().int(),
  /** Newest task metadata mtime (ms epoch); the folder's mtime when there are no tasks. */
  lastActivityMs: z.number(),
  /** The account Claude Desktop is signed in to now (config.json lastKnownAccountUuid). */
  signedInNow: z.boolean().default(false),
  /** Org folder that is not one of the account's orgs (left over from switching accounts). */
  leftover: z.boolean().default(false),
  /**
   * New-layout account (projects and threads live in the cloud): no
   * spaces.json, no tasks, only remote-session-spaces.json. Importing
   * tasks/spaces here creates no projects — use the push (card D).
   */
  newLayout: z.boolean().default(false)
})

export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>

export const ListWorkspacesResultSchema = z.array(WorkspaceInfoSchema)

// ---------------------------------------------------------------------------
// Claude Desktop DevTools console bridge (Windows only)
// ---------------------------------------------------------------------------

/** Window rect in physical screen pixels. */
export const WindowRectSchema = z.object({
  left: z.number().int(),
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int()
})

export type WindowRect = z.infer<typeof WindowRectSchema>

/**
 * `claudeConsole:find` response. `supported` is false off Windows (the
 * bridge drives Win32 windows); `found` means a visible window titled
 * "Developer Tools - https://claude.ai…" exists.
 */
export const ClaudeConsoleInfoSchema = z.object({
  supported: z.boolean(),
  found: z.boolean(),
  title: z.string().nullable(),
  rect: WindowRectSchema.nullable(),
  minimized: z.boolean(),
  /** Only Claude Desktop's shell DevTools (file:///…app.asar) is open — the wrong one. */
  shellOnly: z.boolean().default(false)
})

export type ClaudeConsoleInfo = z.infer<typeof ClaudeConsoleInfoSchema>

/** `claudeConsole:screenshot` response — base64 PNG, null when no window / minimized. */
export const ClaudeConsoleScreenshotSchema = z.object({
  png: z.string().nullable()
})

export type ClaudeConsoleScreenshot = z.infer<typeof ClaudeConsoleScreenshotSchema>

export const PullChatsModeSchema = z.enum(['list', 'full', 'none'])
export type PullChatsMode = z.infer<typeof PullChatsModeSchema>

/** Run ids land in a file name and in pasted JS — keep the charset tight. */
export const PullRunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, 'not a valid run id')

export const ClaudeConsolePullRequestSchema = z.object({
  runId: PullRunIdSchema,
  chats: PullChatsModeSchema,
  /**
   * console (default) = type into the claude.ai DevTools window;
   * debugger = run the script in Claude Desktop's claude.ai page through its
   * Main Process Debugger (for DevTools windows with no or a blank title).
   */
  via: z.enum(['console', 'debugger']).optional()
})

export type ClaudeConsolePullRequest = z.infer<typeof ClaudeConsolePullRequestSchema>

export const ClaudeConsolePullResultSchema = z.object({
  /** Absolute path of `claudelift-pull-<runId>.json`. */
  file: z.string(),
  sizeBytes: z.number().int(),
  /** The folder the file was found in (the user's Downloads folder). */
  downloadsDir: z.string()
})

export type ClaudeConsolePullResult = z.infer<typeof ClaudeConsolePullResultSchema>

/** `evt:claudeConsoleProgress` payload, pushed about every 3 s during a pull. */
export const ClaudeConsoleProgressSchema = z.object({
  runId: z.string(),
  /** typing = driving the DevTools window; waiting = watching Downloads; saving = file growing. */
  phase: z.enum(['typing', 'waiting', 'saving']),
  elapsedSec: z.number().int(),
  /** Fresh console screenshot (base64 PNG), null when unavailable. */
  screenshot: z.string().nullable(),
  /** Current size of the pull file once it appears, else null. */
  fileBytes: z.number().int().nullable()
})

export type ClaudeConsoleProgress = z.infer<typeof ClaudeConsoleProgressSchema>

// ---------------------------------------------------------------------------
// claude.ai session route: ClaudeLift's own claude.ai window (no Claude Desktop)
// ---------------------------------------------------------------------------

/**
 * `claudeAi:status` / `:signIn` / `:signOut` response and `evt:claudeAiStatus`
 * payload. Read from `GET https://claude.ai/api/organizations` with the
 * dedicated `persist:claudeai` session; only org names leave the main process.
 */
export const ClaudeAiSessionStatusSchema = z.object({
  signedIn: z.boolean(),
  /** Names of the organizations the signed-in user belongs to. */
  orgNames: z.array(z.string()),
  /** The "Sign in to claude.ai" window is open. */
  signInWindowOpen: z.boolean(),
  /** Why the check failed (for example a network error), else null. */
  error: z.string().nullable()
})

export type ClaudeAiSessionStatus = z.infer<typeof ClaudeAiSessionStatusSchema>

/** `claudeAi:runPull` request — main picks the output folder from settings.outputDir. */
export const ClaudeAiPullRequestSchema = z.object({
  runId: PullRunIdSchema,
  chats: PullChatsModeSchema
})

export type ClaudeAiPullRequest = z.infer<typeof ClaudeAiPullRequestSchema>

export const ClaudeAiPullResultSchema = z.object({
  /** Absolute path of the saved `claudelift-pull-<runId>.json`. */
  file: z.string(),
  sizeBytes: z.number().int(),
  /** `<settings.outputDir>/claude-account-pulls`. */
  outDir: z.string()
})

export type ClaudeAiPullResult = z.infer<typeof ClaudeAiPullResultSchema>

/**
 * `evt:claudeAiPullProgress` payload: a tick about every 3 s, one on each
 * phase change, and one per `[pull]` console line of the pull script.
 */
export const ClaudeAiPullProgressSchema = z.object({
  runId: z.string(),
  /** checking = sign-in check; loading = opening claude.ai; running = script; saving = download. */
  phase: z.enum(['checking', 'loading', 'running', 'saving']),
  elapsedSec: z.number().int(),
  /** One `[pull]` console line (prefix and %c styling removed), else null. */
  line: z.string().nullable(),
  /** Bytes saved so far once the download started, else null. */
  fileBytes: z.number().int().nullable()
})

export type ClaudeAiPullProgress = z.infer<typeof ClaudeAiPullProgressSchema>

// ---------------------------------------------------------------------------
// Push: rebuild projects in a new-layout account (docs/NEW-LAYOUT-SPEC.md)
// ---------------------------------------------------------------------------

/** How a plan project came to be (engine `plan-push`). */
export const PushProjectKindSchema = z.enum([
  'claude-project',
  'cowork-space',
  'cowork-history',
  'chat-history',
  'account-memory'
])
export type PushProjectKind = z.infer<typeof PushProjectKindSchema>

export const PushCountsSchema = z.looseObject({
  docs: z.number().int().default(0),
  files: z.number().int().default(0),
  chats: z.number().int().default(0),
  cowork: z.number().int().default(0),
  memory: z.number().int().default(0),
  bytes: z.number().default(0),
  keys_removed: z.number().int().default(0)
})
export type PushCounts = z.infer<typeof PushCountsSchema>

/** One project of the plan file as the engine writes it (main process only). */
export const PushPlanProjectSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  source_name: z.string().nullish(),
  org: z.string().nullish(),
  kind: PushProjectKindSchema.or(z.string()),
  instructions: z.string().default(''),
  library: z.array(
    z.object({
      path: z.string().min(1),
      file: z.string().min(1),
      size: z.number().int().nonnegative(),
      mime: z.string().min(1)
    })
  ),
  memory: z.array(
    z.object({
      path: z.string().regex(/^\//, 'memory paths start with /'),
      content: z.string(),
      redacted: z.number().int().default(0)
    })
  ),
  /** Linked PC folders, as the Library's "Add folder" records them (files are under `<name>/`). */
  context_sources: z
    .array(z.object({ kind: z.string().min(1), name: z.string().min(1), path: z.string().optional() }))
    .default([]),
  counts: PushCountsSchema,
  warnings: z.array(z.string()).default([]),
  empty: z.boolean().default(false)
})
export type PushPlanProject = z.infer<typeof PushPlanProjectSchema>

export const PushPlanSchema = z.looseObject({
  plan_version: z.literal(1),
  source: z.string(),
  projects: z.array(PushPlanProjectSchema),
  skipped: z.array(z.looseObject({ name: z.string().nullish() })).default([])
})
export type PushPlan = z.infer<typeof PushPlanSchema>

/** `push:plan` request → engine `plan-push`. Main picks the plan file under settings.outputDir. */
export const PushPlanRequestSchema = z.object({
  /** A converted claude.ai account folder (has projects/, account/, conversations/). */
  source: z.string().min(1),
  /** Optional folder of Cowork task bundles (an `export` output). */
  coworkBundles: z.string().min(1).optional(),
  includeChats: z.boolean(),
  includeUnfiledChats: z.boolean(),
  includeAccountMemory: z.boolean(),
  /** Also each project's linked PC folders: their files under `<folder name>/` in the Library. */
  includeLocalFolders: z.boolean().default(false),
  /** Only projects of these organizations (names); empty = all. */
  orgs: z.array(z.string().min(1)).default([])
})
export type PushPlanRequest = z.infer<typeof PushPlanRequestSchema>

/** What the renderer sees of a plan project (no file paths, no memory text). */
export const PushPlanItemSchema = z.object({
  key: z.string(),
  name: z.string(),
  org: z.string().nullable(),
  kind: z.string(),
  counts: PushCountsSchema,
  instructionsChars: z.number().int(),
  warnings: z.array(z.string())
})
export type PushPlanItem = z.infer<typeof PushPlanItemSchema>

export const PushPlanSummarySchema = z.object({
  planFile: z.string(),
  source: z.string(),
  projects: z.array(PushPlanItemSchema),
  /** Names of empty projects left out of the plan. */
  skipped: z.array(z.string())
})
export type PushPlanSummary = z.infer<typeof PushPlanSummarySchema>

/** Where the claude.ai calls run: ClaudeLift's own sign-in, or Claude Desktop's page via its Main Process Debugger. */
export const PushExecutorSchema = z.enum(['claudeai', 'desktop'])
export type PushExecutor = z.infer<typeof PushExecutorSchema>

export const PushAccountRequestSchema = z.object({ executor: PushExecutorSchema })
export type PushAccountRequest = z.infer<typeof PushAccountRequestSchema>

/** The account the executor's claude.ai page is signed in to (read-only check). */
export const PushAccountSchema = z.object({
  email: z.string().nullable(),
  orgUuid: z.string(),
  orgName: z.string().nullable(),
  /** Live (not archived) new-layout projects in that org. */
  projectNames: z.array(z.string())
})
export type PushAccount = z.infer<typeof PushAccountSchema>

/** `push:desktopStatus`: is Claude Desktop's Main Process Debugger open on 127.0.0.1:9229? */
export const PushDesktopStatusSchema = z.object({
  available: z.boolean(),
  detail: z.string()
})
export type PushDesktopStatus = z.infer<typeof PushDesktopStatusSchema>

export const PushRunRequestSchema = z.object({
  planFile: z.string().min(1),
  /** Plan project keys to run. */
  keys: z.array(z.string().min(1)).min(1),
  executor: PushExecutorSchema,
  dryRun: z.boolean(),
  /** The email the user saw and confirmed; the run stops when the page is signed in to another account. */
  expectEmail: z.string().nullable().optional(),
  /** Also add missing files and notes to projects ClaudeLift made and finished before. */
  topUp: z.boolean().optional()
})
export type PushRunRequest = z.infer<typeof PushRunRequestSchema>

export const PushActionSchema = z.enum(['create', 'skip', 'resume'])
export type PushAction = z.infer<typeof PushActionSchema>

export const PushFailureSchema = z.object({
  path: z.string(),
  step: z.string(),
  status: z.number().int().nullable(),
  error: z.string().nullable()
})
export type PushFailure = z.infer<typeof PushFailureSchema>

export const PushProjectResultSchema = z.object({
  key: z.string(),
  name: z.string(),
  action: PushActionSchema,
  /** Why it was skipped (dry run and real run). */
  reason: z.string().nullable(),
  chan: z.string().nullable(),
  url: z.string().nullable(),
  instructions: z.enum(['set', 'kept', 'none', 'failed']).nullable(),
  library: z.object({
    planned: z.number().int(),
    written: z.number().int(),
    existing: z.number().int(),
    failed: z.array(PushFailureSchema)
  }),
  memory: z.object({
    planned: z.number().int(),
    written: z.number().int(),
    existing: z.number().int(),
    failed: z.array(PushFailureSchema)
  }),
  verify: z.object({ libraryFiles: z.number().int(), memoryFiles: z.number().int() }).nullable(),
  complete: z.boolean(),
  error: z.string().nullable()
})
export type PushProjectResult = z.infer<typeof PushProjectResultSchema>

export const PushRunResultSchema = z.object({
  dryRun: z.boolean(),
  account: PushAccountSchema,
  receiptFile: z.string(),
  projects: z.array(PushProjectResultSchema),
  cancelled: z.boolean(),
  /** Why the run stopped early (e.g. claude.ai's upload limit), else null. */
  stopped: z.string().nullable().default(null)
})
export type PushRunResult = z.infer<typeof PushRunResultSchema>

/** `evt:pushProgress` payload. */
export const PushProgressSchema = z.object({
  key: z.string().nullable(),
  name: z.string().nullable(),
  /** 1-based position of the project in this run, and the run's project count. */
  index: z.number().int(),
  total: z.number().int(),
  phase: z.enum(['account', 'checking', 'create', 'instructions', 'library', 'memory', 'verify', 'done']),
  /** Items done / planned within the phase (library files, memory notes). */
  done: z.number().int(),
  of: z.number().int(),
  line: z.string().nullable()
})
export type PushProgress = z.infer<typeof PushProgressSchema>

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
  mcpRevealServer: 'mcp:revealServer',
  migrateListWorkspaces: 'migrate:listWorkspaces',
  migrateConvertClaudeAi: 'migrate:convertClaudeAi',
  migrateImportAll: 'migrate:importAll',
  migrateImportSpace: 'migrate:importSpace',
  migrateCancel: 'migrate:cancel',
  claudeConsoleFind: 'claudeConsole:find',
  claudeConsoleScreenshot: 'claudeConsole:screenshot',
  claudeConsoleRunPull: 'claudeConsole:runPull',
  claudeConsoleCancel: 'claudeConsole:cancel',
  /** Open a folder inside settings.outputDir (the pull's converted output). */
  claudeConsoleOpenOutput: 'claudeConsole:openOutput',
  claudeAiStatus: 'claudeAi:status',
  /** Open the "Sign in to claude.ai" window (focus it when already open). */
  claudeAiSignIn: 'claudeAi:signIn',
  claudeAiSignOut: 'claudeAi:signOut',
  claudeAiRunPull: 'claudeAi:runPull',
  claudeAiCancel: 'claudeAi:cancel',
  pushPlan: 'push:plan',
  pushAccount: 'push:account',
  pushDesktopStatus: 'push:desktopStatus',
  pushRun: 'push:run',
  pushCancel: 'push:cancel'
} as const

/** Contract map for the preload's channel-literal duplication (`satisfies`). */
export type InvokeChannelMap = typeof INVOKE_CHANNELS
export type InvokeChannel = (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS]

/** Main → renderer push channels (`webContents.send`). */
export const EVENT_CHANNELS = {
  tasksChanged: 'evt:tasksChanged',
  exportProgress: 'evt:exportProgress',
  notionProgress: 'evt:notionProgress',
  watcherState: 'evt:watcherState',
  convertProgress: 'evt:convertProgress',
  importAllProgress: 'evt:importAllProgress',
  claudeConsoleProgress: 'evt:claudeConsoleProgress',
  claudeAiStatus: 'evt:claudeAiStatus',
  claudeAiPullProgress: 'evt:claudeAiPullProgress',
  pushProgress: 'evt:pushProgress'
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
  migrateListWorkspaces(req: ListWorkspacesRequest): Promise<WorkspaceInfo[]>
  migrateConvertClaudeAi(opts: ConvertClaudeAiOptions): Promise<ConvertResult>
  migrateImportAll(opts: ImportAllOptions): Promise<ImportAllResult>
  migrateImportSpace(opts: ImportSpaceOptions): Promise<ImportSpaceResult>
  /** Kill the running convert-claudeai / import-all (no-op when idle). */
  migrateCancel(): Promise<void>
  /** Read-only: is the claude.ai DevTools window of Claude Desktop open? */
  claudeConsoleFind(): Promise<ClaudeConsoleInfo>
  /** Read-only: screenshot of that window (no focus change). */
  claudeConsoleScreenshot(): Promise<ClaudeConsoleScreenshot>
  /** Type the account-pull script into the DevTools console and wait for its download. */
  claudeConsoleRunPull(req: ClaudeConsolePullRequest): Promise<ClaudeConsolePullResult>
  /** Stop waiting for the running pull (no-op when idle). */
  claudeConsoleCancel(): Promise<void>
  /** Open dir in Explorer — only folders inside settings.outputDir. */
  claudeConsoleOpenOutput(req: OpenFolderRequest): Promise<void>
  /** Read-only: is ClaudeLift's own claude.ai session signed in? */
  claudeAiStatus(): Promise<ClaudeAiSessionStatus>
  /** Open the "Sign in to claude.ai" window; later changes arrive on evt:claudeAiStatus. */
  claudeAiSignIn(): Promise<ClaudeAiSessionStatus>
  /** Clear the claude.ai session (cookies, storage) and close its windows. */
  claudeAiSignOut(): Promise<ClaudeAiSessionStatus>
  /** Run the account-pull script in a hidden claude.ai window and save its download. */
  claudeAiRunPull(req: ClaudeAiPullRequest): Promise<ClaudeAiPullResult>
  /** Cancel the running claude.ai pull (no-op when idle). */
  claudeAiCancel(): Promise<void>
  /** Engine `plan-push`: what would be rebuilt in a new-layout account. */
  pushPlan(req: PushPlanRequest): Promise<PushPlanSummary>
  /** Read-only: which account the executor's claude.ai page is signed in to. */
  pushAccount(req: PushAccountRequest): Promise<PushAccount>
  /** Read-only: is Claude Desktop's Main Process Debugger open? */
  pushDesktopStatus(): Promise<PushDesktopStatus>
  /** Rebuild the chosen plan projects (dry run: GET calls only). Progress on evt:pushProgress. */
  pushRun(req: PushRunRequest): Promise<PushRunResult>
  /** Stop the running push after the current call (no-op when idle). */
  pushCancel(): Promise<void>

  onTasksChanged(cb: () => void): Unsubscribe
  offTasksChanged(cb?: () => void): void
  onExportProgress(cb: (event: ProgressEvent) => void): Unsubscribe
  offExportProgress(cb?: (event: ProgressEvent) => void): void
  onNotionProgress(cb: (state: NotionExportState) => void): Unsubscribe
  offNotionProgress(cb?: (state: NotionExportState) => void): void
  onWatcherState(cb: (state: WatcherState) => void): Unsubscribe
  offWatcherState(cb?: (state: WatcherState) => void): void
  onConvertProgress(cb: (event: ConvertProgressEvent) => void): Unsubscribe
  offConvertProgress(cb?: (event: ConvertProgressEvent) => void): void
  onImportAllProgress(cb: (event: ImportAllProgressEvent) => void): Unsubscribe
  offImportAllProgress(cb?: (event: ImportAllProgressEvent) => void): void
  onClaudeConsoleProgress(cb: (event: ClaudeConsoleProgress) => void): Unsubscribe
  offClaudeConsoleProgress(cb?: (event: ClaudeConsoleProgress) => void): void
  onClaudeAiStatus(cb: (status: ClaudeAiSessionStatus) => void): Unsubscribe
  offClaudeAiStatus(cb?: (status: ClaudeAiSessionStatus) => void): void
  onClaudeAiPullProgress(cb: (event: ClaudeAiPullProgress) => void): Unsubscribe
  offClaudeAiPullProgress(cb?: (event: ClaudeAiPullProgress) => void): void
  onPushProgress(cb: (event: PushProgress) => void): Unsubscribe
  offPushProgress(cb?: (event: PushProgress) => void): void
}

// ---------------------------------------------------------------------------
// Engine sidecar version (pinned)
// ---------------------------------------------------------------------------

/**
 * Version of the bundled cowork-export sidecar (TOOL_VERSION in
 * cowork_export.py). `app:diagnostics` reports this constant instead of
 * spawning the engine for a live probe; bump alongside engine rebuilds.
 */
export const ENGINE_VERSION = '0.6.0-desktop'
