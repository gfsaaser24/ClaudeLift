/**
 * ImportModal (Task 12): guided `bundles:import` for one bundle.
 *
 * - Manifest summary (platform, exported at, task id, source user folders
 *   — all carried on BundleInfo; tool_version is not on BundleInfo and is
 *   deliberately omitted rather than adding channels).
 * - Remap editor: one row per manifest source_user_folders entry (src
 *   readonly) plus user-added rows (src editable); dst via typing or the
 *   folder picker. Rows are removable/addable.
 * - Toggles: keep-task-id; skip-auth (forced ON + disabled with an
 *   explanation when the bundle has auth from a non-win32 platform —
 *   the engine refuses cross-platform auth restore); force (hidden until
 *   an exit-3 "already exists" error is observed).
 * - Dry-run shows engine stdout in a scrollable mockup-code block.
 * - Error mapping (JSON-in-Error.message convention): exit-2 shows stderr
 *   in an alert-error and, when the engine lists workspace candidates
 *   ("pick one with --workspace:"), renders a workspace select for retry;
 *   exit-3 reveals the force toggle.
 *
 * MEMORY RULE: the default export returns null when `bundle` is null.
 */
import { useState } from 'react'
import type { JSX } from 'react'
import {
  ImportResultSchema,
  PickFolderResultSchema,
  type BundleInfo,
  type ImportOptions,
  type ImportResult
} from '../../shared/ipc'
import { errorText, parseIpcError, useAppStore } from '../store'

export interface ImportModalProps {
  /** Bundle to import, or null when the modal is closed. */
  bundle: BundleInfo | null
  onClose: () => void
}

export default function ImportModal({ bundle, onClose }: ImportModalProps): JSX.Element | null {
  if (bundle === null) return null
  return <ImportModalBody bundle={bundle} onClose={onClose} />
}

interface RemapRow {
  src: string
  dst: string
  /** Rows seeded from manifest source_user_folders keep src readonly. */
  fixed: boolean
}

interface ShownError {
  message: string
  stderr: string
}

/**
 * Candidate paths from the engine's exit-2 ambiguity stderr: the indented
 * lines following "pick one with --workspace:".
 */
export function parseWorkspaceCandidates(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes('pick one with --workspace'))
  if (start === -1) return []
  const candidates: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break
    candidates.push(line.trim())
  }
  return candidates
}

function ArrowIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0 opacity-60"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function ImportModalBody({ bundle, onClose }: { bundle: BundleInfo; onClose: () => void }): JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast)

  // Cross-platform auth: the engine refuses to restore non-win32 auth on
  // Windows, so --skip-auth is forced on and the toggle locked.
  const authLocked = bundle.hasAuth && bundle.sourcePlatform !== 'win32'

  const [rows, setRows] = useState<RemapRow[]>(() =>
    bundle.userFolders.map((src) => ({ src, dst: '', fixed: true }))
  )
  const [keepTaskId, setKeepTaskId] = useState(false)
  const [skipAuth, setSkipAuth] = useState(authLocked)
  const [force, setForce] = useState(false)
  const [showForce, setShowForce] = useState(false)
  const [workspace, setWorkspace] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [dryOutput, setDryOutput] = useState<string | null>(null)
  const [running, setRunning] = useState<'dry' | 'import' | null>(null)
  const [done, setDone] = useState<ImportResult | null>(null)
  const [error, setError] = useState<ShownError | null>(null)

  const patchRow = (index: number, patch: Partial<RemapRow>): void => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index: number): void => {
    setRows((current) => current.filter((_, i) => i !== index))
  }

  const addRow = (): void => {
    setRows((current) => [...current, { src: '', dst: '', fixed: false }])
  }

  const browseDst = async (index: number): Promise<void> => {
    try {
      const dir = PickFolderResultSchema.parse(
        await window.api.appPickFolder({ purpose: 'Remap destination folder' })
      )
      if (dir !== null) patchRow(index, { dst: dir })
    } catch (err) {
      pushToast('error', `Folder picker failed: ${errorText(err)}`)
    }
  }

  const buildOptions = (dryRun: boolean): ImportOptions => {
    // Imports honor the cowork-root override exactly like list/export do.
    const coworkRootOverride =
      useAppStore.getState().settings?.coworkRootOverride ?? null
    return {
      bundleDir: bundle.dir,
      ...(workspace !== '' ? { workspace } : {}),
      remaps: rows
        .filter((row) => row.src.trim() !== '' && row.dst.trim() !== '')
        .map((row) => ({ src: row.src.trim(), dst: row.dst.trim() })),
      keepTaskId,
      skipAuth: authLocked ? true : skipAuth,
      force,
      dryRun,
      ...(coworkRootOverride !== null ? { coworkRoot: coworkRootOverride } : {})
    }
  }

  const run = async (dryRun: boolean): Promise<void> => {
    setRunning(dryRun ? 'dry' : 'import')
    setError(null)
    if (dryRun) setDryOutput(null)
    try {
      const result = ImportResultSchema.parse(await window.api.bundlesImport(buildOptions(dryRun)))
      if (dryRun) {
        setDryOutput(result.stdout)
      } else {
        setDone(result)
      }
    } catch (err) {
      const info = parseIpcError(err)
      const stderr = info?.stderr ?? ''
      if (info?.kind === 'aborted') {
        // exit 3: target task dir already exists without --force
        setShowForce(true)
      }
      if (info?.kind === 'validation') {
        const parsed = parseWorkspaceCandidates(stderr)
        if (parsed.length > 0) setCandidates(parsed)
      }
      setError({ message: info?.message ?? errorText(err), stderr })
    } finally {
      setRunning(null)
    }
  }

  const exportedAtLocal = ((): string => {
    const date = new Date(bundle.exportedAt)
    return Number.isNaN(date.getTime()) ? bundle.exportedAt : date.toLocaleString()
  })()

  return (
    <div className="modal modal-open" role="dialog" aria-label="Import bundle">
      <div className="modal-box w-11/12 max-w-3xl">
        <h3 className="text-lg font-bold">Import bundle</h3>
        <p className="truncate text-sm opacity-70" title={bundle.title}>
          {bundle.title}
        </p>

        {/* manifest summary */}
        <div className="mt-3 rounded-box bg-base-200 p-3 text-sm">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <span className="opacity-60">Platform</span>
            <span className="font-mono">{bundle.sourcePlatform || 'unknown'}</span>
            <span className="opacity-60">Exported at</span>
            <span>{exportedAtLocal}</span>
            <span className="opacity-60">Task id</span>
            <span className="break-all font-mono text-xs">{bundle.taskId}</span>
            <span className="opacity-60">User folders</span>
            <span className="min-w-0">
              {bundle.userFolders.length === 0 ? (
                'none'
              ) : (
                <span className="flex flex-col gap-0.5">
                  {bundle.userFolders.map((folder) => (
                    <span key={folder} className="truncate font-mono text-xs" title={folder}>
                      {folder}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </div>
        </div>

        {/* workspace select — appears after the engine listed candidates */}
        {candidates.length > 0 && (
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Workspace</legend>
            <select
              className="select w-full font-mono text-xs"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            >
              <option value="" disabled>
                Select a workspace…
              </option>
              {candidates.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
            <p className="label">Multiple candidates detected — pick the destination, then retry.</p>
          </fieldset>
        )}

        {/* remap editor */}
        <fieldset className="fieldset">
          <legend className="fieldset-legend">Folder remaps</legend>
          {rows.length === 0 && (
            <p className="text-sm opacity-60">No source user folders — remaps are optional.</p>
          )}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                className="input input-sm min-w-0 flex-1 font-mono text-xs"
                value={row.src}
                readOnly={row.fixed}
                placeholder="source path"
                spellCheck={false}
                title={row.src}
                onChange={(e) => patchRow(index, { src: e.target.value })}
              />
              <ArrowIcon />
              <div className="join min-w-0 flex-1">
                <input
                  type="text"
                  className="input input-sm join-item min-w-0 flex-1 font-mono text-xs"
                  value={row.dst}
                  placeholder="destination folder"
                  spellCheck={false}
                  onChange={(e) => patchRow(index, { dst: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-sm join-item"
                  onClick={() => void browseDst(index)}
                >
                  Browse
                </button>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square"
                aria-label="Remove remap row"
                onClick={() => removeRow(index)}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-4"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm self-start" onClick={addRow}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            Add remap
          </button>
          <p className="label">Every source user folder needs a destination on this machine.</p>
        </fieldset>

        {/* toggles */}
        <div className="mt-2 flex flex-col gap-2">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle"
              checked={keepTaskId}
              onChange={(e) => setKeepTaskId(e.target.checked)}
            />
            <span className="text-base-content">Keep original task id</span>
          </label>
          <label className={`label justify-start gap-3 ${authLocked ? '' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              className="toggle"
              checked={authLocked ? true : skipAuth}
              disabled={authLocked}
              onChange={(e) => setSkipAuth(e.target.checked)}
            />
            <span className="text-base-content">Skip auth artefacts</span>
          </label>
          {authLocked && (
            <div role="alert" className="alert alert-warning">
              <span className="whitespace-normal">
                This bundle carries auth exported on {bundle.sourcePlatform}. Those keys are not
                interoperable with Windows, so auth is always skipped — sign in on this machine
                after importing.
              </span>
            </div>
          )}
          {showForce && (
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="toggle toggle-error"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span className="text-base-content">
                Force — overwrite the existing task directory
              </span>
            </label>
          )}
        </div>

        {/* dry-run output */}
        {dryOutput !== null && (
          <div className="mockup-code mt-3 max-h-64 w-full overflow-auto text-xs">
            {dryOutput.split(/\r?\n/).map((line, index) => (
              <pre key={index}>
                <code>{line}</code>
              </pre>
            ))}
          </div>
        )}

        {/* error */}
        {error !== null && (
          <div role="alert" className="alert alert-error alert-vertical mt-3 items-start text-left">
            <span className="whitespace-normal break-words font-semibold">{error.message}</span>
            {error.stderr.trim() !== '' && (
              <pre className="max-h-40 w-full overflow-auto whitespace-pre-wrap font-mono text-xs">
                {error.stderr}
              </pre>
            )}
          </div>
        )}

        {/* success */}
        {done !== null && (
          <div role="alert" className="alert alert-success alert-vertical mt-3 items-start text-left">
            <span className="font-semibold">
              Import complete
              {done.newTaskId !== null ? ` — new task id ${done.newTaskId}` : ''}
            </span>
            <span>Restart Cowork desktop to see the imported task.</span>
          </div>
        )}

        <div className="modal-action">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn"
            disabled={running !== null}
            onClick={() => void run(true)}
          >
            {running === 'dry' && (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            )}
            Dry-run
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running !== null || done !== null}
            onClick={() => void run(false)}
          >
            {running === 'import' && (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            )}
            Import
          </button>
        </div>
      </div>
      <div className="modal-backdrop">
        <button type="button" onClick={onClose} aria-label="Close">
          close
        </button>
      </div>
    </div>
  )
}
