/**
 * EngineService: the only place that spawns the cowork-export sidecar.
 *
 * Spawn rules (binding, from the plan): `stdio: ['ignore','pipe','pipe']`
 * (the engine's interactive prompts read stdin — an open-idle pipe hangs
 * forever, EOF aborts exit 3), `windowsHide: true`, absolute `-o` paths,
 * full task ids, pipes fully drained, and never two engine processes at
 * once — every public method funnels through a single-flight p-queue.
 *
 * Engine exit map: 0 ok · 1 no-match/nothing-exported · 2 validation ·
 * 3 confirm-abort / import-exists-without-force · 4 engine crash
 * (unexpected exception in the command dispatch) · anything else crash.
 * Non-zero exits surface as `EngineError {code, kind, stderr}`.
 *
 * No settings reads here — callers pass everything explicitly.
 */
import { app } from 'electron'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import PQueue from 'p-queue'
import {
  ProgressEventSchema,
  taskFromEngine,
  type CoworkTask,
  type ExportOptions,
  type ExportResult,
  type ImportOptions,
  type ImportResult,
  type ProgressEvent,
  type SeedOptions,
  type SeedResult,
  type TaskSource
} from '../shared/ipc'

/** Longest partial (newline-less) stdout line we will buffer. */
const MAX_PARTIAL_LINE = 1024 * 1024
/** Rolling cap for collected stderr. */
const STDERR_CAP = 256 * 1024
/** How long `cancelExport` waits after `child.kill()` before `taskkill /T /F`. */
const KILL_ESCALATION_MS = 1500

export type EngineErrorKind = 'none' | 'validation' | 'aborted' | 'crash'

export class EngineError extends Error {
  readonly code: number
  readonly kind: EngineErrorKind
  readonly stderr: string

  constructor(code: number, kind: EngineErrorKind, stderr: string) {
    super(`engine exited with code ${code} (${kind})`)
    this.name = 'EngineError'
    this.code = code
    this.kind = kind
    this.stderr = stderr
  }
}

function kindForExit(code: number): EngineErrorKind {
  switch (code) {
    case 1:
      return 'none'
    case 2:
      return 'validation'
    case 3:
      return 'aborted'
    case 4:
      // The engine's own "unexpected exception" exit code.
      return 'crash'
    default:
      return 'crash'
  }
}

function engineErrorFromExit(code: number | null, stderr: string): EngineError {
  if (code === null) return new EngineError(-1, 'crash', stderr)
  return new EngineError(code, kindForExit(code), stderr)
}

/**
 * Newline splitter with a bounded partial-line buffer. NDJSON events are
 * tiny; the cap only guards against pathological stdout (a line that never
 * ends is dropped in full once it exceeds MAX_PARTIAL_LINE).
 */
class BoundedLineSplitter {
  private partial = ''
  private overflowing = false

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    let buf = this.partial + chunk
    this.partial = ''
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (this.overflowing) {
        this.overflowing = false // the oversized line ended here; discard it
      } else if (line.length > 0) {
        this.onLine(line)
      }
    }
    if (this.overflowing) return
    if (buf.length > MAX_PARTIAL_LINE) {
      this.overflowing = true
    } else {
      this.partial = buf
    }
  }

  flush(): void {
    const line = this.partial.replace(/\r$/, '')
    this.partial = ''
    if (!this.overflowing && line.length > 0) this.onLine(line)
    this.overflowing = false
  }
}

type EngineChild = ChildProcessByStdio<null, Readable, Readable>

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

interface RunHooks {
  /** When set, stdout is line-split (bounded) instead of collected. */
  onStdoutLine?: (line: string) => void
  /** Fires right after spawn so callers can track the child for cancel. */
  onSpawn?: (child: EngineChild) => void
}

/**
 * Who initiated an export: the renderer's export flow ('ui') or the Notion
 * exporter ('notion'). `cancelExport(tag)` only touches exports carrying the
 * matching tag, so the UI cancel button cannot kill a Notion-triggered
 * export. NOTE: the Notion exporter must pass 'notion' at its
 * `engine.exportTasks(...)` call site (wired by the Consumers wave).
 */
