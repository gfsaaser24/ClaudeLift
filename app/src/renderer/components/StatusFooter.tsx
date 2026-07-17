/**
 * Slim status bar (Task 9): engine version, scanned-root count with a
 * tooltip listing diagnostics.scannedRoots, and a watcher status dot
 * (daisyUI status) with a Live/Paused label.
 */
import type { JSX } from 'react'
import { ENGINE_VERSION } from '../../shared/ipc'
import { useAppStore } from '../store'

export default function StatusFooter(): JSX.Element {
  const diagnostics = useAppStore((s) => s.diagnostics)
  const watcher = useAppStore((s) => s.watcher)

  const roots = diagnostics?.scannedRoots ?? []
  const watcherState = watcher ?? diagnostics?.watcher ?? null
  const active = watcherState?.active ?? false

  return (
    <footer className="flex shrink-0 items-center gap-4 border-t border-base-300 bg-base-100 px-4 py-1.5 text-xs text-base-content/70">
      <span>engine {ENGINE_VERSION}</span>

      <div className="tooltip tooltip-top">
        <div className="tooltip-content whitespace-pre-line text-left">
          {roots.length > 0 ? roots.join('\n') : 'No cowork roots found'}
        </div>
        <span className="cursor-default">
          {roots.length} {roots.length === 1 ? 'root' : 'roots'}
        </span>
      </div>

      <span className="ml-auto flex items-center gap-2">
        <span
          className={`status ${
            active ? 'status-success animate-pulse' : 'status-neutral'
          }`}
          aria-hidden="true"
        />
        {active ? 'Live' : 'Paused'}
      </span>
    </footer>
  )
}
