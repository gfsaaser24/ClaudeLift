/**
 * Export configuration + progress modal (Task 11).
 *
 * Open-controlled daisyUI modal (`modal-open` driven by props.open).
 * Three phases:
 * - config: format toggles (≥1 enforced — the last enabled toggle is
 *   disabled with a tooltip), Skip files / Include auth / Purge option
 *   toggles with guarded destructive confirms (include-auth → warning
 *   acknowledgment, purge → typed DELETE; Cancel reverts the toggle),
 *   output-dir row with Browse, Cancel/Export footer.
 * - running: overall progress bar + per-task rows driven by the
 *   evt:exportProgress events the store accumulates (✓ done, ⚠ skipped
 *   with the reason in a tooltip, spinner for the current task), and a
 *   btn-error Cancel wired to tasks:exportCancel.
 * - done: reached only when the batch actually exported ≥1 task —
 *   success alert when everything exported, warning summary when some
 *   tasks were skipped/failed; "Open output folder" + Close (refreshes
 *   bundles). A cancelled/failed/nothing-exported run drops back to the
 *   config phase (the store toasts the failure).
 *
 * Prop contract is BINDING: callers (TasksView, tray-driven open) build
 * against ExportModalProps exactly as declared here.
 */
import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { PickFolderResultSchema } from '../../shared/ipc'
import type {
  CoworkTask,
  ExportFormat,
  ExportOptions,
  ProgressEvent
} from '../../shared/ipc'
import { EXPORT_BATCH_KEY, errorText, useAppStore } from '../store'
import ConfirmDangerModal from './ConfirmDangerModal'

export interface ExportModalProps {
  open: boolean
  tasks: CoworkTask[]
  onClose: () => void
}

const FORMATS: readonly ExportFormat[] = ['html', 'md', 'json', 'csv']

const FORMAT_LABELS: Record<ExportFormat, string> = {
  html: 'HTML',
  md: 'Markdown',
  json: 'JSON',
  csv: 'CSV'
}

/** How many task titles the header lists before collapsing to "+N more". */
const HEADER_TITLES_SHOWN = 3

type Phase = 'config' | 'running' | 'done'
type DangerKind = 'auth' | 'purge' | null
type TaskRowState = 'pending' | 'running' | 'done' | 'skipped'

interface TaskRow {
  task: CoworkTask
  state: TaskRowState
  reason: string
}

/**
 * Fold the store's per-task evt:exportProgress arrays into row states,
 * a completed count (done + skipped), and the batch total announced by
 * the engine's task_start events (null before the first one arrives).
 */
function deriveProgress(
  tasks: CoworkTask[],
  progress: Record<string, ProgressEvent[]>
): { rows: TaskRow[]; completed: number; totalFromEvents: number | null } {
  let totalFromEvents: number | null = null
  let completed = 0
  const rows = tasks.map((task) => {
    let state: TaskRowState = 'pending'
    let reason = ''
    for (const evt of progress[task.taskId] ?? []) {
      switch (evt.event) {
        case 'task_start':
          totalFromEvents = evt.total
          if (state === 'pending') state = 'running'
          break
        case 'task_done':
          state = 'done'
          break
        case 'task_skipped':
          state = 'skipped'
          reason = evt.reason
          break
        case 'purged':
        case 'done':
          break
      }
    }
    if (state === 'done' || state === 'skipped') completed += 1
    return { task, state, reason }
  })
  return { rows, completed, totalFromEvents }
}

/** ✓ done · ⚠ skipped (reason tooltip) · spinner running · dot pending. */
function StatusGlyph({ state, reason }: { state: TaskRowState; reason: string }): JSX.Element {
  switch (state) {
    case 'done':
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0 text-success"
          role="img"
          aria-label="Exported"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
    case 'skipped':
      return (
        <span
          className="tooltip tooltip-right shrink-0"
          data-tip={reason !== '' ? reason : 'Skipped'}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 text-warning"
            role="img"
            aria-label="Skipped"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        </span>
      )
    case 'running':
      return (
        <span
          className="loading loading-spinner loading-xs shrink-0"
          role="img"
          aria-label="Exporting"
        />
      )
    case 'pending':
      return <span className="status shrink-0" role="img" aria-label="Queued" />
  }
}

