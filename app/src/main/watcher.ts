/**
 * WatcherService — watches the Claude Cowork session roots for task
 * metadata changes and emits a debounced "dirty" signal so the app can
 * silently re-list tasks (wired to `evt:tasksChanged` by the IPC layer).
 *
 * chokidar v4 has NO glob support, so roots are discovered with plain
 * fs.readdirSync/statSync (no globbing anywhere) and each existing root
 * directory is watched directly. depth 2 covers the on-disk layout
 * `<root>/<account-uuid>/<workspace-uuid>/local_<task-uuid>.json`.
 */
import { watch, type FSWatcher } from 'chokidar'
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WatcherState } from '../shared/ipc'

/** Task metadata files: `local_<36-char-uuid>.json`, case-insensitive. */
const TASK_FILE_RE = /^local_[0-9a-f-]{36}\.json$/i

/** Trailing debounce applied before each dirty emit, in ms. */
const DIRTY_DEBOUNCE_MS = 500

/** How often roots are re-discovered (Claude installed/uninstalled), in ms. */
const REDISCOVER_INTERVAL_MS = 60_000

/** True when `path` exists and is a directory (never throws). */
function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Discover the Cowork session roots on this machine.
 *
 * - `override` non-null (settings.coworkRootOverride): return `[override]`
 *   when it exists, else `[]`.
 * - otherwise: `%APPDATA%\Claude\local-agent-mode-sessions` plus every
 *   MSIX-style `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
 *   local-agent-mode-sessions`, filtered to existing directories.
 */
export function discoverRoots(override: string | null): string[] {
  if (override !== null) {
    return isExistingDir(override) ? [override] : []
  }

  const candidates: string[] = [
    join(process.env.APPDATA ?? '', 'Claude', 'local-agent-mode-sessions')
  ]

  // Store (MSIX) installs live under <LOCALAPPDATA>\Packages\Claude_<hash>.
  // No globs: enumerate the Packages dir and test each suffix directly.
  const packagesDir = join(process.env.LOCALAPPDATA ?? '', 'Packages')
  let packageNames: string[] = []
  try {
    packageNames = readdirSync(packagesDir)
  } catch {
    // Packages dir missing or unreadable — nothing to add.
  }
  for (const name of packageNames) {
    if (!/^Claude_/.test(name)) continue
    candidates.push(
      join(
        packagesDir,
        name,
        'LocalCache',
        'Roaming',
        'Claude',
        'local-agent-mode-sessions'
      )
    )
  }

  return candidates.filter(isExistingDir)
}

/** Order-insensitive equality of two root lists. */
function sameRootSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((root) => set.has(root))
}

type DirtyCallback = () => void
type StateChangeCallback = (state: WatcherState) => void

export class WatcherService {
  private watcher: FSWatcher | null = null
  private roots: string[] = []
  private rootsOverride: string[] | null = null
  private started = false
  private rediscoverTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly dirtyCallbacks = new Set<DirtyCallback>()
  private readonly stateCallbacks = new Set<StateChangeCallback>()
  /**
   * Serializes watcher close/restart work so `close()` is always awaited
   * before a replacement watcher takes over, and so `stop()` can await
   * any in-flight restart.
   */
  private pending: Promise<void> = Promise.resolve()

  /**
   * Start watching. Idempotent — a second call while started is a no-op.
   *
   * @param rootsOverride explicit roots to watch (e.g. from tests or the
   *   settings override); when omitted, roots come from `discoverRoots(null)`.
   */
  start(rootsOverride?: string[]): void {
    if (this.started) return
    this.started = true
    this.rootsOverride = rootsOverride ?? null
    this.roots = this.discover()
    this.openWatcher()
    this.emitStateChange()
    this.rediscoverTimer = setInterval(() => {
      this.rediscover()
    }, REDISCOVER_INTERVAL_MS)
  }

  /**
   * Stop watching: clears timers and awaits the underlying chokidar
   * watcher's `close()`. Idempotent — extra calls resolve immediately
   * (after any in-flight close/restart has drained).
   */
  async stop(): Promise<void> {
    const wasStarted = this.started
    this.started = false
    if (this.rediscoverTimer !== null) {
      clearInterval(this.rediscoverTimer)
      this.rediscoverTimer = null
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.queueClose()
    await this.pending
    if (wasStarted) this.emitStateChange()
  }

  /** Subscribe to debounced dirty signals. Returns an unsubscribe fn. */
  onDirty(cb: DirtyCallback): () => void {
    this.dirtyCallbacks.add(cb)
    return () => {
      this.dirtyCallbacks.delete(cb)
    }
  }

  /** Subscribe to watcher state changes. Returns an unsubscribe fn. */
  onStateChange(cb: StateChangeCallback): () => void {
    this.stateCallbacks.add(cb)
    return () => {
      this.stateCallbacks.delete(cb)
    }
  }

  state(): WatcherState {
    return { active: this.watcher !== null, roots: [...this.roots] }
  }

  private discover(): string[] {
    if (this.rootsOverride !== null) {
      return this.rootsOverride.filter(isExistingDir)
    }
    return discoverRoots(null)
  }

  /** Open a chokidar watcher over the current roots (no-op when empty). */
  private openWatcher(): void {
    if (this.roots.length === 0) return
    const watcher = watch(this.roots, {
      depth: 2,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    const onFileEvent = (path: string): void => {
      if (TASK_FILE_RE.test(basename(path))) this.scheduleDirty()
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    watcher.on('unlink', onFileEvent)
    watcher.on('error', (err) => {
      console.error('[watcher] chokidar error:', err)
    })
    this.watcher = watcher
  }

  /**
   * Detach the current watcher immediately and queue its `close()` on the
   * pending chain. Detaching synchronously means a subsequent `start()`
   * can never have its fresh watcher closed by a stale queued close.
   */
  private queueClose(): void {
    const watcher = this.watcher
    this.watcher = null
    if (watcher === null) return
    this.pending = this.pending
      .then(() => watcher.close())
      .catch((err) => {
        console.error('[watcher] close failed:', err)
      })
  }

  /**
   * Re-run root discovery; when the set changed (Claude installed,
   * uninstalled, or the override dir appeared/vanished), restart the
   * watcher — awaiting the old close first — and emit a state change.
   */
  private rediscover(): void {
    if (!this.started) return
    const next = this.discover()
    if (sameRootSet(next, this.roots)) return
    const old = this.watcher
    this.watcher = null
    this.pending = this.pending
      .then(async () => {
        if (old !== null) await old.close()
        if (!this.started) return
        this.roots = next
        this.openWatcher()
        this.emitStateChange()
      })
      .catch((err) => {
        console.error('[watcher] restart failed:', err)
      })
  }

  /** Trailing 500ms debounce: bursts of file events emit one dirty. */
  private scheduleDirty(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      for (const cb of this.dirtyCallbacks) {
        try {
          cb()
        } catch (err) {
          console.error('[watcher] dirty callback failed:', err)
        }
      }
    }, DIRTY_DEBOUNCE_MS)
  }

  private emitStateChange(): void {
    const state = this.state()
    for (const cb of this.stateCallbacks) {
      try {
        cb(state)
      } catch (err) {
        console.error('[watcher] state callback failed:', err)
      }
    }
  }
}
