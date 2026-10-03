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
 * 3 confirm-abort / import-exists-without-force / Claude Desktop is running
 * (import, import-all, import-space without --allow-running) · 4 engine crash
 * (unexpected exception in the command dispatch) · anything else crash.
 * Non-zero exits surface as `EngineError {code, kind, stderr}`.
 *
 * No settings reads here — callers pass everything explicitly.
 */
import { app } from 'electron'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import PQueue from 'p-queue'
import {
  ConvertProgressEventSchema,
  convertDoneExtras,
  ImportAllProgressEventSchema,
  ProgressEventSchema,
  PushPlanSchema,
  taskFromEngine,
  type ConvertClaudeAiOptions,
  type ConvertProgressEvent,
  type ConvertResult,
  type CoworkTask,
  type ExportOptions,
  type ExportResult,
  type ImportAllOptions,
  type ImportAllProgressEvent,
  type ImportAllResult,
  type ImportOptions,
  type ImportResult,
  type ImportSpaceOptions,
  type ImportSpaceResult,
  type ProgressEvent,
  type PushPlan,
  type PushPlanRequest,
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
  /** Every unsettled convert-claudeai / import-all job (queued or running). */
  private readonly migrations = new Set<ExportContext>()
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
    for (const ctx of this.migrations) ctx.cancelled = true
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
      if (opts.space !== undefined) args.push('--space', opts.space)
      if (opts.allowRunning === true) args.push('--allow-running')
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      const match = /^\s*new_task_id:\s*(\S+)/m.exec(result.stdout)
      return { newTaskId: match === null ? null : match[1], stdout: result.stdout }
    })
  }

  /**
   * `convert-claudeai`: turn a claude.ai "Export data" download into
   * bundles under `opts.outputDir`, re-emitting the engine's NDJSON
   * (project_done / conversation_done / done) on `onProgress`. Resolves
   * with the final `done` counts; a non-zero exit (or a run that never
   * emitted `done`) rejects with an EngineError. Cancellable via
   * `cancelMigrate()`.
   */
  convertClaudeAi(
    opts: ConvertClaudeAiOptions,
    onProgress: (event: ConvertProgressEvent) => void
  ): Promise<ConvertResult> {
    // Absolute paths only: a relative path starting with '-' would parse
    // as a flag. `--match=` keeps a dash-led filter from doing the same.
    const args = [
      'convert-claudeai',
      // The export folder is optional when --pull files are given.
      ...(opts.exportDir !== undefined ? [resolve(opts.exportDir)] : []),
      '-o',
      resolve(opts.outputDir),
      '--what',
      opts.what.join(','),
      `--formats=${opts.formats.join(',')}`
    ]
    if (opts.since !== undefined) args.push(`--since=${opts.since}`)
    if (opts.match !== undefined) args.push(`--match=${opts.match}`)
    if (opts.limit !== undefined) args.push('--limit', String(opts.limit))
    for (const pullFile of opts.pull ?? []) args.push('--pull', resolve(pullFile))
    args.push('--progress-json')

    let done: Extract<ConvertProgressEvent, { event: 'done' }> | null = null
    return this.runMigration(args, ConvertProgressEventSchema, (event) => {
      if (event.event === 'done') done = event
      onProgress(event)
    }).then((result) => {
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      const final = done as Extract<ConvertProgressEvent, { event: 'done' }> | null
      if (final === null) {
        throw new EngineError(-1, 'crash', `convert-claudeai finished without a done event\n${result.stderr}`)
      }
      return {
        output: final.output,
        conversations: final.conversations,
        projects: final.projects,
        memoryFiles: final.memory_files,
        designChats: final.design_chats,
        artifactFiles: final.artifact_files,
        extra: convertDoneExtras(final)
      }
    })
  }

  /**
   * `import-all`: import every bundle in `opts.folder` (projects/ → spaces,
   * every task bundle → task) into the target workspace, re-emitting the
   * engine's NDJSON on `onProgress`. Exit 1 WITH a `done` event means some
   * tasks failed — that still resolves (the counts say how many). Exit 2
   * (validation, e.g. several workspaces and no --workspace) and exit 3
   * (Claude Desktop is running, unless allowRunning) reject. Cancellable
   * via `cancelMigrate()` — tasks already written stay imported.
   */
  importAll(
    opts: ImportAllOptions,
    onProgress: (event: ImportAllProgressEvent) => void
  ): Promise<ImportAllResult> {
    const args = ['import-all', resolve(opts.folder)]
    if (opts.workspace !== undefined) args.push('--workspace', resolve(opts.workspace))
    if (opts.coworkRoot !== undefined) args.push('--cowork-root', resolve(opts.coworkRoot))
    if (opts.docsRoot !== undefined) args.push('--docs-root', resolve(opts.docsRoot))
    if (opts.dryRun) args.push('--dry-run')
    if (opts.allowRunning) args.push('--allow-running')
    if (opts.projectsOnly === true) args.push('--projects-only')
    if (opts.tasksOnly === true) args.push('--tasks-only')
    for (const remap of opts.remaps ?? []) args.push(`--remap=${remap.src}=${remap.dst}`)
    args.push('--progress-json')

    let done: Extract<ImportAllProgressEvent, { event: 'done' }> | null = null
    return this.runMigration(args, ImportAllProgressEventSchema, (event) => {
      if (event.event === 'done') done = event
      onProgress(event)
    }).then((result) => {
      const final = done as Extract<ImportAllProgressEvent, { event: 'done' }> | null
      if (final !== null && (result.code === 0 || result.code === 1)) {
        return {
          spaces: final.spaces,
          tasksImported: final.tasks_imported,
          tasksFailed: final.tasks_failed,
          dryRun: final.dry_run,
          workspace: final.workspace
        }
      }
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      throw new EngineError(-1, 'crash', `import-all finished without a done event\n${result.stderr}`)
    })
  }

  /**
   * `import-space --json`: create (or reuse, by name) one space on the
   * target account from a space bundle (space.json + memory/ + docs/).
   */
  importSpace(opts: ImportSpaceOptions): Promise<ImportSpaceResult> {
    return this.queue.add(async () => {
      const args = ['import-space', resolve(opts.spaceBundleDir)]
      if (opts.workspace !== undefined) args.push('--workspace', resolve(opts.workspace))
      if (opts.coworkRoot !== undefined) args.push('--cowork-root', resolve(opts.coworkRoot))
      if (opts.docsRoot !== undefined) args.push('--docs-root', resolve(opts.docsRoot))
      if (opts.dryRun) args.push('--dry-run')
      if (opts.allowRunning) args.push('--allow-running')
      args.push('--json')
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      // The JSON summary is the last stdout line; the lines before it are the log.
      const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
      const last = lines.at(-1) ?? ''
      let parsed: { space_id?: unknown; created?: unknown; name?: unknown }
      try {
        parsed = JSON.parse(last) as typeof parsed
      } catch {
        throw new EngineError(-1, 'crash', `import-space --json emitted no JSON summary:\n${result.stdout.slice(0, 2000)}`)
      }
      return {
        spaceId: typeof parsed.space_id === 'string' ? parsed.space_id : '',
        created: parsed.created === true,
        name: typeof parsed.name === 'string' ? parsed.name : null,
        stdout: lines.slice(0, -1).join('\n')
      }
    })
  }

  /**
   * `plan-push`: write the plan of what to rebuild in a new-layout account
   * to `planFile` (engine-side key blanking included) and return it parsed.
   * Read-only on the source folder; staging copies go next to the plan.
   */
  planPush(req: PushPlanRequest, planFile: string): Promise<PushPlan> {
    return this.queue.add(async () => {
      const args = ['plan-push', '--source', resolve(req.source), '--out', resolve(planFile)]
      if (req.coworkBundles !== undefined) args.push('--cowork-bundles', resolve(req.coworkBundles))
      if (!req.includeChats) args.push('--no-chats')
      if (req.includeUnfiledChats) args.push('--include-unfiled-chats')
      if (!req.includeAccountMemory) args.push('--no-account-memory')
      if (req.includeLocalFolders) args.push('--local-folders')
      for (const org of req.orgs) args.push(`--org=${org}`)
      const result = await this.run(args)
      if (result.code !== 0) throw engineErrorFromExit(result.code, result.stderr)
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(resolve(planFile), 'utf8'))
      } catch (err) {
        throw new EngineError(-1, 'crash', `plan-push wrote no readable plan: ${err instanceof Error ? err.message : String(err)}
${result.stderr}`)
      }
      const parsed = PushPlanSchema.safeParse(raw)
      if (!parsed.success) {
        throw new EngineError(-1, 'crash', `plan-push wrote a plan ClaudeLift cannot read: ${parsed.error.message.slice(0, 1000)}`)
      }
      return parsed.data
    })
  }

  /**
   * Cancel every queued/running convert-claudeai / import-all job: queued
   * jobs reject 'aborted' before spawning, the live child is kill-treed.
   */
  cancelMigrate(): void {
    for (const ctx of this.migrations) {
      ctx.cancelled = true
      const child = ctx.child
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        killTree(child)
      }
    }
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

  /**
   * Shared runner for the NDJSON migration commands: queue the job,
   * register a cancellable context, line-split stdout, and forward every
   * line that parses as `schema` (non-event noise is dropped). Resolves
   * with the raw exit; callers map exit codes. A cancel rejects 'aborted'.
   */
  private runMigration<T>(
    args: string[],
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    onEvent: (event: T) => void
  ): Promise<RunResult> {
    const ctx: ExportContext = { child: null, cancelled: false }
    this.migrations.add(ctx)
    return this.queue.add(async () => {
      try {
        if (ctx.cancelled) throw new EngineError(3, 'aborted', 'cancelled while queued')
        const result = await this.run(args, {
          onStdoutLine: (line) => {
            let raw: unknown
            try {
              raw = JSON.parse(line)
            } catch {
              return // non-event stdout noise
            }
            const check = schema.safeParse(raw)
            if (check.success) onEvent(check.data)
          },
          onSpawn: (child) => {
            ctx.child = child
          }
        })
        ctx.child = null
        if (ctx.cancelled) throw new EngineError(3, 'aborted', result.stderr)
        return result
      } finally {
        this.migrations.delete(ctx)
      }
    })
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
