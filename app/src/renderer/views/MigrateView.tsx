/**
 * Migrate view: move chats between accounts.
 *
 * Two cards, each a short numbered flow that ends in the engine's
 * `import-all` into a target workspace (`<root>/<account>/<org>`):
 *
 * A. Move Cowork chats to another account — (1) export every Cowork task
 *    on this machine (optionally only one source account) through the
 *    regular export path into a folder, (2) pick the target workspace,
 *    (3) import-all with progress, dry-run and allow-running.
 * B. Import a claude.ai data export — (1) convert-claudeai the "Export
 *    data" download into bundles (since / title filter / limit /
 *    artifacts), (2) pick the target workspace, (3) import-all.
 * C. Pull the whole claude.ai account — two routes for steps 1-2:
 *    - Sign in inside ClaudeLift (recommended): (1) sign in once in
 *      ClaudeLift's own claude.ai window (dedicated session), (2) run the
 *      pull script in a hidden claude.ai window and save its download
 *      (live [pull] log);
 *    - Claude Desktop's DevTools (fallback): (1) live detection of the
 *      claude.ai DevTools window (Developer Mode + Ctrl+Shift+I), (2) type
 *      the pull script into its console and wait for the download (elapsed
 *      time + live screenshot).
 *    Then, shared: (3) convert-claudeai with `--pull`, (4) pick the target
 *    workspace, (5) import-all.
 * D. Rebuild projects in the new account (new layout: projects and threads
 *    in the cloud) — (1) engine `plan-push` over a converted account folder
 *    (+ optional Cowork bundles), (2) check which account the claude.ai
 *    page is signed in to (ClaudeLift's sign-in, or Claude Desktop through
 *    its Main Process Debugger), (3) dry run, then the real push.
 *    A/B/C targets that are new-layout folders get a warning that steers
 *    to D (see docs/NEW-LAYOUT-SPEC.md).
 *
 * Workspaces come from migrate:listWorkspaces (email + task count per
 * workspace). The engine refuses to write while Claude Desktop is running
 * (exit 3); that refusal renders as a "quit it from the tray" warning.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  PickFolderResultSchema,
  PushAccountSchema,
  PushDesktopStatusSchema,
  PushPlanSummarySchema,
} from '../../shared/ipc'
import type {
  ClaudeAiPart,
  ClaudeAiPullProgress,
  ClaudeConsoleInfo,
  ConvertResult,
  CoworkTask,
  ExportFormat,
  ImportAllResult,
  ProgressEvent,
  PullChatsMode,
  PushAccount,
  PushDesktopStatus,
  PushExecutor,
  PushPlanSummary,
  PushProgress,
  PushRunResult,
  WorkspaceInfo
} from '../../shared/ipc'
import {
  EXPORT_BATCH_KEY,
  errorText,
  isDesktopRunningError,
  parseIpcError,
  useAppStore,
  type EngineErrorInfo,
  type MigrateOwner
} from '../store'

const FORMATS: readonly ExportFormat[] = ['html', 'md', 'json', 'csv']

const FORMAT_LABELS: Record<ExportFormat, string> = {
  html: 'HTML',
  md: 'Markdown',
  json: 'JSON',
  csv: 'CSV'
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True when `file` lives inside workspace dir `dir` (case-insensitive, Windows paths). */
function isInside(file: string | null, dir: string): boolean {
  if (file === null) return false
  const f = file.toLowerCase().replace(/\//g, '\\')
  const d = dir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')
  return f.startsWith(`${d}\\`)
}

/** `<dir>\<name>` using the separator `dir` already uses. */
function childPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** Local `yyyyMMdd-HHmmss`, for a per-run output folder name. */
function runStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function workspaceTitle(ws: WorkspaceInfo): string {
  if (ws.email !== null) return ws.email
  return ws.signedInNow ? 'Account signed in to Claude Desktop now (no tasks yet)' : 'Unknown account (no tasks yet)'
}

function formatDay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'never'
  return new Date(ms).toLocaleDateString()
}

/** Engine refusals read best as their stderr; fall back to the message. */
function errorBody(error: EngineErrorInfo): string {
  const stderr = (error.stderr ?? '').trim()
  return stderr !== '' ? stderr : error.message
}

async function pickFolder(purpose: string): Promise<string | null> {
  return PickFolderResultSchema.parse(await window.api.appPickFolder({ purpose }))
}

// ---------------------------------------------------------------------------
// small building blocks
// ---------------------------------------------------------------------------

function Step({
  n,
  title,
  done = false,
  children
}: {
  n: number
  title: string
  done?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section className="flex gap-3">
      <span
        className={`badge badge-sm mt-0.5 shrink-0 ${done ? 'badge-success' : 'badge-primary'}`}
        aria-hidden="true"
      >
        {done ? '✓' : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="font-semibold">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </section>
  )
}

function FolderField({
  label,
  value,
  purpose,
  disabled = false,
  onChange
}: {
  label: string
  value: string
  purpose: string
  disabled?: boolean
  onChange: (dir: string) => void
}): JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast)
  const browse = async (): Promise<void> => {
    try {
      const dir = await pickFolder(purpose)
      if (dir !== null) onChange(dir)
    } catch (err) {
      pushToast('error', `Folder picker failed: ${errorText(err)}`)
    }
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-base-content/70">{label}</span>
      <div className="join w-full">
        <input
          type="text"
          className="input input-sm join-item min-w-0 flex-1 font-mono text-xs"
          value={value}
          placeholder="Choose a folder…"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm join-item"
          disabled={disabled}
          onClick={() => void browse()}
        >
          Browse…
        </button>
      </div>
    </label>
  )
}

