/**
 * SeedModal (Task 12): generate a seed-prompt.md from a bundle via
 * `bundles:seed`. Mode select (brief/standard/full with size hints),
 * output path (defaults to seed-prompt.md inside the bundle), Generate
 * with loading state.
 *
 * On success the seed FILE PATH is copied to the clipboard (toast
 * "Seed written — path copied") and an "Open containing folder" button is
 * shown. Copying the seed TEXT itself is deliberately not offered:
 * bundles:readMarkdown is contract-bound to session.md, so the renderer
 * has no channel to read back an arbitrary seed file.
 *
 * MEMORY RULE: the default export returns null when `bundle` is null —
 * closing fully unmounts the modal state.
 */
import { useState } from 'react'
import type { JSX } from 'react'
import {
  SeedResultSchema,
  type BundleInfo,
  type SeedOptions,
  type SeedResult
} from '../../shared/ipc'
import { errorText, useAppStore } from '../store'

export interface SeedModalProps {
  /** Bundle to seed from, or null when the modal is closed. */
  bundle: BundleInfo | null
  onClose: () => void
}

export default function SeedModal({ bundle, onClose }: SeedModalProps): JSX.Element | null {
  if (bundle === null) return null
  return <SeedModalBody bundle={bundle} onClose={onClose} />
}

type SeedMode = SeedOptions['mode']

const MODE_HINTS: Record<SeedMode, string> = {
  brief: 'brief — headline summary (~50 KB for a 30-turn task)',
  standard: 'standard — balanced context (~70 KB for a 30-turn task)',
  full: 'full — complete transcript detail (~225 KB for a 30-turn task)'
}

/** Directory part of a path (handles both separators; renderer-safe). */
function containingDir(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx > 0 ? path.slice(0, idx) : path
}

/** Default output path: seed-prompt.md inside the bundle dir. */
function defaultSeedPath(bundleDir: string): string {
  const sep = bundleDir.includes('\\') ? '\\' : '/'
  return `${bundleDir}${sep}seed-prompt.md`
}

function SeedModalBody({ bundle, onClose }: { bundle: BundleInfo; onClose: () => void }): JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast)
  const refreshBundles = useAppStore((s) => s.refreshBundles)

  const [mode, setMode] = useState<SeedMode>('standard')
  const [outputPath, setOutputPath] = useState(() => defaultSeedPath(bundle.dir))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SeedResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const copyPath = async (path: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(path)
      return true
    } catch {
      return false
    }
  }

  const generate = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const trimmed = outputPath.trim()
      const res = SeedResultSchema.parse(
        await window.api.bundlesSeed({
          bundleDir: bundle.dir,
          mode,
          ...(trimmed !== '' ? { outputPath: trimmed } : {})
        })
      )
      setResult(res)
      if (await copyPath(res.outputPath)) {
        pushToast('success', 'Seed written — path copied')
      } else {
        pushToast('success', `Seed written: ${res.outputPath}`)
      }
      void refreshBundles() // hasSeed badge may have changed
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }

  const openContainingFolder = (): void => {
    if (result === null) return
    window.api.bundlesOpenFolder({ dir: containingDir(result.outputPath) }).catch((err: unknown) => {
      pushToast('error', `Open folder failed: ${errorText(err)}`)
    })
  }

  return (
    <div className="modal modal-open" role="dialog" aria-label="Generate seed prompt">
      <div className="modal-box">
        <h3 className="text-lg font-bold">Generate seed prompt</h3>
        <p className="truncate text-sm opacity-70" title={bundle.title}>
          {bundle.title}
        </p>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Mode</legend>
          <select
            className="select w-full"
            value={mode}
            disabled={running}
            onChange={(e) => setMode(e.target.value as SeedMode)}
          >
            {(Object.keys(MODE_HINTS) as SeedMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_HINTS[m]}
              </option>
            ))}
          </select>
          <p className="label">Sizes are approximate, for a 30-turn task.</p>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Output path</legend>
          <input
            type="text"
            className="input w-full font-mono text-xs"
            value={outputPath}
            disabled={running}
            spellCheck={false}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          <p className="label">Defaults to seed-prompt.md inside the bundle.</p>
        </fieldset>

        {error !== null && (
          <div role="alert" className="alert alert-error mt-2">
            <span className="whitespace-normal break-words">Seed failed: {error}</span>
          </div>
        )}

        {result !== null && (
          <div role="alert" className="alert alert-success alert-vertical mt-2 items-start text-left">
            <span className="font-semibold">
              Seed written ({result.chars.toLocaleString()} chars)
            </span>
            <span className="w-full break-all font-mono text-xs">{result.outputPath}</span>
            <span className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void copyPath(result.outputPath).then((ok) => {
                    pushToast(ok ? 'success' : 'error', ok ? 'Path copied' : 'Copy failed')
                  })
                }}
              >
                Copy path
              </button>
              <button type="button" className="btn btn-sm" onClick={openContainingFolder}>
                Open containing folder
              </button>
            </span>
          </div>
        )}

        <div className="modal-action">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            onClick={() => void generate()}
          >
            {running && <span className="loading loading-spinner loading-sm" aria-hidden="true" />}
            Generate
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
