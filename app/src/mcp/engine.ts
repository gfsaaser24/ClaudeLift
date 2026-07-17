/**
 * Engine wrapper for the ClaudeLift MCP server.
 *
 * This module is the MCP server's ONLY door to the cowork-export sidecar.
 * It deliberately imports NO electron — it runs inside a standalone stdio
 * MCP process (server.cjs), not the Electron main process. The spawn rules
 * are cribbed from `src/main/engine.ts` (the EngineService): stdin is
 * `ignore`d (the engine calls input() for some flags — an open-idle pipe
 * hangs, EOF aborts exit 3), `windowsHide: true`, stdout/stderr read as
 * utf8 and fully drained, and every non-zero exit surfaces as a thrown
 * Error carrying the engine's first stderr line.
 *
 * Engine exit map (from the sidecar): 0 ok · 1 no-match / nothing-exported ·
 * 2 validation · 3 confirm-abort · 4 crash.
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { taskFromEngine, type CoworkTask, type TaskSource } from '../shared/ipc'

/** Longest an engine invocation may run before we kill it. */
const ENGINE_TIMEOUT_MS = 120_000

/** Cap on retained stderr (bytes) — engines can be chatty; we only surface the first line. */
const STDERR_CAP = 256 * 1024

/** Task ids are UUID-shaped; a strict charset also blocks argparse option injection. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The session files whose presence defines a bundle's `formats`. */
const SESSION_FORMATS = ['html', 'md', 'json', 'csv'] as const

/**
 * Validate a client-supplied task selector before it reaches the engine.
 * Mirrors the guard the Electron EngineService applies (main/engine.ts):
 * rejects the reserved selectors `all`/`latest` (which would export every
 * task on the machine) and anything argparse would parse as a flag (leading
 * `-`), plus constrains to the real id charset.
 */
export function validateTaskId(raw: string): string {
  const id = raw.trim()
  if (id.length === 0) throw new Error('task_id is required')
  if (id === 'all' || id === 'latest') {
    throw new Error(
      `task_id "${id}" is a reserved engine selector — pass a specific task id from claudelift_list_tasks`
    )
  }
  if (!TASK_ID_RE.test(id)) {
    throw new Error(
      `task_id "${id}" is not a valid task id (letters, digits, '.', '_', '-'; no leading '-')`
    )
  }
  return id
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface BundleSummary {
  dir: string
  taskId: string
  title: string
  exportedAt: string
  sizeBytes: number
  formats: string[]
}

/**
 * Resolve the cowork-export sidecar path. `CLAUDELIFT_ENGINE_EXE` wins when
 * set; otherwise resolve relative to this bundle: at runtime server.cjs
 * lives at <install>/resources/mcp/server.cjs and the sidecar at
 * <install>/resources/engine/cowork-export/cowork-export.exe, so `..` from
 * __dirname lands on `resources/`.
 */
export function resolveEngineExe(): string {
  const override = process.env.CLAUDELIFT_ENGINE_EXE
  const exe =
    override !== undefined && override.length > 0
      ? override
      : join(__dirname, '..', 'engine', 'cowork-export', 'cowork-export.exe')
  if (!existsSync(exe)) {
    throw new Error(
      `cowork-export engine not found at ${exe}. ` +
        'Set CLAUDELIFT_ENGINE_EXE to the sidecar path if it lives elsewhere.'
    )
  }
  return exe
}

/**
 * Single-flight chain: the engine mutates a shared bundle directory and a
 * single client can fire concurrent tool calls, so — like the Electron
 * EngineService (p-queue concurrency 1) — we serialize every spawn.
 */
let engineQueue: Promise<unknown> = Promise.resolve()

/**
 * Spawn the sidecar with `args` and resolve once it exits and both pipes
 * are drained. Serialized against every other `runEngine` call. Never
 * rejects on a non-zero exit — callers decide what a given exit code means
 * (see `ensureOk`). Rejects only on spawn failure or the 120s timeout.
 */
export function runEngine(args: string[]): Promise<RunResult> {
  const run = (): Promise<RunResult> => spawnEngine(args)
  const result = engineQueue.then(run, run)
  // Keep the chain alive regardless of this call's outcome.
  engineQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** Forcefully reap the child and its whole process tree (Windows). */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  const pid = child.pid
  if (pid === undefined) return
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
    /* best-effort tree kill */
  })
}