export type ExportTag = 'ui' | 'notion'

interface ExportContext {
  child: EngineChild | null
  cancelled: boolean
}

interface ExportEntry {
  ctx: ExportContext
  tag: ExportTag
}

export interface EngineServiceOptions {
  /** Test hook: bypass the packaged/dev exe resolution entirely. */
  exePathOverride?: string
}

export class EngineService {
  private readonly exePathOverride: string | undefined
  /** Single-flight: never two engine processes concurrently. */
  private readonly queue = new PQueue({ concurrency: 1 })
  /** Every unsettled export (queued or running), with its initiator tag. */
  private readonly exports = new Set<ExportEntry>()
  /** The engine child currently running (any command), for shutdown(). */
  private currentChild: EngineChild | null = null

  constructor(options: EngineServiceOptions = {}) {
    this.exePathOverride = options.exePathOverride
  }

  exePath(): string {
    if (this.exePathOverride !== undefined) return this.exePathOverride
    return app.isPackaged
      ? join(process.resourcesPath, 'engine', 'cowork-export', 'cowork-export.exe')
      : join(__dirname, '../../resources/engine/cowork-export/cowork-export.exe')
  }

  listTasks(source: TaskSource, coworkRoot?: string): Promise<CoworkTask[]> {
    return this.queue.add(async () => {
      const args = ['list', '--json', '--source', source]
      if (coworkRoot !== undefined) args.push('--cowork-root', coworkRoot)
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new EngineError(-1, 'crash', `list --json emitted unparseable stdout:\n${result.stdout.slice(0, 2000)}`)
      }
      if (!Array.isArray(parsed)) {
        throw new EngineError(-1, 'crash', 'list --json did not emit a JSON array')
      }
      return parsed.map((raw) => taskFromEngine(raw))
    })
  }

  /**
   * Export the given tasks into `opts.outputDir`, re-emitting the engine's
   * NDJSON progress on `onProgress`.
   *
   * The engine takes ONE selector per invocation, so a batch runs as
   * sequential per-id exports inside one queue job ('all' is never used —
   * it would export every task on the machine). Per-process events carry
   * `index: 1, total: 1`; `task_start` is re-emitted with the position in
   * the BATCH, per-process `done` events are swallowed, and one synthesized
   * `done {exported, total}` for the whole batch is emitted at the end
   * (matching the engine's own always-emit-done contract). Mirroring the
   * engine's exit semantics, the batch rejects with kind 'none' when
   * nothing at all was exported — or kind 'crash' when nothing was exported
   * and at least one per-id run crashed (exit 4 / unknown exit / Traceback).
   *
   * `tag` labels the export for `cancelExport(tag)` targeting; the Notion
   * exporter must pass 'notion' so a UI cancel leaves its exports running.
   */
  exportTasks(
    opts: ExportOptions,
    onProgress: (event: ProgressEvent) => void,
    tag: ExportTag = 'ui'
  ): Promise<ExportResult> {
    // The context is registered BEFORE queueing so cancelExport(tag) can
    // flag exports that are still waiting behind another engine process.
    const ctx: ExportContext = { child: null, cancelled: false }
    const entry: ExportEntry = { ctx, tag }
    this.exports.add(entry)
    return this.queue.add(async () => {
      try {
        if (ctx.cancelled) {
          throw new EngineError(3, 'aborted', 'export cancelled while queued')
        }
        if (opts.taskIds.length === 0) {
          throw new EngineError(2, 'validation', 'exportTasks called with an empty taskIds list')
        }
        for (const taskId of opts.taskIds) {
          // The engine treats 'all'/'latest' as selectors and anything
          // starting with '-' as a flag — never forward those as task ids.
          if (taskId === 'all' || taskId === 'latest' || taskId.startsWith('-')) {
            throw new EngineError(2, 'validation', `refusing reserved/oversized selector: ${taskId}`)
          }
        }
        return await this.runExportBatch(opts, onProgress, ctx)
      } finally {
        this.exports.delete(entry)
      }
    })
  }

  /**
   * Cancel every export carrying `tag` (default 'ui', the renderer's cancel
   * button): flags matching queued/active contexts cancelled — a still-queued
   * job then rejects with kind 'aborted' before it can spawn — and kills the
   * live export child (graceful `child.kill()`, escalating to
   * `taskkill /pid <pid> /T /F` if it is still alive after 1.5s). Exports
   * with a different tag (e.g. Notion-triggered) keep running. No-op when
   * nothing matches.
   */
  cancelExport(tag: ExportTag = 'ui'): void {
    for (const entry of this.exports) {
      if (entry.tag !== tag) continue
      entry.ctx.cancelled = true
      const child = entry.ctx.child
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        killTree(child)
      }
    }
  }

  /**
   * App-quit teardown: drop every queued job, flag all exports cancelled,
   * and kill-tree the live engine child regardless of tag or command.
   * `cancelExport` remains the UI-button path; wiring this into
   * `before-quit` is the caller's job.
   */
  shutdown(): void {
    this.queue.clear()
    for (const entry of this.exports) entry.ctx.cancelled = true
    const child = this.currentChild
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      killTree(child)
    }
  }

  importBundle(opts: ImportOptions): Promise<ImportResult> {
    return this.queue.add(async () => {
      const args = ['import', opts.bundleDir]
      if (opts.workspace !== undefined) args.push('--workspace', opts.workspace)
      for (const remap of opts.remaps) args.push('--remap', `${remap.src}=${remap.dst}`)
      if (opts.keepTaskId) args.push('--keep-task-id')
      if (opts.skipAuth) args.push('--skip-auth')
      if (opts.dryRun) args.push('--dry-run')
      if (opts.force) args.push('--force')
      if (opts.coworkRoot !== undefined) args.push('--cowork-root', opts.coworkRoot)
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      const match = /^\s*new_task_id:\s*(\S+)/m.exec(result.stdout)
      return { newTaskId: match === null ? null : match[1], stdout: result.stdout }
    })
  }

  makeSeed(opts: SeedOptions): Promise<SeedResult> {
    return this.queue.add(async () => {
      const args = ['seed', opts.bundleDir, '--mode', opts.mode]
      if (opts.outputPath !== undefined) args.push('-o', opts.outputPath)
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      // Engine success line: `wrote <path>  (<n> chars, mode=<mode>)`
      const match = /^wrote (.+?)\s+\((\d+) chars/m.exec(result.stdout)
      if (match === null) {
        throw new EngineError(-1, 'crash', `seed succeeded but its output was not recognized:\n${result.stdout}`)
      }
      return { outputPath: match[1], chars: Number.parseInt(match[2], 10) }
    })
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Flag order per the plan: -o, --formats, --no-files, --include-auth,
   * --purge-source, --yes-i-know-this-is-risky (only when a risky flag is
   * set AND the UI confirmed it), --source, --cowork-root, --progress-json.
   */
  private buildExportFlags(opts: ExportOptions): string[] {
    const flags = ['-o', resolve(opts.outputDir), '--formats', opts.formats.join(',')]
    if (opts.noFiles) flags.push('--no-files')
    if (opts.includeAuth) flags.push('--include-auth')
    if (opts.purgeSource) flags.push('--purge-source')
    if (opts.includeAuth || opts.purgeSource) flags.push('--yes-i-know-this-is-risky')
    flags.push('--source', opts.source)
    if (opts.coworkRoot !== undefined) flags.push('--cowork-root', opts.coworkRoot)
    flags.push('--progress-json')
    return flags
  }

  private async runExportBatch(
    opts: ExportOptions,
    onProgress: (event: ProgressEvent) => void,
    ctx: ExportContext
  ): Promise<ExportResult> {
    const total = opts.taskIds.length
    const flags = this.buildExportFlags(opts)
    let exported = 0
    let lastStderr = ''
    /** First crashed per-id run (exit 4 / unknown exit / Traceback), if any. */
    let crash: { code: number; stderr: string } | null = null

    for (let i = 0; i < total; i++) {
      if (ctx.cancelled) throw new EngineError(3, 'aborted', lastStderr)
      const taskId = opts.taskIds[i]
      let runExported = 0
      /** Terminal event (task_done | task_skipped) seen for THIS per-id run. */
      let sawTerminalEvent = false

      const result = await this.run(['export', taskId, ...flags], {
        onStdoutLine: (line) => {
          let raw: unknown
          try {
            raw = JSON.parse(line)
          } catch {
            return // non-event stdout noise
          }
          const check = ProgressEventSchema.safeParse(raw)
          if (!check.success) return
          const event = check.data
          switch (event.event) {
            case 'task_start':
              // per-process index/total is 1/1 — rewrite to the batch position
              onProgress({ ...event, index: i + 1, total })
              break
            case 'done':
              runExported = event.exported
              break
            case 'task_done':
            case 'task_skipped':
              sawTerminalEvent = true
              onProgress(event)
              break
            case 'purged':
              onProgress(event)
              break
          }
        },
        onSpawn: (child) => {
          ctx.child = child
        }
      })
      ctx.child = null
      lastStderr = result.stderr
      if (ctx.cancelled) throw new EngineError(3, 'aborted', result.stderr)

      // exit 2 (validation) / 3 (confirm-abort) abort the whole batch at once.
      if (result.code === 2 || result.code === 3) {
        throw engineErrorFromExit(result.code, result.stderr)
      }

      // exit 1 with a terminal event = task existed but exported nothing;
      // exit 1 without one = no session matched this id at all. Exit 4 /
      // unknown exits / a Traceback on stderr = the engine crashed on this
      // id. All of these keep the batch going; overall failure is decided
      // below.
      exported += runExported
      const hasTraceback = result.stderr.includes('Traceback')
      const crashed = hasTraceback || (result.code !== 0 && result.code !== 1)
      if (crashed && crash === null) {
        crash = { code: result.code ?? -1, stderr: result.stderr }
      }
      if (!sawTerminalEvent) {
        // Never silently drop a task: synthesize the skip the engine
        // failed to emit, so the UI shows what happened to this id.
        const firstStderrLine = result.stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        const reason = firstStderrLine ?? (crashed ? 'engine crashed' : 'no session matched')
        onProgress({ event: 'task_skipped', task_id: taskId, reason })
      }
    }

    onProgress({ event: 'done', exported, total })
    if (exported === 0) {
      // All-failed batches: crashes surface as 'crash'; plain no-match
      // (exit 1, clean stderr) stays 'none'.
      if (crash !== null) throw new EngineError(crash.code, 'crash', crash.stderr)
      throw new EngineError(1, 'none', lastStderr)
    }
    return { exported }
  }

  private run(args: string[], hooks: RunHooks = {}): Promise<RunResult> {
    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      const exe = this.exePath()
      let child: EngineChild
      try {
        child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        rejectPromise(spawnFailure(exe, err))
        return
      }
      hooks.onSpawn?.(child)
      this.currentChild = child

      let stdout = ''
      let stderr = ''
      const splitter = hooks.onStdoutLine === undefined ? null : new BoundedLineSplitter(hooks.onStdoutLine)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (splitter !== null) splitter.push(chunk)
        else stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_CAP)
      })

      let settled = false
      child.on('error', (err) => {
        if (this.currentChild === child) this.currentChild = null
        if (settled) return
        settled = true
        rejectPromise(spawnFailure(exe, err))
      })
      // 'close' fires once the process exited AND both pipes are drained.
      child.on('close', (code) => {
        if (this.currentChild === child) this.currentChild = null
        if (settled) return
        settled = true
        splitter?.flush()
        resolvePromise({ code, stdout, stderr })
      })
    })
  }
}

function spawnFailure(exe: string, err: unknown): EngineError {
  const detail = err instanceof Error ? err.message : String(err)
  return new EngineError(-1, 'crash', `failed to spawn engine sidecar at ${exe}: ${detail}`)
}

function killTree(child: EngineChild): void {
  const pid = child.pid
  child.kill()
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && pid !== undefined) {
      // still alive after the grace period — force-kill the whole tree
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
        /* best-effort */
      })
    }
  }, KILL_ESCALATION_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}
