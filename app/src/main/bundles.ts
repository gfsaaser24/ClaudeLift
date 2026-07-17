/**
 * Bundle-directory scanner (Task 12).
 *
 * `scanBundles(outputDir)` walks ONE level of the export output directory
 * and turns every subdirectory that carries a parseable `manifest.json`
 * into a `BundleInfo` (shared/ipc schema). Malformed or missing manifests
 * skip the directory — a half-written export never breaks the scan.
 *
 * `readBundleMarkdown(bundleDir)` reads the bundle's `session.md` through
 * a file handle capped at 2 MB (`{text, truncated}`), never buffering more
 * than the cap. The directory is normalized and must contain a
 * `manifest.json` so arbitrary files outside bundle dirs are not readable
 * through this channel.
 */
import type { Dirent } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { BundleInfo, ReadMarkdownResult } from '../shared/ipc'

/** `bundles:readMarkdown` cap: session.md is truncated at 2 MB. */
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

/**
 * Recursive-size budget for one whole scan: once 30s elapse, remaining
 * directory walks stop and report the bytes summed so far (never hangs the
 * scan on a pathological bundle tree).
 */
const SIZE_BUDGET_MS = 30_000

/** The session files whose presence defines a bundle's `formats`. */
const SESSION_FORMATS = ['html', 'md', 'json', 'csv'] as const

/**
 * Tolerant manifest reader: unknown keys are ignored, wrong-typed known
 * keys fall back per-field instead of rejecting the whole manifest.
 */
const ManifestSchema = z.object({
  exported_at: z.string().catch(''),
  source_platform: z.string().catch(''),
  source_task_id: z.string().catch(''),
  source_user_folders: z.array(z.string()).catch([])
})

type Manifest = z.infer<typeof ManifestSchema>

const TaskJsonSchema = z.object({
  title: z.string().catch(''),
  aiTitle: z.string().catch('')
})

/** Node's utf8 read keeps a leading BOM; JSON.parse rejects it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Parse `<dir>/manifest.json`; null (→ skip the dir) when absent/malformed. */
async function readManifest(dir: string): Promise<Manifest | null> {
  let raw: unknown
  try {
    raw = JSON.parse(stripBom(await readFile(join(dir, 'manifest.json'), 'utf8')))
  } catch {
    return null // missing or unparseable — not a bundle
  }
  const parsed = ManifestSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Bundle title: task.json `title` (fallback `aiTitle`), else the task id. */
async function readTitle(dir: string, fallback: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(stripBom(await readFile(join(dir, 'task.json'), 'utf8')))
    const parsed = TaskJsonSchema.safeParse(raw)
    if (parsed.success) {
      const title = parsed.data.title || parsed.data.aiTitle
      if (title !== '') return title
    }
  } catch {
    // no task.json / malformed — fall through
  }
  return fallback
}

/**
 * Recursive `du` via fs.promises. Unreadable entries count as 0; once
 * `deadline` (epoch ms) passes, the walk short-circuits and returns the
 * partial sum.
 */
async function duRecursive(dir: string, deadline: number): Promise<number> {
  if (Date.now() > deadline) return 0
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (Date.now() > deadline) break
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await duRecursive(path, deadline)
    } else if (entry.isFile()) {
      try {
        total += (await stat(path)).size
      } catch {
        // deleted mid-scan — ignore
      }
    }
  }
  return total
}

async function bundleFromDir(dir: string, deadline: number): Promise<BundleInfo | null> {
  const manifest = await readManifest(dir)
  if (manifest === null) return null

  const formats: string[] = []
  for (const format of SESSION_FORMATS) {
    if (await isFile(join(dir, `session.${format}`))) formats.push(format)
  }

  return {
    dir,
    taskId: manifest.source_task_id,
    title: await readTitle(dir, manifest.source_task_id),
    exportedAt: manifest.exported_at,
    sourcePlatform: manifest.source_platform,
    sizeBytes: await duRecursive(dir, deadline),
    formats,
    hasSeed: await isFile(join(dir, 'seed-prompt.md')),
    hasAuth: await isDir(join(dir, 'auth')),
    userFolders: manifest.source_user_folders
  }
}

/**
 * Scan `outputDir` one level deep for bundle directories. A missing or
 * unreadable output directory yields an empty list (not an error) — the
 * user simply has not exported anything there yet.
 */
export async function scanBundles(outputDir: string): Promise<BundleInfo[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(resolve(outputDir), { withFileTypes: true })
  } catch {
    return []
  }
  const deadline = Date.now() + SIZE_BUDGET_MS
  const bundles: BundleInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bundle = await bundleFromDir(join(resolve(outputDir), entry.name), deadline)
    if (bundle !== null) bundles.push(bundle)
  }
  // Newest first; exported_at is ISO-8601 UTC so string order = time order.
  bundles.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
  return bundles
}

/**
 * Read `<bundleDir>/session.md` capped at 2 MB. `bundleDir` comes from our
 * own scan results, but is still normalized and must be a real bundle
 * (manifest.json present) before anything is read.
 */
export async function readBundleMarkdown(bundleDir: string): Promise<ReadMarkdownResult> {
  const dir = resolve(bundleDir)
  if (!(await isFile(join(dir, 'manifest.json')))) {
    throw new Error(`not a bundle directory (missing manifest.json): ${dir}`)
  }
  const file = join(dir, 'session.md')
  if (!(await isFile(file))) {
    throw new Error(`session.md not found: ${file}`)
  }
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const truncated = size > MAX_MARKDOWN_BYTES
    const buf = Buffer.alloc(Math.min(size, MAX_MARKDOWN_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated }
  } finally {
    await handle.close()
  }
}