function spawnEngine(args: string[]): Promise<RunResult> {
  const exe = resolveEngineExe()
  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      rejectPromise(new Error(`failed to spawn engine at ${exe}: ${errText(err)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      rejectPromise(new Error(`engine timed out after ${ENGINE_TIMEOUT_MS / 1000}s: ${args.join(' ')}`))
    }, ENGINE_TIMEOUT_MS)
    timer.unref()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    // Bound stderr — we only ever surface its first line.
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new Error(`failed to spawn engine at ${exe}: ${errText(err)}`))
    })
    // 'close' fires once the process exited AND both pipes are drained.
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** List tasks via `list --json`, mapped through the shared engine schema. */
export async function listTasks(source: TaskSource, coworkRoot?: string): Promise<CoworkTask[]> {
  const args = ['list', '--json', '--source', source]
  if (coworkRoot !== undefined && coworkRoot.length > 0) args.push('--cowork-root', coworkRoot)
  const result = await runEngine(args)
  ensureOk(result, 'list')
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`engine list emitted unparseable JSON: ${result.stdout.slice(0, 500)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('engine list did not return a JSON array')
  return parsed.map((raw) => taskFromEngine(raw))
}

/**
 * Render a task's transcript. Exports to a throwaway temp dir with
 * `--no-files` (fast — renders session.* + manifest + transcript without
 * copying uploads/outputs), reads `session.<md|json>`, then deletes temp.
 */
export async function getTranscript(taskId: string, format: 'md' | 'json'): Promise<string> {
  const id = validateTaskId(taskId)
  const tmp = freshTempDir()
  try {
    await mkdir(tmp, { recursive: true })
    const result = await runEngine(['export', id, '--formats', format, '--no-files', '-o', tmp])
    ensureOk(result, 'export')
    const bundle = await bundleDirFor(tmp, id)
    return await readFile(join(bundle, `session.${format}`), 'utf8')
  } finally {
    await cleanup(tmp)
  }
}

/**
 * Build a paste-able seed prompt. Exports an `--no-files` md bundle to temp
 * (which carries manifest.json + transcript.jsonl, the inputs `seed` needs),
 * runs `seed` against it, reads the result, then deletes temp.
 */
export async function makeSeed(taskId: string, mode: 'brief' | 'standard' | 'full'): Promise<string> {
  const id = validateTaskId(taskId)
  const tmp = freshTempDir()
  try {
    await mkdir(tmp, { recursive: true })
    const exported = await runEngine(['export', id, '--formats', 'md', '--no-files', '-o', tmp])
    ensureOk(exported, 'export')
    const bundle = await bundleDirFor(tmp, id)
    const seedPath = join(tmp, 'seed.md')
    const seeded = await runEngine(['seed', bundle, '--mode', mode, '-o', seedPath])
    ensureOk(seeded, 'seed')
    return await readFile(seedPath, 'utf8')
  } finally {
    await cleanup(tmp)
  }
}

/**
 * Run a real export into `outputDir` (uploads/outputs included), then read
 * back the bundle's manifest. Returns the bundle dir and parsed manifest.
 */
export async function exportTask(
  taskId: string,
  formats: string[],
  outputDir: string
): Promise<{ bundleDir: string; manifest: Record<string, unknown> }> {
  const id = validateTaskId(taskId)
  const out = resolve(outputDir)
  await mkdir(out, { recursive: true })
  const result = await runEngine(['export', id, '--formats', formats.join(','), '-o', out])
  ensureOk(result, 'export')
  // The engine resolves an id/prefix to the full id and names the bundle
  // dir after it, so don't assume join(out, id) — parse the "exported <id>
  // → <dir>" line, falling back to join(out, id) for a full-id export.
  const bundleDir = exportTargetDir(result.stdout, out, id)
  const manifest = await readJsonObject(join(bundleDir, 'manifest.json'))
  if (manifest === null) {
    throw new Error(`export finished but no readable manifest at ${join(bundleDir, 'manifest.json')}`)
  }
  return { bundleDir, manifest }
}

/**
 * The bundle directory an `export` wrote, parsed from its "exported <id> →
 * <dir>" stdout line; falls back to `join(out, taskId)` when the line can't
 * be parsed (the normal full-id case still resolves correctly).
 */
function exportTargetDir(stdout: string, out: string, taskId: string): string {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('exported')) continue
    const arrow = line.indexOf('→') // "→"
    if (arrow === -1) continue
    const target = line.slice(arrow + 1).trim()
    if (target.length > 0) return target
  }
  return join(out, taskId)
}

/**
 * Scan `dir` one level deep for export bundles. A directory qualifies when
 * it has a parseable `manifest.json`; malformed/missing manifests skip the
 * dir (a half-written export never breaks the scan). BOM and parse errors
 * are tolerated per file.
 */
export async function scanBundles(dir: string): Promise<BundleSummary[]> {
  const root = resolve(dir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // no such dir yet — nothing exported here
  }

  const bundles: BundleSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bundleDir = join(root, entry.name)
    const manifest = await readJsonObject(join(bundleDir, 'manifest.json'))
    if (manifest === null) continue // not a bundle

    const task = await readJsonObject(join(bundleDir, 'task.json'))
    const taskId = str(manifest.source_task_id) ?? entry.name
    const title =
      (task !== null ? str(task.title) ?? str(task.aiTitle) : null) ?? taskId
    const exportedAt = str(manifest.exported_at) ?? ''

    const formats: string[] = []
    for (const format of SESSION_FORMATS) {
      if (existsSync(join(bundleDir, `session.${format}`))) formats.push(format)
    }

    bundles.push({
      dir: bundleDir,
      taskId,
      title,
      exportedAt,
      sizeBytes: await dirSize(bundleDir),
      formats
    })
  }
  // Newest first; exported_at is ISO-8601 UTC so string order == time order.
  bundles.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
  return bundles
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** First non-empty trimmed stderr line, for surfacing engine failures. */
function firstStderrLine(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

/** Throw a clear Error (with the engine's first stderr line) on non-zero exit. */
function ensureOk(result: RunResult, action: string): void {
  if (result.code === 0) return
  const detail = firstStderrLine(result.stderr)
  throw new Error(`engine ${action} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`)
}

function freshTempDir(): string {
  return join(tmpdir(), `claudelift-mcp-${randomUUID()}`)
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {
    /* best-effort */
  })
}

/**
 * The bundle subdir is normally `<tmp>/<taskId>`, but if a task-id prefix
 * was passed the engine resolves it to the full id and names the dir after
 * that. Fall back to the sole subdirectory in that case.
 */
async function bundleDirFor(tmp: string, taskId: string): Promise<string> {
  const exact = join(tmp, taskId)
  if (existsSync(exact)) return exact
  const entries = await readdir(tmp, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length === 1) return join(tmp, dirs[0].name)
  throw new Error(`export produced no bundle for "${taskId}"`)
}

/** Node's utf8 read keeps a leading BOM; JSON.parse rejects it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function readJsonObject(path: string): Promise<JsonObject | null> {
  try {
    const parsed: unknown = JSON.parse(stripBom(await readFile(path, 'utf8')))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null
  } catch {
    return null
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Recursive `du`; unreadable entries count as 0. */
async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(path)
    } else if (entry.isFile()) {
      try {
        total += (await stat(path)).size
      } catch {
        /* deleted mid-scan — ignore */
      }
    }
  }
  return total
}