interface OptionToggleProps {
  label: ReactNode
  hint?: string
  checked: boolean
  disabled?: boolean
  /** Tooltip explaining WHY the toggle is disabled (shown only then). */
  disabledTip?: string
  onChange: (checked: boolean) => void
}

function OptionToggle({
  label,
  hint,
  checked,
  disabled = false,
  disabledTip,
  onChange
}: OptionToggleProps): JSX.Element {
  const input = (
    <input
      type="checkbox"
      className="toggle toggle-sm"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
  return (
    <label className="label cursor-pointer justify-start gap-3">
      {disabled && disabledTip !== undefined ? (
        <span className="tooltip tooltip-right" data-tip={disabledTip}>
          {input}
        </span>
      ) : (
        input
      )}
      <span className="flex min-w-0 flex-col items-start">
        <span className="text-base-content">{label}</span>
        {hint !== undefined && (
          <span className="text-xs text-base-content/60">{hint}</span>
        )}
      </span>
    </label>
  )
}

export default function ExportModal(props: ExportModalProps): JSX.Element {
  const { open, tasks, onClose } = props

  const settings = useAppStore((s) => s.settings)
  const exportProgress = useAppStore((s) => s.exportProgress)
  const exportRunning = useAppStore((s) => s.exportRunning)
  const runExport = useAppStore((s) => s.runExport)
  const cancelExport = useAppStore((s) => s.cancelExport)
  const refreshBundles = useAppStore((s) => s.refreshBundles)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const pushToast = useAppStore((s) => s.pushToast)

  const [phase, setPhase] = useState<Phase>('config')
  const [formats, setFormats] = useState<ExportFormat[]>([...FORMATS])
  const [noFiles, setNoFiles] = useState(false)
  const [includeAuth, setIncludeAuth] = useState(false)
  const [purgeSource, setPurgeSource] = useState(false)
  const [danger, setDanger] = useState<DangerKind>(null)
  const [exportedDir, setExportedDir] = useState('')

  // Re-arm the form on every open: formats default from settings, both
  // danger options off, back to the config phase.
  useEffect(() => {
    if (!open) return
    const stored = useAppStore.getState().settings
    const defaults = FORMATS.filter(
      (f) => stored?.formats.includes(f) ?? false
    )
    setFormats(defaults.length > 0 ? defaults : [...FORMATS])
    setNoFiles(false)
    setIncludeAuth(false)
    setPurgeSource(false)
    setDanger(null)
    setPhase('config')
  }, [open])

  // Escape closes the modal — but never while an export is running, and
  // not while a ConfirmDangerModal is stacked on top (it owns Escape).
  useEffect(() => {
    if (!open || danger !== null || phase === 'running') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (phase === 'done') void refreshBundles()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, danger, phase, onClose, refreshBundles])

  const closeModal = (): void => {
    if (phase === 'done') void refreshBundles()
    onClose()
  }

  const toggleFormat = (format: ExportFormat): void => {
    setFormats((cur) => {
      if (!cur.includes(format)) {
        return FORMATS.filter((f) => f === format || cur.includes(f))
      }
      if (cur.length === 1) return cur // ≥1 format always enforced
      return cur.filter((f) => f !== format)
    })
  }

  const handleBrowse = async (): Promise<void> => {
    try {
      const dir = PickFolderResultSchema.parse(
        await window.api.appPickFolder({ purpose: 'export-output' })
      )
      if (dir !== null) await patchSettings({ outputDir: dir })
    } catch (err) {
      pushToast('error', `Folder picker failed: ${errorText(err)}`)
    }
  }

  const handleExport = async (): Promise<void> => {
    const stored = useAppStore.getState().settings
    if (stored === null || formats.length === 0 || tasks.length === 0) return
    const opts: ExportOptions = {
      taskIds: tasks.map((t) => t.taskId),
      outputDir: stored.outputDir,
      formats: [...formats],
      noFiles,
      includeAuth,
      purgeSource,
      source: stored.source,
      ...(stored.coworkRootOverride !== null
        ? { coworkRoot: stored.coworkRootOverride }
        : {})
    }
    setExportedDir(stored.outputDir)
    setPhase('running')
    const ok = await runExport(opts) // store handles success/cancel/error toasts
    const batch =
      useAppStore.getState().exportProgress[EXPORT_BATCH_KEY] ?? []
    const batchDone = batch.find(
      (e): e is Extract<ProgressEvent, { event: 'done' }> => e.event === 'done'
    )
    // Only a completed batch that actually exported ≥1 task reaches the
    // done phase; a cancelled, failed, or nothing-exported run drops
    // back to the config form (the store has already toasted why).
    setPhase(
      ok && batchDone !== undefined && batchDone.exported > 0
        ? 'done'
        : 'config'
    )
  }

  const handleOpenFolder = async (): Promise<void> => {
    const dir =
      exportedDir !== ''
        ? exportedDir
        : (useAppStore.getState().settings?.outputDir ?? '')
    if (dir === '') return
    try {
      await window.api.bundlesOpenFolder({ dir })
    } catch (err) {
      pushToast('error', `Could not open folder: ${errorText(err)}`)
    }
  }

  const batchEvents = exportProgress[EXPORT_BATCH_KEY] ?? []
  const doneEvent = batchEvents.find(
    (e): e is Extract<ProgressEvent, { event: 'done' }> => e.event === 'done'
  )
  const { rows, completed, totalFromEvents } = deriveProgress(
    tasks,
    exportProgress
  )
  const total = doneEvent?.total ?? totalFromEvents ?? tasks.length
  const exportedCount = doneEvent?.exported ?? completed
  const skippedCount = rows.filter((r) => r.state === 'skipped').length
  const failedCount = Math.max(skippedCount, total - exportedCount)

  return (
    <>
      <div
        className={`modal ${open ? 'modal-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Export tasks"
      >
        <div className="modal-box max-w-2xl">
          <h3 className="text-lg font-bold">
            Export {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </h3>
          <div className="mt-1 text-sm text-base-content/70">
            {tasks.slice(0, HEADER_TITLES_SHOWN).map((t) => (
              <p key={t.taskId} className="truncate" title={t.title}>
                {t.title}
              </p>
            ))}
            {tasks.length > HEADER_TITLES_SHOWN && (
              <p>…and {tasks.length - HEADER_TITLES_SHOWN} more</p>
            )}
          </div>

          {phase === 'config' ? (
            <>
              <fieldset className="fieldset mt-4">
                <legend className="fieldset-legend">Formats</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {FORMATS.map((format) => {
                    const checked = formats.includes(format)
                    const lastOn = checked && formats.length === 1
                    const input = (
                      <input
                        type="checkbox"
                        className="toggle toggle-sm"
                        checked={checked}
                        disabled={lastOn}
                        onChange={() => toggleFormat(format)}
                      />
                    )
                    return (
                      <label
                        key={format}
                        className="label cursor-pointer gap-2"
                      >
                        {lastOn ? (
                          <span
                            className="tooltip"
                            data-tip="At least one format is required"
                          >
                            {input}
                          </span>
                        ) : (
                          input
                        )}
                        {FORMAT_LABELS[format]}
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <fieldset className="fieldset mt-2">
                <legend className="fieldset-legend">Options</legend>
                <div className="flex flex-col gap-2">
                  <OptionToggle
                    label="Skip files"
                    hint="Transcript only — --no-files leaves uploads and outputs out of the bundle"
                    checked={noFiles}
                    disabled={purgeSource}
                    disabledTip="Purge needs the files exported — turn off Purge first"
                    onChange={(checked) => setNoFiles(checked)}
                  />
                  <OptionToggle
                    label={
                      <>
                        Include auth artefacts{' '}
                        <span className="badge badge-warning badge-sm">
                          risky
                        </span>
                      </>
                    }
                    hint="--include-auth bundles live session credentials"
                    checked={includeAuth}
                    onChange={(checked) => {
                      if (checked) setDanger('auth')
                      else setIncludeAuth(false)
                    }}
                  />
                  <OptionToggle
                    label="Purge local copies after export"
                    hint="--purge-source deletes the local task sandboxes after a verified export"
                    checked={purgeSource}
                    disabled={noFiles}
                    disabledTip="Unavailable with Skip files — the engine rejects --no-files together with --purge-source"
                    onChange={(checked) => {
                      if (checked) setDanger('purge')
                      else setPurgeSource(false)
                    }}
                  />
                </div>
              </fieldset>

              <fieldset className="fieldset mt-2">
                <legend className="fieldset-legend">Output folder</legend>
                <div className="join w-full">
                  <input
                    type="text"
                    readOnly
                    className="input join-item w-full"
                    value={settings?.outputDir ?? ''}
                    aria-label="Output folder"
                  />
                  <button
                    type="button"
                    className="btn join-item"
                    onClick={() => void handleBrowse()}
                  >
                    Browse…
                  </button>
                </div>
              </fieldset>

              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    settings === null ||
                    formats.length === 0 ||
                    tasks.length === 0 ||
                    exportRunning
                  }
                  onClick={() => void handleExport()}
                >
                  Export
                </button>
              </div>
            </>
          ) : (
            <>
              {phase === 'done' &&
                (failedCount > 0 ? (
                  <div role="alert" className="alert alert-warning mt-4">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-6 shrink-0"
                      aria-hidden="true"
                    >
                      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>
                      Exported {exportedCount} of {total}{' '}
                      {total === 1 ? 'task' : 'tasks'} — {failedCount}{' '}
                      {failedCount === 1 ? 'task was' : 'tasks were'} skipped
                      or failed (details below).
                    </span>
                  </div>
                ) : (
                  <div role="alert" className="alert alert-success mt-4">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-6 shrink-0"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    <span>
                      Exported {exportedCount} of {total}{' '}
                      {total === 1 ? 'task' : 'tasks'}.
                    </span>
                  </div>
                ))}

              {phase === 'running' && (
                <div className="mt-4 flex items-center gap-3">
                  <progress
                    className="progress flex-1"
                    value={completed}
                    max={total}
                  />
                  <span className="text-sm tabular-nums text-base-content/70">
                    {completed}/{total}
                  </span>
                </div>
              )}

              <ul className="mt-4 flex max-h-60 flex-col gap-1 overflow-y-auto">
                {rows.map(({ task, state, reason }) => (
                  <li
                    key={task.taskId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <StatusGlyph state={state} reason={reason} />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={task.title}
                    >
                      {task.title}
                    </span>
                    {state === 'skipped' && (
                      <span className="badge badge-warning badge-sm">
                        skipped
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="modal-action">
                {phase === 'running' ? (
                  <button
                    type="button"
                    className="btn btn-error"
                    onClick={() => void cancelExport()}
                  >
                    Cancel
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleOpenFolder()}
                    >
                      Open output folder
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={closeModal}
                    >
                      Close
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {phase !== 'running' && (
          <div className="modal-backdrop">
            <button type="button" tabIndex={-1} onClick={closeModal}>
              close
            </button>
          </div>
        )}
      </div>

      <ConfirmDangerModal
        open={danger === 'auth'}
        variant="warning"
        title="Include authentication artefacts?"
        body={
          <>
            <p>
              The bundle will contain live session credentials. Anyone who
              gets the bundle can act as your logged-in session — treat it
              like an SSH private key.
            </p>
            <p className="mt-2">
              Auth artefacts are only restorable on Windows.
            </p>
          </>
        }
        confirmLabel="I understand the risk"
        onConfirm={() => {
          setIncludeAuth(true)
          setDanger(null)
        }}
        onCancel={() => setDanger(null)}
      />

      <ConfirmDangerModal
        open={danger === 'purge'}
        variant="error"
        title="Delete local tasks after export?"
        body={
          <>
            <ul className="max-h-40 list-inside list-disc overflow-y-auto">
              {tasks.map((t) => (
                <li key={t.taskId} className="truncate" title={t.title}>
                  {t.title}
                </li>
              ))}
            </ul>
            <p className="mt-2 font-semibold">
              Their local sandboxes will be permanently removed after a
              verified export.
            </p>
          </>
        }
        confirmLabel="Purge after export"
        requireTypedWord="DELETE"
        onConfirm={() => {
          setPurgeSource(true)
          setDanger(null)
        }}
        onCancel={() => setDanger(null)}
      />
    </>
  )
}