function WorkspacePicker({
  name,
  workspaces,
  loading,
  value,
  sourcePath,
  disabled,
  onChange,
  onRefresh
}: {
  /** Radio-group name — unique per card. */
  name: string
  workspaces: WorkspaceInfo[]
  loading: boolean
  value: string
  /** Workspace the chats come from — flagged, not hidden. */
  sourcePath?: string
  disabled: boolean
  onChange: (path: string) => void
  onRefresh: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {workspaces.length === 0 ? (
        <div role="alert" className="alert alert-warning text-sm">
          <span className="whitespace-normal">
            No Cowork account folders found. Sign in to the target account in Claude Desktop once
            (that creates its folder), then press Refresh.
          </span>
        </div>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {workspaces.map((ws) => (
            <li key={ws.path}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-box border p-2 ${
                  value === ws.path ? 'border-primary bg-primary/5' : 'border-base-300'
                }`}
              >
                <input
                  type="radio"
                  className="radio radio-sm radio-primary mt-0.5"
                  name={name}
                  checked={value === ws.path}
                  disabled={disabled}
                  onChange={() => onChange(ws.path)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{workspaceTitle(ws)}</span>
                    {ws.accountName !== null && (
                      <span className="text-base-content/60">{ws.accountName}</span>
                    )}
                    <span className="badge badge-ghost badge-sm">
                      {ws.taskCount} {ws.taskCount === 1 ? 'task' : 'tasks'}
                    </span>
                    {ws.signedInNow && !ws.leftover && (
                      <span className="badge badge-success badge-sm">signed in now</span>
                    )}
                    {ws.leftover && (
                      <span className="badge badge-ghost badge-sm" title="This org is not one of the account's organizations; Claude Desktop made the folder while switching accounts.">
                        leftover folder — not a target
                      </span>
                    )}
                    {ws.newLayout && !ws.leftover && (
                      <span
                        className="badge badge-info badge-sm"
                        title="This account keeps projects and threads in the cloud. Use card D to rebuild projects there."
                      >
                        new layout — use card D
                      </span>
                    )}
                    {sourcePath !== undefined && sourcePath === ws.path && (
                      <span className="badge badge-warning badge-sm">source</span>
                    )}
                  </span>
                  <span className="text-xs text-base-content/60">
                    Last activity {formatDay(ws.lastActivityMs)}
                  </span>
                  <span className="truncate font-mono text-xs text-base-content/50" title={ws.path}>
                    {ws.path}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm self-start"
        disabled={loading}
        onClick={onRefresh}
      >
        {loading && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
        Refresh
      </button>
    </div>
  )
}

function DesktopRunningAlert(): JSX.Element {
  return (
    <div role="alert" className="alert alert-warning alert-vertical items-start text-left text-sm">
      <span className="font-semibold">Claude Desktop is running</span>
      <span className="whitespace-normal">
        Quit it first: right-click the Claude icon in the system tray and choose Quit (closing the
        window is not enough). It keeps spaces and task lists in memory and would overwrite the
        import. Then run the import again — or tick &quot;Import anyway while Claude Desktop is
        running&quot;.
      </span>
    </div>
  )
}

function ErrorAlert({ error }: { error: EngineErrorInfo }): JSX.Element {
  return (
    <div role="alert" className="alert alert-error alert-vertical items-start text-left text-sm">
      <span className="font-semibold">{error.message}</span>
      {errorBody(error) !== error.message && (
        <pre className="max-h-40 w-full overflow-auto whitespace-pre-wrap font-mono text-xs">
          {errorBody(error)}
        </pre>
      )}
    </div>
  )
}

/**
 * Step 3 of both flows: import-all `folder` into `workspace`, with dry-run
 * and allow-running, a progress bar fed by evt:importAllProgress, cancel,
 * and a result summary.
 */
function ImportAllStep({
  owner,
  folder,
  workspace,
  workspaceEmail,
  workspaceNewLayout = false
}: {
  owner: MigrateOwner
  folder: string
  workspace: string
  workspaceEmail: string | null
  /** The target keeps projects in the cloud: a real import creates no projects there. */
  workspaceNewLayout?: boolean
}): JSX.Element {
  const migrateJob = useAppStore((s) => s.migrateJob)
  const events = useAppStore((s) => (s.importAllOwner === owner ? s.importAllProgress : null))
  const runImportAll = useAppStore((s) => s.runImportAll)
  const cancelMigrate = useAppStore((s) => s.cancelMigrate)
  const coworkRoot = useAppStore((s) => s.settings?.coworkRootOverride ?? null)

  const [dryRun, setDryRun] = useState(true)
  const [allowRunning, setAllowRunning] = useState(false)
  const [importOldStyle, setImportOldStyle] = useState(false)
  const [result, setResult] = useState<ImportAllResult | null>(null)
  const [error, setError] = useState<EngineErrorInfo | null>(null)

  const running = migrateJob?.kind === 'importAll' && migrateJob.owner === owner
  const busy = migrateJob !== null
  const blockedNewLayout = workspaceNewLayout && !dryRun && !importOldStyle
  const ready = folder.trim() !== '' && workspace !== '' && !blockedNewLayout

  const progress = useMemo(() => {
    let completed = 0
    let total: number | null = null
    let spaces = 0
    const failures: { bundle: string; detail: string }[] = []
    const notes: string[] = []
    for (const evt of events ?? []) {
      switch (evt.event) {
        case 'task':
          completed += 1
          total = evt.total
          break
        case 'task_failed':
          completed += 1
          total = evt.total
          failures.push({ bundle: evt.bundle, detail: evt.detail })
          break
        case 'space':
          spaces += 1
          break
        case 'account_memory':
          if (evt.detail) notes.push(`Account memory ${evt.detail}`)
          break
        case 'done':
          total = evt.tasks_imported + evt.tasks_failed
          break
      }
    }
    return { completed, total, spaces, failures, notes }
  }, [events])

  const run = async (): Promise<void> => {
    setResult(null)
    setError(null)
    const outcome = await runImportAll(owner, {
      folder: folder.trim(),
      workspace,
      dryRun,
      allowRunning,
      ...(coworkRoot !== null ? { coworkRoot } : {})
    })
    if (outcome.ok) setResult(outcome.result)
    else if (outcome.error.kind !== 'aborted' || isDesktopRunningError(outcome.error)) {
      setError(outcome.error)
    }
  }

  const desktopRunning = isDesktopRunningError(error)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <label className="label cursor-pointer gap-2">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={dryRun}
            disabled={busy}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <span className="text-base-content">Dry run (write nothing)</span>
        </label>
        <label className="label cursor-pointer gap-2">
          <input
            type="checkbox"
            className={`checkbox checkbox-sm ${desktopRunning ? 'checkbox-warning' : ''}`}
            checked={allowRunning}
            disabled={busy}
            onChange={(e) => setAllowRunning(e.target.checked)}
          />
          <span className="text-base-content">Import anyway while Claude Desktop is running</span>
        </label>
      </div>

      {workspaceNewLayout && (
        <div role="alert" className="alert alert-info alert-vertical items-start text-left text-sm">
          <span className="whitespace-normal">
            This account uses the new layout: projects and threads live in the cloud. An import here
            writes old-style Cowork files and makes no projects. Use card D, &ldquo;Rebuild projects
            in the new account&rdquo;, instead.
          </span>
          <label className="label cursor-pointer gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={importOldStyle}
              disabled={busy}
              onChange={(e) => setImportOldStyle(e.target.checked)}
            />
            <span className="text-base-content">Import old-style files anyway</span>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!ready || busy}
          onClick={() => void run()}
        >
          {running && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
          {dryRun ? 'Preview import' : 'Import'}
        </button>
        {running && (
          <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelMigrate()}>
            Cancel
          </button>
        )}
        {!ready && !blockedNewLayout && (
          <span className="text-xs text-base-content/60">
            Pick a bundle folder and a target account first.
          </span>
        )}
      </div>

      {running && (
        <div className="flex items-center gap-3">
          {progress.total === null ? (
            <progress className="progress flex-1" />
          ) : (
            <progress className="progress flex-1" value={progress.completed} max={progress.total} />
          )}
          <span className="text-sm tabular-nums text-base-content/70">
            {progress.total === null ? `${progress.spaces} spaces` : `${progress.completed}/${progress.total}`}
          </span>
        </div>
      )}

      {desktopRunning && <DesktopRunningAlert />}
      {error !== null && !desktopRunning && <ErrorAlert error={error} />}

      {result !== null && (
        <div
          role="alert"
          className={`alert alert-vertical items-start text-left text-sm ${
            result.tasksFailed > 0 ? 'alert-warning' : 'alert-success'
          }`}
        >
          <span className="font-semibold">
            {result.dryRun ? 'Dry run — nothing written. ' : ''}
            {result.dryRun ? 'Would import' : 'Imported'} {result.tasksImported}{' '}
            {result.tasksImported === 1 ? 'chat' : 'chats'} and {result.spaces}{' '}
            {result.spaces === 1 ? 'space' : 'spaces'}
            {result.tasksFailed > 0 ? `; ${result.tasksFailed} failed` : ''}.
          </span>
          <span className="whitespace-normal">
            {result.dryRun
              ? 'Turn off Dry run and press Import to write them.'
              : `Start Claude Desktop again${
                  workspaceEmail !== null ? ` signed in as ${workspaceEmail}` : ''
                } to see them.`}
          </span>
        </div>
      )}

      {progress.notes.length > 0 && !running && (
        <ul className="text-xs text-base-content/60">
          {progress.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {progress.failures.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
          {progress.failures.map((f) => (
            <li key={f.bundle} className="flex gap-2">
              <span className="badge badge-warning badge-xs mt-0.5">failed</span>
              <span className="min-w-0 flex-1 break-words">
                <span className="font-mono">{f.bundle}</span>
                {f.detail !== '' ? ` — ${f.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// card A: move Cowork chats to another account
// ---------------------------------------------------------------------------

function CoworkMoveCard({
  workspaces,
  workspacesLoading,
  onRefreshWorkspaces
}: {
  workspaces: WorkspaceInfo[]
  workspacesLoading: boolean
  onRefreshWorkspaces: () => void
}): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const tasks = useAppStore((s) => s.tasks)
  const exportRunning = useAppStore((s) => s.exportRunning)
  const exportProgress = useAppStore((s) => s.exportProgress)
  const runExport = useAppStore((s) => s.runExport)
  const cancelExport = useAppStore((s) => s.cancelExport)
  const migrateJob = useAppStore((s) => s.migrateJob)

  const [folder, setFolder] = useState('')
  const [formats, setFormats] = useState<ExportFormat[]>(['md', 'json'])
  const [sourcePath, setSourcePath] = useState('all')
  const [includeArchived, setIncludeArchived] = useState(true)
  const [exportStarted, setExportStarted] = useState(false)
  const [exportedCount, setExportedCount] = useState<number | null>(null)
  const [target, setTarget] = useState('')

  // Default the folder once settings arrive: a fresh subfolder of the
  // export folder, so older bundles there are not imported too.
  useEffect(() => {
    if (folder === '' && settings !== null) {
      setFolder(childPath(settings.outputDir, 'account-move'))
    }
  }, [folder, settings])

  const exportable = useMemo(
    () =>
      tasks.filter(
        (t: CoworkTask) =>
          t.source === 'cowork' &&
          t.hasTranscript &&
          (includeArchived || !t.archived) &&
          (sourcePath === 'all' || isInside(t.taskMetaFile, sourcePath))
      ),
    [tasks, includeArchived, sourcePath]
  )

  const completed = useMemo(() => {
    let n = 0
    for (const [key, events] of Object.entries(exportProgress)) {
      if (key === EXPORT_BATCH_KEY) continue
      if (events.some((e: ProgressEvent) => e.event === 'task_done' || e.event === 'task_skipped')) n += 1
    }
    return n
  }, [exportProgress])

  const toggleFormat = (format: ExportFormat): void => {
    setFormats((cur) => {
      if (!cur.includes(format)) return FORMATS.filter((f) => f === format || cur.includes(f))
      if (cur.length === 1) return cur // ≥1 format always enforced
      return cur.filter((f) => f !== format)
    })
  }

  const runStepOne = async (): Promise<void> => {
    if (settings === null || exportable.length === 0 || folder.trim() === '') return
    setExportStarted(true)
    setExportedCount(null)
    const ok = await runExport({
      taskIds: exportable.map((t) => t.taskId),
      outputDir: folder.trim(),
      formats: [...formats],
      noFiles: false,
      includeAuth: false,
      purgeSource: false,
      source: 'cowork',
      ...(settings.coworkRootOverride !== null ? { coworkRoot: settings.coworkRootOverride } : {})
    })
    const batch = useAppStore.getState().exportProgress[EXPORT_BATCH_KEY] ?? []
    const done = batch.find((e): e is Extract<ProgressEvent, { event: 'done' }> => e.event === 'done')
    setExportedCount(ok && done !== undefined ? done.exported : null)
    setExportStarted(false)
  }

  const sourceWorkspaces = workspaces.filter((ws) => ws.taskCount > 0)
  const targetEmail = workspaces.find((ws) => ws.path === target)?.email ?? null
  const targetNewLayout = workspaces.find((ws) => ws.path === target)?.newLayout === true
  const busy = exportRunning || migrateJob !== null

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">Move Cowork chats to another account</h2>
          <p className="text-sm text-base-content/70">
            Export the Cowork chats on this PC, then import them into another account&apos;s
            Cowork. Spaces come along and are recreated by name.
          </p>
        </div>

        <Step n={1} title="Export the chats to a folder" done={exportedCount !== null && exportedCount > 0}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-content/70">From account</span>
              <select
                className="select select-sm w-full"
                value={sourcePath}
                disabled={busy}
                onChange={(e) => setSourcePath(e.target.value)}
              >
                <option value="all">All accounts on this PC</option>
                {sourceWorkspaces.map((ws) => (
                  <option key={ws.path} value={ws.path}>
                    {workspaceTitle(ws)} ({ws.taskCount})
                  </option>
                ))}
              </select>
            </label>
            <label className="label cursor-pointer gap-2 self-end">
              <input
                type="checkbox"
                className="toggle toggle-sm"
                checked={includeArchived}
                disabled={busy}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              <span className="text-base-content">Include archived chats</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {FORMATS.map((format) => (
              <label key={format} className="label cursor-pointer gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={formats.includes(format)}
                  disabled={busy || (formats.includes(format) && formats.length === 1)}
                  onChange={() => toggleFormat(format)}
                />
                <span className="text-base-content">{FORMAT_LABELS[format]}</span>
              </label>
            ))}
          </div>
          <FolderField
            label="Export folder (use an empty folder — every bundle in it gets imported)"
            value={folder}
            purpose="Migration export folder"
            disabled={busy}
            onChange={setFolder}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || exportable.length === 0 || folder.trim() === '' || settings === null}
              onClick={() => void runStepOne()}
            >
              {exportStarted && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Export {exportable.length} {exportable.length === 1 ? 'chat' : 'chats'}
            </button>
            {exportStarted && exportRunning && (
              <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelExport()}>
                Cancel
              </button>
            )}
            <span className="text-xs text-base-content/60">
              Already exported? Point the folder at it and go to step 2.
            </span>
          </div>
          {exportStarted && exportRunning && (
            <div className="flex items-center gap-3">
              <progress className="progress flex-1" value={completed} max={exportable.length} />
              <span className="text-sm tabular-nums text-base-content/70">
                {completed}/{exportable.length}
              </span>
            </div>
          )}
          {exportedCount !== null && (
            <p className="text-sm text-success">Exported {exportedCount} chats.</p>
          )}
        </Step>

        <Step n={2} title="Pick the target account" done={target !== ''}>
          <WorkspacePicker
            name="cowork-target"
            workspaces={workspaces}
            loading={workspacesLoading}
            value={target}
            sourcePath={sourcePath === 'all' ? undefined : sourcePath}
            disabled={busy}
            onChange={setTarget}
            onRefresh={onRefreshWorkspaces}
          />
        </Step>

        <Step n={3} title="Import into the target account">
          <ImportAllStep
            owner="cowork"
            folder={folder}
            workspace={target}
            workspaceEmail={targetEmail}
            workspaceNewLayout={targetNewLayout}
          />
        </Step>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// card B: import a claude.ai data export
// ---------------------------------------------------------------------------

function ClaudeAiImportCard({
  workspaces,
  workspacesLoading,
  onRefreshWorkspaces,
  exportDir,
  onExportDirChange
}: {
  workspaces: WorkspaceInfo[]
  workspacesLoading: boolean
  onRefreshWorkspaces: () => void
  /** Lifted to the view so card C can merge the same export folder. */
  exportDir: string
  onExportDirChange: (dir: string) => void
}): JSX.Element {
  const migrateJob = useAppStore((s) => s.migrateJob)
  const exportRunning = useAppStore((s) => s.exportRunning)
  const events = useAppStore((s) => s.convertProgress)
  const runConvertClaudeAi = useAppStore((s) => s.runConvertClaudeAi)
  const cancelMigrate = useAppStore((s) => s.cancelMigrate)

  const setExportDir = onExportDirChange
  const [outputDir, setOutputDir] = useState('')
  const [since, setSince] = useState('')
  const [match, setMatch] = useState('')
  const [limit, setLimit] = useState('')
  const [includeArtifacts, setIncludeArtifacts] = useState(false)
  const [result, setResult] = useState<ConvertResult | null>(null)
  const [error, setError] = useState<EngineErrorInfo | null>(null)
  const [target, setTarget] = useState('')

  const running = migrateJob?.kind === 'convert' && migrateJob.owner === 'claudeai'
  const busy = migrateJob !== null || exportRunning
  const limitNumber = limit.trim() === '' ? undefined : Number.parseInt(limit, 10)
  const limitValid = limitNumber === undefined || (Number.isInteger(limitNumber) && limitNumber > 0)

  const chooseExportDir = (dir: string): void => {
    setExportDir(dir)
    // Default the bundle folder next to the download until the user picks one.
    if (outputDir === '' && dir.trim() !== '') setOutputDir(childPath(dir.trim(), 'claudelift-bundles'))
  }

  const progress = useMemo(() => {
    let projects = 0
    let index = 0
    let total: number | null = null
    let current = ''
    for (const evt of events) {
      if (evt.event === 'project_done') {
        projects += 1
        current = evt.name ?? evt.uuid
      } else if (evt.event === 'conversation_done') {
        index = evt.index
        total = evt.total
        current = evt.name ?? evt.uuid
      }
    }
    return { projects, index, total, current }
  }, [events])

  const convert = async (): Promise<void> => {
    setResult(null)
    setError(null)
    const what: ClaudeAiPart[] = [
      'conversations',
      'projects',
      'memory',
      'design'
    ]
    if (includeArtifacts) what.push('artifacts')
    const outcome = await runConvertClaudeAi({
      exportDir: exportDir.trim(),
      outputDir: outputDir.trim(),
      what,
      formats: ['md'],
      ...(since !== '' ? { since } : {}),
      ...(match.trim() !== '' ? { match: match.trim() } : {}),
      ...(limitNumber !== undefined ? { limit: limitNumber } : {})
    })
    if (outcome.ok) setResult(outcome.result)
    else if (outcome.error.kind !== 'aborted') setError(outcome.error)
  }

  const targetEmail = workspaces.find((ws) => ws.path === target)?.email ?? null
  const targetNewLayout = workspaces.find((ws) => ws.path === target)?.newLayout === true

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">Import a claude.ai data export</h2>
          <p className="text-sm text-base-content/70">
            On claude.ai go to Settings → Privacy → Export data, download it, and unzip the
            download into a folder. Chats become Cowork tasks; projects become spaces with their
            instructions, files and memory.
          </p>
        </div>

        <Step n={1} title="Convert the export into bundles" done={result !== null}>
          <FolderField
            label="claude.ai export folder (has conversations-*.zip, projects-*.zip, …)"
            value={exportDir}
            purpose="claude.ai export folder"
            disabled={busy}
            onChange={chooseExportDir}
          />
          <FolderField
            label="Bundle folder (output)"
            value={outputDir}
            purpose="Converted bundles folder"
            disabled={busy}
            onChange={setOutputDir}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-content/70">Only chats updated since</span>
              <input
                type="date"
                className="input input-sm w-full"
                value={since}
                disabled={busy}
                onChange={(e) => setSince(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-content/70">Title contains</span>
              <input
                type="text"
                className="input input-sm w-full"
                value={match}
                placeholder="any title"
                disabled={busy}
                onChange={(e) => setMatch(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-content/70">At most (newest first)</span>
              <input
                type="number"
                min={1}
                className={`input input-sm w-full ${limitValid ? '' : 'input-error'}`}
                value={limit}
                placeholder="all chats"
                disabled={busy}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
          </div>
          <label className="label cursor-pointer justify-start gap-2">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={includeArtifacts}
              disabled={busy}
              onChange={(e) => setIncludeArtifacts(e.target.checked)}
            />
            <span className="flex flex-col">
              <span className="text-base-content">Include artifacts</span>
              <span className="text-xs text-base-content/60">
                Copies the (often large) artifacts archive into the bundle folder.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || exportDir.trim() === '' || outputDir.trim() === '' || !limitValid}
              onClick={() => void convert()}
            >
              {running && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Convert
            </button>
            {running && (
              <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelMigrate()}>
                Cancel
              </button>
            )}
            <span className="text-xs text-base-content/60">
              Converted before? Set the bundle folder and go to step 2.
            </span>
          </div>
          {running && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                {progress.total === null ? (
                  <progress className="progress flex-1" />
                ) : (
                  <progress className="progress flex-1" value={progress.index} max={progress.total} />
                )}
                <span className="text-sm tabular-nums text-base-content/70">
                  {progress.total === null
                    ? `${progress.projects} projects`
                    : `${progress.index}/${progress.total}`}
                </span>
              </div>
              {progress.current !== '' && (
                <span className="truncate text-xs text-base-content/60" title={progress.current}>
                  {progress.current}
                </span>
              )}
            </div>
          )}
          {error !== null && <ErrorAlert error={error} />}
          {result !== null && (
            <div role="alert" className="alert alert-success alert-vertical items-start text-left text-sm">
              <span className="font-semibold">
                Converted {result.conversations} chats and {result.projects} projects.
              </span>
              <span>
                {result.memoryFiles} memory files · {result.designChats} design chats ·{' '}
                {result.artifactFiles} artifact files
              </span>
            </div>
          )}
        </Step>

        <Step n={2} title="Pick the target account" done={target !== ''}>
          <WorkspacePicker
            name="claudeai-target"
            workspaces={workspaces}
            loading={workspacesLoading}
            value={target}
            disabled={busy}
            onChange={setTarget}
            onRefresh={onRefreshWorkspaces}
          />
        </Step>

        <Step n={3} title="Import into the target account">
          <ImportAllStep
            owner="claudeai"
            folder={outputDir}
            workspace={target}
            workspaceEmail={targetEmail}
            workspaceNewLayout={targetNewLayout}
          />
        </Step>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// card C: pull the whole claude.ai account (own sign-in window or DevTools)
// ---------------------------------------------------------------------------

const DETECT_POLL_MS = 2000

const CHATS_OPTIONS: readonly { value: PullChatsMode; label: string }[] = [
  { value: 'list', label: 'List only (links chats to projects)' },
  { value: 'full', label: 'Full chat history (slow, large)' },
  { value: 'none', label: 'None' }
]

const PULL_PHASE_LABELS: Record<'typing' | 'waiting' | 'saving', string> = {
  typing: 'Typing the pull script into the DevTools console…',
  waiting: 'Pulling your account in Claude Desktop… (watch the console)',
  saving: 'Saving the download…'
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** "account_files" → "account files". */
function counterLabel(key: string): string {
  return key.replace(/_/g, ' ')
}

function CheckItem({ ok, children }: { ok: boolean | null; children: ReactNode }): JSX.Element {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className={`badge badge-xs mt-1 shrink-0 ${ok === true ? 'badge-success' : ok === false ? 'badge-warning' : 'badge-ghost'}`}
        aria-hidden="true"
      >
        {ok === true ? '✓' : ok === false ? '!' : '·'}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

const SIGNIN_PHASE_LABELS: Record<ClaudeAiPullProgress['phase'], string> = {
  checking: 'Checking your claude.ai sign-in…',
  loading: 'Opening claude.ai in a hidden window…',
  running: 'Pulling your account…',
  saving: 'Saving the pull file…'
}

type PullRoute = 'signin' | 'devtools'

const PULL_ROUTES: readonly { value: PullRoute; label: string }[] = [
  { value: 'signin', label: 'Sign in inside ClaudeLift (recommended)' },
  { value: 'devtools', label: "Use Claude Desktop's DevTools (fallback)" }
]

/** Props both pull routes share: the chats option and the hand-off to convert. */
interface PullRouteProps {
  chats: PullChatsMode
  onChatsChange: (chats: PullChatsMode) => void
  /** Any pull, convert, import or export is running. */
  busy: boolean
  /** Card B's claude.ai export folder ('' when none). */
  exportDir: string
  /** A new pull starts: clear the previous pull and convert results. */
  onPullStart: () => void
  /** The pull file is saved: convert it. */
  onPulled: (file: string, sizeBytes: number) => Promise<void>
}

function ChatsField({
  name,
  value,
  disabled,
  onChange
}: {
  name: string
  value: PullChatsMode
  disabled: boolean
  onChange: (chats: PullChatsMode) => void
}): JSX.Element {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs text-base-content/70">Chats</legend>
      {CHATS_OPTIONS.map((opt) => (
        <label key={opt.value} className="label cursor-pointer justify-start gap-2">
          <input
            type="radio"
            className="radio radio-sm"
            name={name}
            checked={value === opt.value}
            disabled={disabled}
            onChange={() => onChange(opt.value)}
          />
          <span className="text-base-content">{opt.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

function ExportMergeNote({ exportDir }: { exportDir: string }): JSX.Element {
  return (
    <p className="text-xs text-base-content/60">
      {exportDir.trim() !== ''
        ? `Also merges the claude.ai export folder from the card above: ${exportDir.trim()}`
        : 'No claude.ai export folder picked in the card above — only the pulled data is converted.'}
    </p>
  )
}

// -- route 1: sign in inside ClaudeLift (recommended) ------------------------

function SignInPullSteps({ chats, onChatsChange, busy, exportDir, onPullStart, onPulled }: PullRouteProps): JSX.Element {
  const session = useAppStore((s) => s.claudeAiSession)
  const checking = useAppStore((s) => s.claudeAiSessionChecking)
  const pull = useAppStore((s) => s.claudeAiPull)
  const refreshSession = useAppStore((s) => s.refreshClaudeAiSession)
  const signIn = useAppStore((s) => s.claudeAiSignIn)
  const signOut = useAppStore((s) => s.claudeAiSignOut)
  const runClaudeAiPull = useAppStore((s) => s.runClaudeAiPull)
  const cancelClaudeAiPull = useAppStore((s) => s.cancelClaudeAiPull)
  const pushToast = useAppStore((s) => s.pushToast)

  const [pullError, setPullError] = useState<EngineErrorInfo | null>(null)
  const [savedFile, setSavedFile] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  const pulling = pull?.running === true
  const signedIn = session?.signedIn === true
  const lineCount = pull?.lines.length ?? 0

  // Check the sign-in once when this route is shown.
  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  // Keep the newest log line in view.
  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lineCount])

  const run = async (): Promise<void> => {
    setPullError(null)
    setSavedFile(null)
    onPullStart()
    const outcome = await runClaudeAiPull(chats)
    if (!outcome.ok) {
      if (outcome.error.kind === 'aborted') pushToast('info', 'Pull cancelled')
      else {
        setPullError(outcome.error)
        void refreshSession()
      }
      return
    }
    setSavedFile(outcome.result.file)
    await onPulled(outcome.result.file, outcome.result.sizeBytes)
  }

  return (
    <>
      <Step n={1} title="Sign in to claude.ai" done={signedIn}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {session === null || (checking && !signedIn) ? (
            <span className="flex items-center gap-2 text-base-content/60">
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              Checking…
            </span>
          ) : signedIn ? (
            <span className="min-w-0 text-success">
              Signed in{session.orgNames.length > 0 ? `: ${session.orgNames.join(', ')}` : ''}
            </span>
          ) : (
            <span className="text-warning">Not signed in</span>
          )}
        </div>
        {session?.error != null && !signedIn && (
          <p className="text-xs text-warning">{session.error}</p>
        )}
        {session?.signInWindowOpen === true && !signedIn && (
          <p className="text-sm text-base-content/70">
            Sign in in the &ldquo;Sign in to claude.ai&rdquo; window. It closes by itself when you are
            signed in.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`btn btn-sm ${signedIn ? '' : 'btn-primary'}`}
            disabled={pulling}
            onClick={() => void signIn()}
          >
            {signedIn ? 'Sign in again' : 'Sign in'}
          </button>
          {signedIn && (
            <button type="button" className="btn btn-sm" disabled={pulling} onClick={() => void signOut()}>
              Sign out
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={checking || pulling}
            onClick={() => void refreshSession()}
          >
            {checking && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            Check again
          </button>
        </div>
        <p className="text-xs text-base-content/60">
          Your claude.ai sign-in is stored only in ClaudeLift on this PC. Sign out removes it.
        </p>
        <p className="text-xs text-base-content/60">
          If Google sign-in is refused in this window, use the email code option on the claude.ai
          sign-in page, or the DevTools route.
        </p>
      </Step>

      <Step n={2} title="Pull the account" done={savedFile !== null}>
        <ChatsField name="signin-pull-chats" value={chats} disabled={busy} onChange={onChatsChange} />
        <ExportMergeNote exportDir={exportDir} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!signedIn || busy}
            onClick={() => void run()}
          >
            {pulling && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            Run pull
          </button>
          {pulling && (
            <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelClaudeAiPull()}>
              Cancel
            </button>
          )}
          {!signedIn && !pulling && <span className="text-xs text-base-content/60">Sign in first (step 1).</span>}
        </div>

        {pull !== null && pulling && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono tabular-nums">{formatElapsed(pull.elapsedSec)}</span>
              <span className="text-base-content/70">{SIGNIN_PHASE_LABELS[pull.phase]}</span>
              {pull.fileBytes !== null && (
                <span className="badge badge-ghost badge-sm">{formatBytes(pull.fileBytes)}</span>
              )}
            </div>
            <progress className="progress" />
          </div>
        )}
        {pull !== null && pull.lines.length > 0 && (
          <pre
            ref={logRef}
            aria-label="Pull log"
            className="max-h-56 overflow-auto whitespace-pre-wrap rounded-box border border-base-300 bg-base-200 p-2 font-mono text-xs"
          >
            {pull.lines.join('\n')}
          </pre>
        )}

        {pullError !== null && <ErrorAlert error={pullError} />}
        {savedFile !== null && (
          <p className="truncate text-sm text-success" title={savedFile}>
            Saved {savedFile}
          </p>
        )}
      </Step>
    </>
  )
}

// -- route 2: Claude Desktop's DevTools console (fallback) -------------------

function DevToolsPullSteps({ chats, onChatsChange, busy, exportDir, onPullStart, onPulled }: PullRouteProps): JSX.Element {
  const pull = useAppStore((s) => s.consolePull)
  const findClaudeConsole = useAppStore((s) => s.findClaudeConsole)
  const runConsolePull = useAppStore((s) => s.runConsolePull)
  const cancelConsolePull = useAppStore((s) => s.cancelConsolePull)
  const pushToast = useAppStore((s) => s.pushToast)
  const settings = useAppStore((s) => s.settings)

  const [consoleInfo, setConsoleInfo] = useState<ClaudeConsoleInfo | null>(null)
  const [consoleTabConfirmed, setConsoleTabConfirmed] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [pullFile, setPullFile] = useState<string | null>(null)
  const [pullError, setPullError] = useState<EngineErrorInfo | null>(null)
  const [debuggerStatus, setDebuggerStatus] = useState<PushDesktopStatus | null>(null)
  const [checkingDebugger, setCheckingDebugger] = useState(false)

  const pulling = pull?.running === true
  const found = consoleInfo?.found === true
  const supported = consoleInfo?.supported !== false

  // Live detection: poll the (read-only) window probe every 2 s while this
  // route is shown and no pull is driving the window. Sequential, never overlapping.
  useEffect(() => {
    if (pulling) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      const info = await findClaudeConsole()
      if (cancelled) return
      setConsoleInfo(info)
      if (info?.supported !== false) timer = setTimeout(() => void tick(), DETECT_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [pulling, findClaudeConsole])

  // A different window (or none) invalidates the "Console tab" confirmation.
  const consoleTitle = consoleInfo?.title ?? null
  useEffect(() => {
    setConsoleTabConfirmed(false)
    setPreview(null)
  }, [consoleTitle])

  const takePreview = async (): Promise<void> => {
    setPreviewLoading(true)
    try {
      const shot = await window.api.claudeConsoleScreenshot()
      setPreview(shot.png)
      if (shot.png === null) pushToast('info', 'No preview: the DevTools window is closed or minimized')
    } catch (err) {
      pushToast('error', `Preview failed: ${errorText(err)}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  const checkDebugger = async (): Promise<void> => {
    setCheckingDebugger(true)
    try {
      setDebuggerStatus(PushDesktopStatusSchema.parse(await window.api.pushDesktopStatus()))
    } catch (err) {
      setDebuggerStatus({ available: false, detail: errorText(err) })
    } finally {
      setCheckingDebugger(false)
    }
  }

  const run = async (via: 'console' | 'debugger' = 'console'): Promise<void> => {
    setPullError(null)
    setPullFile(null)
    onPullStart()
    const outcome = await runConsolePull(chats, via)
    if (!outcome.ok) {
      if (outcome.error.kind === 'aborted') pushToast('info', 'Pull cancelled')
      else setPullError(outcome.error)
      return
    }
    setPullFile(outcome.result.file)
    await onPulled(outcome.result.file, outcome.result.sizeBytes)
  }

  const canRun = supported && found && consoleTabConfirmed && !busy && settings !== null

  return (
    <>
      {!supported && (
        <div role="alert" className="alert alert-warning text-sm">
          <span>This works only on Windows.</span>
        </div>
      )}

      <Step n={1} title="Open the claude.ai DevTools console" done={found && consoleTabConfirmed}>
        <ul className="flex flex-col gap-1">
          <CheckItem ok={consoleInfo === null ? null : found}>
            In Claude Desktop turn on Developer Mode: Help → Troubleshooting → Enable Developer
            Mode.
          </CheckItem>
          <CheckItem ok={consoleInfo === null ? null : found}>
            Open the claude.ai DevTools: Developer menu → <b>Show All Dev Tools</b> (or click into
            the claude.ai view and press <kbd className="kbd kbd-xs">Ctrl</kbd>+
            <kbd className="kbd kbd-xs">Shift</kbd>+<kbd className="kbd kbd-xs">I</kbd>). Use the
            window titled &ldquo;Developer Tools - https://claude.ai/&hellip;&rdquo;. &ldquo;Show Dev
            Tools&rdquo; (<kbd className="kbd kbd-xs">Ctrl</kbd>+<kbd className="kbd kbd-xs">Alt</kbd>+
            <kbd className="kbd kbd-xs">I</kbd>) only opens the app shell&apos;s DevTools, which
            can&apos;t read your account.
          </CheckItem>
          <CheckItem ok={found ? consoleTabConfirmed : null}>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={consoleTabConfirmed}
                disabled={!found || busy}
                onChange={(e) => setConsoleTabConfirmed(e.target.checked)}
              />
              <span>The Console tab is selected in that DevTools window.</span>
            </label>
          </CheckItem>
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {consoleInfo === null ? (
            <span className="flex items-center gap-2 text-base-content/60">
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              Looking for the DevTools window…
            </span>
          ) : found ? (
            <span className="min-w-0 truncate text-success" title={consoleInfo.title ?? ''}>
              Found: {consoleInfo.title}
              {consoleInfo.minimized ? ' (minimized)' : ''}
            </span>
          ) : (
            <span className="text-warning">
              {consoleInfo.shellOnly
                ? 'Only the app shell DevTools is open (file:///…). Use Developer → Show All Dev Tools to open the claude.ai one.'
                : 'Not found'}
            </span>
          )}
          {found && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={previewLoading || pulling}
              onClick={() => void takePreview()}
            >
              {previewLoading && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Show preview
            </button>
          )}
        </div>
        {preview !== null && !pulling && (
          <img
            src={`data:image/png;base64,${preview}`}
            alt="Preview of the DevTools window"
            className="max-h-64 w-full rounded-box border border-base-300 object-contain object-left-top"
          />
        )}
        {!found && consoleInfo !== null && (
          <div className="flex flex-col gap-2 rounded-box border border-base-300 p-2 text-sm">
            <span className="whitespace-normal">
              No window found, or the DevTools window has no title? Use Claude Desktop&apos;s Main
              Process Debugger instead: Developer menu → <b>Enable Main Process Debugger</b>. Then
              ClaudeLift runs the pull in the claude.ai page directly, with no typing.
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={checkingDebugger || busy}
                onClick={() => void checkDebugger()}
              >
                {checkingDebugger && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                Check debugger
              </button>
              {debuggerStatus !== null && (
                <span className={debuggerStatus.available ? 'text-success' : 'text-warning'}>{debuggerStatus.detail}</span>
              )}
              {debuggerStatus?.available === true && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  disabled={busy || settings === null}
                  onClick={() => void run('debugger')}
                >
                  Run pull through the debugger
                </button>
              )}
            </div>
          </div>
        )}
      </Step>

      <Step n={2} title="Pull the account" done={pullFile !== null}>
        <ChatsField name="devtools-pull-chats" value={chats} disabled={busy} onChange={onChatsChange} />
        <ExportMergeNote exportDir={exportDir} />
        <div role="alert" className="alert alert-warning text-sm">
          <span className="whitespace-normal">
            ClaudeLift will bring the DevTools window to the front and type into it. Don&apos;t
            type in that window until it finishes.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={!canRun} onClick={() => void run('console')}>
            {pulling && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            Run pull
          </button>
          {pulling && (
            <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelConsolePull()}>
              Cancel
            </button>
          )}
          {!pulling && !canRun && !busy && (
            <span className="text-xs text-base-content/60">Finish step 1 first.</span>
          )}
        </div>

        {pull !== null && pulling && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono tabular-nums">{formatElapsed(pull.elapsedSec)}</span>
              <span className="text-base-content/70">{PULL_PHASE_LABELS[pull.phase]}</span>
              {pull.fileBytes !== null && (
                <span className="badge badge-ghost badge-sm">{formatBytes(pull.fileBytes)}</span>
              )}
            </div>
            <progress className="progress" />
            {pull.screenshot !== null && (
              <img
                src={`data:image/png;base64,${pull.screenshot}`}
                alt="Live view of the DevTools console"
                className="max-h-80 w-full rounded-box border border-base-300 object-contain object-left-top"
              />
            )}
          </div>
        )}

        {pullError !== null && <ErrorAlert error={pullError} />}
        {pullFile !== null && (
          <p className="truncate text-sm text-success" title={pullFile}>
            Saved {pullFile}
          </p>
        )}
      </Step>
    </>
  )
}

// -- the card: route tabs, then the shared convert → target → import steps ---

function ClaudeAccountPullCard({
  workspaces,
  workspacesLoading,
  onRefreshWorkspaces,
  exportDir
}: {
  workspaces: WorkspaceInfo[]
  workspacesLoading: boolean
  onRefreshWorkspaces: () => void
  /** Card B's claude.ai export folder ('' when none) — merged into the conversion. */
  exportDir: string
}): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const migrateJob = useAppStore((s) => s.migrateJob)
  const exportRunning = useAppStore((s) => s.exportRunning)
  const consolePulling = useAppStore((s) => s.consolePull?.running === true)
  const sessionPulling = useAppStore((s) => s.claudeAiPull?.running === true)
  const convertEvents = useAppStore((s) => s.convertProgress)
  const runConvertClaudeAi = useAppStore((s) => s.runConvertClaudeAi)
  const cancelMigrate = useAppStore((s) => s.cancelMigrate)
  const pushToast = useAppStore((s) => s.pushToast)

  const [route, setRoute] = useState<PullRoute>('signin')
  const [chats, setChats] = useState<PullChatsMode>('list')
  const [pullFile, setPullFile] = useState<string | null>(null)
  const [convertResult, setConvertResult] = useState<ConvertResult | null>(null)
  const [convertError, setConvertError] = useState<EngineErrorInfo | null>(null)
  const [target, setTarget] = useState('')
  /** This pull's own output folder (`<outputDir>\claude-account\<stamp>`).
   *  The engine never clears its output, so a shared folder would keep the
   *  bundles of earlier pulls and the import would bring back stale chats. */
  const [runDir, setRunDir] = useState<string | null>(null)

  const pulling = consolePulling || sessionPulling
  const converting = migrateJob?.kind === 'convert' && migrateJob.owner === 'account'
  const busy = pulling || migrateJob !== null || exportRunning
  const accountDir = settings !== null ? childPath(settings.outputDir, 'claude-account') : ''

  const convert = async (file: string): Promise<void> => {
    setConvertResult(null)
    setConvertError(null)
    if (accountDir === '') {
      pushToast('error', 'Settings are not loaded yet. Try again in a moment.')
      return
    }
    // A fresh folder for every conversion, so no old bundles get mixed in.
    const outputDir = childPath(accountDir, runStamp())
    setRunDir(outputDir)
    const hasExport = exportDir.trim() !== ''
    // Chats come from the export (with their project links from the pull's
    // chat list) and/or from a full-history pull.
    const what: ClaudeAiPart[] = ['projects', 'memory', 'account']
    if (hasExport || chats === 'full') what.push('conversations')
    if (hasExport) what.push('design')
    const outcome = await runConvertClaudeAi(
      {
        // No export folder: the engine reads only --pull. (Never pass the
        // Downloads folder as the export — it would open every zip in it.)
        exportDir: hasExport ? exportDir.trim() : undefined,
        outputDir,
        what,
        formats: ['md'],
        pull: [file]
      },
      'account'
    )
    if (outcome.ok) setConvertResult(outcome.result)
    else if (outcome.error.kind !== 'aborted') setConvertError(outcome.error)
  }

  const onPullStart = (): void => {
    setPullFile(null)
    setRunDir(null)
    setConvertResult(null)
    setConvertError(null)
  }

  const onPulled = async (file: string, sizeBytes: number): Promise<void> => {
    setPullFile(file)
    pushToast('success', `Account pulled (${formatBytes(sizeBytes)}) — converting…`)
    await convert(file)
  }

  const openOutput = async (): Promise<void> => {
    try {
      await window.api.claudeConsoleOpenOutput({ dir: convertResult?.output ?? runDir ?? accountDir })
    } catch (err) {
      pushToast('error', `Could not open the folder: ${errorText(err)}`)
    }
  }

  const convertProgress = useMemo(() => {
    let projects = 0
    let current = ''
    for (const evt of convertEvents) {
      if (evt.event === 'project_done') {
        projects += 1
        current = evt.name ?? evt.uuid
      }
    }
    return { projects, current }
  }, [convertEvents])

  const targetEmail = workspaces.find((ws) => ws.path === target)?.email ?? null
  const targetNewLayout = workspaces.find((ws) => ws.path === target)?.newLayout === true
  const routeProps: PullRouteProps = { chats, onChatsChange: setChats, busy, exportDir, onPullStart, onPulled }

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">Pull your whole claude.ai account</h2>
          <p className="text-sm text-base-content/70">
            Projects with their uploaded files, your profile, memory, skills list and chat list —
            read straight from your signed-in claude.ai session. No data export email needed.
          </p>
        </div>

        <div role="tablist" aria-label="How to pull" className="tabs tabs-box tabs-sm self-start">
          {PULL_ROUTES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="tab"
              aria-selected={route === r.value}
              className={`tab ${route === r.value ? 'tab-active' : ''}`}
              disabled={pulling && route !== r.value}
              onClick={() => setRoute(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {route === 'signin' ? <SignInPullSteps {...routeProps} /> : <DevToolsPullSteps {...routeProps} />}

        <Step n={3} title="Convert into bundles" done={convertResult !== null}>
          <p className="truncate font-mono text-xs text-base-content/60" title={runDir ?? accountDir}>
            Output: {runDir ?? childPath(accountDir, '<date-time of this pull>')}
          </p>
          {converting && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <progress className="progress flex-1" />
                <span className="text-sm tabular-nums text-base-content/70">
                  {convertProgress.projects} projects
                </span>
                <button type="button" className="btn btn-error btn-xs" onClick={() => void cancelMigrate()}>
                  Cancel
                </button>
              </div>
              {convertProgress.current !== '' && (
                <span className="truncate text-xs text-base-content/60" title={convertProgress.current}>
                  {convertProgress.current}
                </span>
              )}
            </div>
          )}
          {convertError !== null && <ErrorAlert error={convertError} />}
          {pullFile !== null && !converting && convertResult === null && (
            <button
              type="button"
              className="btn btn-sm self-start"
              disabled={busy}
              onClick={() => void convert(pullFile)}
            >
              Convert again
            </button>
          )}
          {convertResult !== null && (
            <div role="alert" className="alert alert-success alert-vertical items-start text-left text-sm">
              <span className="font-semibold">
                Converted {convertResult.projects} projects and {convertResult.memoryFiles} memory files.
              </span>
              {(convertResult.conversations > 0 || Object.keys(convertResult.extra).length > 0) && (
                <span>
                  {[
                    ...(convertResult.conversations > 0 ? [`${convertResult.conversations} chats`] : []),
                    ...Object.entries(convertResult.extra).map(([k, v]) => `${v} ${counterLabel(k)}`)
                  ].join(' · ')}
                </span>
              )}
              <button type="button" className="btn btn-sm" onClick={() => void openOutput()}>
                Open output folder
              </button>
            </div>
          )}
        </Step>

        <Step n={4} title="Pick the target account" done={target !== ''}>
          <WorkspacePicker
            name="account-target"
            workspaces={workspaces}
            loading={workspacesLoading}
            value={target}
            disabled={busy}
            onChange={setTarget}
            onRefresh={onRefreshWorkspaces}
          />
        </Step>

        <Step n={5} title="Import into the target account">
          <ImportAllStep
            owner="account"
            folder={convertResult?.output ?? runDir ?? ''}
            workspace={target}
            workspaceEmail={targetEmail}
            workspaceNewLayout={targetNewLayout}
          />
        </Step>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// card D: rebuild projects in a new-layout account (docs/NEW-LAYOUT-SPEC.md)
// ---------------------------------------------------------------------------

const PUSH_EXECUTORS: readonly { value: PushExecutor; label: string }[] = [
  { value: 'claudeai', label: 'Sign in inside ClaudeLift (recommended)' },
  { value: 'desktop', label: 'Claude Desktop (Main Process Debugger)' }
]

const PUSH_PHASE_LABELS: Record<PushProgress['phase'], string> = {
  account: 'Checking the account',
  checking: 'Checking',
  create: 'Creating the project',
  instructions: 'Instructions',
  library: 'Library files',
  memory: 'Memory notes',
  verify: 'Reading back',
  done: 'Done'
}

const KIND_LABELS: Record<string, string> = {
  'claude-project': 'project',
  'cowork-space': 'Cowork space',
  'cowork-history': 'Cowork history',
  'chat-history': 'chat history',
  'account-memory': 'account memory'
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function ipcErrorInfo(err: unknown): EngineErrorInfo {
  return parseIpcError(err) ?? { kind: 'crash', message: errorText(err) }
}

function CheckField({
  checked,
  disabled,
  onChange,
  children
}: {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}): JSX.Element {
  return (
    <label className="label cursor-pointer justify-start gap-2">
      <input
        type="checkbox"
        className="checkbox checkbox-sm"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="whitespace-normal text-base-content">{children}</span>
    </label>
  )
}

function RebuildProjectsCard(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.claudeAiSession)
  const refreshSession = useAppStore((s) => s.refreshClaudeAiSession)
  const signIn = useAppStore((s) => s.claudeAiSignIn)
  const signOut = useAppStore((s) => s.claudeAiSignOut)
  const pullRunning = useAppStore((s) => s.claudeAiPull?.running === true)
  const push = useAppStore((s) => s.push)
  const runPush = useAppStore((s) => s.runPush)
  const cancelPush = useAppStore((s) => s.cancelPush)

  const [source, setSource] = useState('')
  const [bundles, setBundles] = useState('')
  const [includeChats, setIncludeChats] = useState(true)
  const [includeUnfiled, setIncludeUnfiled] = useState(false)
  const [includeAccountMemory, setIncludeAccountMemory] = useState(true)
  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<PushPlanSummary | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [planError, setPlanError] = useState<EngineErrorInfo | null>(null)

  const [executor, setExecutor] = useState<PushExecutor>('claudeai')
  const [desktop, setDesktop] = useState<PushDesktopStatus | null>(null)
  const [account, setAccount] = useState<PushAccount | null>(null)
  const [checkingAccount, setCheckingAccount] = useState(false)
  const [accountError, setAccountError] = useState<EngineErrorInfo | null>(null)

  const [dryRun, setDryRun] = useState(true)
  const running = push?.running === true
  const progress = push?.progress ?? null
  const log = push?.log ?? []
  const result = push?.result ?? null
  const runError = push?.error ?? null
  const logRef = useRef<HTMLPreElement | null>(null)

  // Default source: the converted account folder under the output folder.
  useEffect(() => {
    if (settings !== null && source === '') setSource(childPath(settings.outputDir, 'claude-account'))
  }, [settings, source])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [log.length])

  const checkDesktop = useCallback(async (): Promise<void> => {
    try {
      setDesktop(PushDesktopStatusSchema.parse(await window.api.pushDesktopStatus()))
    } catch (err) {
      setDesktop({ available: false, detail: errorText(err) })
    }
  }, [])

  useEffect(() => {
    if (executor === 'desktop') void checkDesktop()
  }, [executor, checkDesktop])

  // A different route or sign-in can mean a different account: check again.
  useEffect(() => {
    setAccount(null)
    setAccountError(null)
  }, [executor, session?.signedIn])

  const makePlan = async (): Promise<void> => {
    setPlanning(true)
    setPlanError(null)
    setPlan(null)
    try {
      const summary = PushPlanSummarySchema.parse(
        await window.api.pushPlan({
          source: source.trim(),
          ...(bundles.trim() !== '' ? { coworkBundles: bundles.trim() } : {}),
          includeChats,
          includeUnfiledChats: includeUnfiled,
          includeAccountMemory,
          orgs: []
        })
      )
      setPlan(summary)
      setSelected(new Set(summary.projects.map((p) => p.key)))
    } catch (err) {
      setPlanError(ipcErrorInfo(err))
    } finally {
      setPlanning(false)
    }
  }

  const checkAccount = async (): Promise<void> => {
    setCheckingAccount(true)
    setAccountError(null)
    setAccount(null)
    try {
      setAccount(PushAccountSchema.parse(await window.api.pushAccount({ executor })))
    } catch (err) {
      setAccountError(ipcErrorInfo(err))
    } finally {
      setCheckingAccount(false)
    }
  }

  const run = async (): Promise<void> => {
    if (plan === null) return
    await runPush({
      planFile: plan.planFile,
      keys: plan.projects.filter((p) => selected.has(p.key)).map((p) => p.key),
      executor,
      dryRun,
      expectEmail: account?.email ?? null
    })
  }

  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const existing = useMemo(
    () => new Set((account?.projectNames ?? []).map((n) => n.trim().toLowerCase())),
    [account]
  )
  const chosen = plan?.projects.filter((p) => selected.has(p.key)) ?? []
  const totals = chosen.reduce(
    (acc, p) => ({
      files: acc.files + p.counts.docs + p.counts.files + p.counts.chats + p.counts.cowork,
      memory: acc.memory + p.counts.memory,
      bytes: acc.bytes + p.counts.bytes
    }),
    { files: 0, memory: 0, bytes: 0 }
  )
  const signedIn = session?.signedIn === true
  const routeReady = executor === 'claudeai' ? signedIn : desktop?.available === true
  const canWrite = account !== null && account.email !== null
  const busy = planning || running || checkingAccount || pullRunning
  const hasProblems = (r: PushRunResult): boolean =>
    r.projects.some((p) => p.error !== null || p.library.failed.length + p.memory.failed.length > 0)

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">Rebuild projects in the new account</h2>
          <p className="text-sm text-base-content/70">
            For accounts with the new layout (projects hold threads, and everything lives in the
            cloud). ClaudeLift makes each project with its instructions, files, old chats and memory.
            It never deletes or replaces anything, and it skips projects whose name is already there.
          </p>
        </div>

        <Step n={1} title="Make the plan" done={plan !== null}>
          <FolderField
            label="Saved account folder (from card C: has projects, account and conversations folders)"
            value={source}
            purpose="Choose the converted claude.ai account folder"
            disabled={busy}
            onChange={setSource}
          />
          <FolderField
            label="Cowork task bundles (optional: the folder card A exported to)"
            value={bundles}
            purpose="Choose the folder with exported Cowork task bundles"
            disabled={busy}
            onChange={setBundles}
          />
          <div className="flex flex-col gap-1">
            <CheckField checked={includeChats} disabled={busy} onChange={setIncludeChats}>
              Old chats of each project (into its Library, chats folder)
            </CheckField>
            <CheckField checked={includeUnfiled} disabled={busy} onChange={setIncludeUnfiled}>
              Chats in no project (a &ldquo;Chat history (imported)&rdquo; project)
            </CheckField>
            <CheckField checked={includeAccountMemory} disabled={busy} onChange={setIncludeAccountMemory}>
              Account memory (an &ldquo;Account memory (imported)&rdquo; project)
            </CheckField>
          </div>
          <button
            type="button"
            className="btn btn-sm self-start"
            disabled={busy || source.trim() === ''}
            onClick={() => void makePlan()}
          >
            {planning && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            Make plan
          </button>
          {planError !== null && <ErrorAlert error={planError} />}
          {plan !== null && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  {chosen.length} of {plan.projects.length} projects chosen · {totals.files} Library files ·{' '}
                  {totals.memory} memory notes · {mb(totals.bytes)} MB
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={busy}
                  onClick={() => setSelected(new Set(plan.projects.map((p) => p.key)))}
                >
                  All
                </button>
                <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setSelected(new Set())}>
                  None
                </button>
              </div>
              <div className="max-h-80 overflow-auto rounded-box border border-base-300">
                <table className="table table-xs table-pin-rows">
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">Chosen</span>
                      </th>
                      <th>Project</th>
                      <th className="text-right">Docs</th>
                      <th className="text-right">Files</th>
                      <th className="text-right">Chats</th>
                      <th className="text-right">Cowork</th>
                      <th className="text-right">Memory</th>
                      <th className="text-right">MB</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.projects.map((p) => (
                      <tr key={p.key}>
                        <td>
                          <input
                            type="checkbox"
                            className="checkbox checkbox-xs"
                            aria-label={`Rebuild ${p.name}`}
                            checked={selected.has(p.key)}
                            disabled={busy}
                            onChange={() => toggle(p.key)}
                          />
                        </td>
                        <td className="max-w-56">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="truncate font-medium" title={p.name}>
                              {p.name}
                            </span>
                            <span className="badge badge-ghost badge-xs">{KIND_LABELS[p.kind] ?? p.kind}</span>
                            {existing.has(p.name.trim().toLowerCase()) && (
                              <span
                                className="badge badge-warning badge-xs"
                                title="A project with this name is in the account. It will be skipped."
                              >
                                exists
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-right tabular-nums">{p.counts.docs}</td>
                        <td className="text-right tabular-nums">{p.counts.files}</td>
                        <td className="text-right tabular-nums">{p.counts.chats}</td>
                        <td className="text-right tabular-nums">{p.counts.cowork}</td>
                        <td className="text-right tabular-nums">{p.counts.memory}</td>
                        <td className="text-right tabular-nums">{mb(p.counts.bytes)}</td>
                        <td>
                          {p.warnings.length > 0 && (
                            <span className="badge badge-info badge-xs" title={p.warnings.join('\n')}>
                              {p.warnings.length} {p.warnings.length === 1 ? 'note' : 'notes'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.skipped.length > 0 && (
                <p className="text-xs text-base-content/60">Left out (empty): {plan.skipped.join(', ')}</p>
              )}
              <p className="text-xs text-base-content/60">
                API keys and tokens are removed from memory notes and text files before upload.
              </p>
            </div>
          )}
        </Step>

        <Step n={2} title="Check the new account" done={account !== null}>
          <div role="tablist" aria-label="Where to run" className="tabs tabs-box tabs-sm self-start">
            {PUSH_EXECUTORS.map((r) => (
              <button
                key={r.value}
                type="button"
                role="tab"
                aria-selected={executor === r.value}
                className={`tab ${executor === r.value ? 'tab-active' : ''}`}
                disabled={busy}
                onClick={() => setExecutor(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {executor === 'claudeai' ? (
            <div className="flex flex-col gap-2 text-sm">
              <span className={signedIn ? 'text-success' : 'text-warning'}>
                {signedIn
                  ? `ClaudeLift is signed in to claude.ai${session.orgNames.length > 0 ? `: ${session.orgNames.join(', ')}` : ''}.`
                  : 'ClaudeLift is not signed in to claude.ai.'}
              </span>
              <p className="text-xs text-base-content/60">
                Sign in as the NEW account. If you pulled the old account here (card C), sign out
                first, then sign in again.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void signIn()}>
                  {signedIn ? 'Sign in again' : 'Sign in'}
                </button>
                {signedIn && (
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void signOut()}>
                    Sign out
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <span className={desktop?.available === true ? 'text-success' : 'text-warning'}>
                {desktop === null ? 'Checking…' : desktop.detail}
              </span>
              <p className="text-xs text-base-content/60">
                Claude Desktop must be signed in to the new account. Turn the debugger off again when
                you are done (or restart Claude Desktop).
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm self-start"
                disabled={busy}
                onClick={() => void checkDesktop()}
              >
                Check again
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn btn-sm self-start"
            disabled={busy || !routeReady}
            onClick={() => void checkAccount()}
          >
            {checkingAccount && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            Check account
          </button>
          {accountError !== null && <ErrorAlert error={accountError} />}
          {account !== null && (
            <div role="status" className="alert alert-vertical items-start text-left text-sm">
              <span>
                Account: <span className="font-semibold">{account.email ?? 'unknown email'}</span>
                {account.orgName !== null ? ` · ${account.orgName}` : ''}
              </span>
              <span className="whitespace-normal">
                {account.projectNames.length} {account.projectNames.length === 1 ? 'project' : 'projects'} there now
                {account.projectNames.length > 0
                  ? `: ${account.projectNames.slice(0, 8).join(', ')}${account.projectNames.length > 8 ? '…' : ''}`
                  : ''}
              </span>
              {account.email === null && (
                <span className="text-warning">ClaudeLift could not read the email, so it can only do a dry run.</span>
              )}
            </div>
          )}
        </Step>

        <Step n={3} title="Rebuild" done={result !== null && !result.dryRun && !hasProblems(result)}>
          <label className="label cursor-pointer justify-start gap-2">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={dryRun}
              disabled={busy}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <span className="text-base-content">Dry run (only check, write nothing)</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${dryRun ? 'btn-primary' : 'btn-warning'}`}
              disabled={busy || plan === null || chosen.length === 0 || !routeReady || (!dryRun && !canWrite)}
              onClick={() => void run()}
            >
              {running && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              {dryRun
                ? `Dry run (${chosen.length} projects)`
                : `Write ${chosen.length} projects to ${account?.email ?? '…'}`}
            </button>
            {running && (
              <button type="button" className="btn btn-error btn-sm" onClick={() => void cancelPush()}>
                Cancel
              </button>
            )}
            {!dryRun && !canWrite && (
              <span className="text-xs text-base-content/60">Check the account first (step 2).</span>
            )}
          </div>

          {running && progress !== null && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {progress.total > 0 && progress.index > 0 && (
                  <span className="tabular-nums">
                    {progress.index}/{progress.total}
                  </span>
                )}
                <span className="truncate font-medium">{progress.name ?? ''}</span>
                <span className="text-base-content/70">{PUSH_PHASE_LABELS[progress.phase]}</span>
                {progress.of > 0 && (
                  <span className="tabular-nums text-base-content/70">
                    {progress.done}/{progress.of}
                  </span>
                )}
              </div>
              {progress.of > 0 ? (
                <progress className="progress" value={progress.done} max={progress.of} />
              ) : (
                <progress className="progress" />
              )}
            </div>
          )}
          {log.length > 0 && (
            <pre
              ref={logRef}
              aria-label="Push log"
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded-box border border-base-300 bg-base-200 p-2 font-mono text-xs"
            >
              {log.join('\n')}
            </pre>
          )}
          {runError !== null && <ErrorAlert error={runError} />}

          {result !== null && (
            <div className="flex flex-col gap-2">
              <div
                role="alert"
                className={`alert alert-vertical items-start text-left text-sm ${
                  hasProblems(result) ? 'alert-warning' : 'alert-success'
                }`}
              >
                <span className="font-semibold">
                  {result.dryRun ? 'Dry run — nothing written. ' : ''}
                  {result.cancelled ? 'Cancelled. ' : ''}
                  {result.projects.filter((p) => p.action === 'create').length} to create ·{' '}
                  {result.projects.filter((p) => p.action === 'resume').length} to finish ·{' '}
                  {result.projects.filter((p) => p.action === 'skip').length} skipped (
                  {result.account.email ?? 'unknown account'})
                </span>
                <span className="max-w-full truncate font-mono text-xs" title={result.receiptFile}>
                  Receipt: {result.receiptFile}
                </span>
              </div>
              <div className="max-h-80 overflow-auto rounded-box border border-base-300">
                <table className="table table-xs table-pin-rows">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Action</th>
                      <th className="text-right">Files</th>
                      <th className="text-right">Memory</th>
                      <th>Problems</th>
                      <th>
                        <span className="sr-only">Link</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.projects.map((p) => {
                      const failed = [...p.library.failed, ...p.memory.failed]
                      return (
                        <tr key={p.key}>
                          <td className="max-w-56 truncate" title={p.name}>
                            {p.name}
                          </td>
                          <td>
                            <span
                              className={`badge badge-xs ${p.action === 'skip' ? 'badge-ghost' : 'badge-primary'}`}
                              title={p.reason ?? ''}
                            >
                              {p.action}
                            </span>
                          </td>
                          <td className="text-right tabular-nums">
                            {result.dryRun
                              ? p.library.planned
                              : `${p.library.written + p.library.existing}/${p.library.planned}`}
                          </td>
                          <td className="text-right tabular-nums">
                            {result.dryRun ? p.memory.planned : `${p.memory.written + p.memory.existing}/${p.memory.planned}`}
                          </td>
                          <td className="max-w-64">
                            {p.error !== null && <span className="text-error">{p.error}</span>}
                            {failed.length > 0 && (
                              <span
                                className="badge badge-warning badge-xs"
                                title={failed.map((f) => `${f.path}: ${f.error ?? f.status ?? f.step}`).join('\n')}
                              >
                                {failed.length} failed
                              </span>
                            )}
                          </td>
                          <td>
                            {p.url !== null && (
                              <a className="link text-xs" href={p.url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {result.dryRun && (
                <p className="text-xs text-base-content/60">
                  Turn off Dry run and press Write to make the projects. You can run it again at any
                  time: done projects are skipped and unfinished ones are completed.
                </p>
              )}
            </div>
          )}
        </Step>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

export default function MigrateView(): JSX.Element {
  const listWorkspaces = useAppStore((s) => s.listWorkspaces)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [claudeAiExportDir, setClaudeAiExportDir] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    const found = await listWorkspaces() // toasts on failure, returns []
    // Most recently used account first.
    setWorkspaces([...found].sort((a, b) => b.lastActivityMs - a.lastActivityMs))
    setLoading(false)
  }, [listWorkspaces])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Migrate</h1>
        <p className="text-sm text-base-content/70">
          Move chats into a different Claude account&apos;s Cowork.
        </p>
      </div>

      <div role="note" className="alert alert-info alert-vertical items-start text-left text-sm sm:alert-horizontal">
        <ol className="list-inside list-decimal space-y-0.5">
          <li>Sign in to the target account in Claude Desktop once, so its folder exists.</li>
          <li>Quit Claude Desktop before you import: tray icon → right-click → Quit.</li>
          <li>Start Claude Desktop again after the import to see the chats.</li>
        </ol>
      </div>

      <CoworkMoveCard
        workspaces={workspaces}
        workspacesLoading={loading}
        onRefreshWorkspaces={() => void refresh()}
      />
      <ClaudeAiImportCard
        workspaces={workspaces}
        workspacesLoading={loading}
        onRefreshWorkspaces={() => void refresh()}
        exportDir={claudeAiExportDir}
        onExportDirChange={setClaudeAiExportDir}
      />
      <ClaudeAccountPullCard
        workspaces={workspaces}
        workspacesLoading={loading}
        onRefreshWorkspaces={() => void refresh()}
        exportDir={claudeAiExportDir}
      />
      <RebuildProjectsCard />
    </div>
  )
}
