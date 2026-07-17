/**
 * NotionExporter (Task 13): the zip → upload → database → page → append
 * state machine that publishes one exported bundle to Notion.
 *
 * Step order (binding, from the plan) with journal status at each stage:
 *   1. resolve bundle (bundleDir given → use it; taskId only → look for
 *      `<settings.outputDir>/<taskId>/manifest.json`, else run the engine
 *      export first with settings defaults)                       [queued]
 *   2. zip the bundle dir via archiver into
 *      `<temp>/cowork-notion/<taskId>.zip` — auth/ ALWAYS excluded [zipping]
 *   3. size-check vs NotionConfig.maxUploadBytes → over: skip the zip and
 *      note it in the page callout instead
 *   4. upload (≤20MB single-part, else 10MB multi-part with ≤3 parts in
 *      flight — the client's serialized queue still paces the wire)
 *                                                               [uploading]
 *   5. ensure database: verify stored ids via getDatabase; create under
 *      parentPageId when missing; store databaseId + dataSourceId
 *   6. update-or-create: queryDataSource `Task ID equals` → archive any
 *      existing page (PATCH archived: true) THEN create fresh
 *   7. create page: properties + children = metadata callout (+ file block
 *      for the zip) + first ≤100 martian blocks of session.md   [creating]
 *   8. append the remaining chunks sequentially                [appending]
 *   9. page url into the journal                                    [done]
 *
 * Every transition emits `evt:notionProgress` AND patches the persisted
 * journal (StateStore.patchNotionJournal). The journal makes runs
 * resumable in the practical sense: it survives restarts, the UI can show
 * the last known state, and a retry safely re-runs the whole pipeline —
 * step 6 (archive-then-create) makes repeated runs idempotent, so no
 * partial-progress bookkeeping beyond the status string is needed.
 *
 * "Messages" property: the count of `/^##\s/m` occurrences in session.md —
 * a cheap proxy for conversation size (H2 section headings), per the plan;
 * it is NOT an exact turn count.
 *
 * The temp zip is deleted right after a successful upload (or a size
 * skip), and the whole `<temp>/cowork-notion` dir is purged once on
 * exporter construction to drop leftovers from crashed runs.
 *
 * Errors never reject `exportTask` — they are journaled as status 'error'
 * and emitted, so IPC callers can fire-and-forget.
 */
import { app } from 'electron'
import { createWriteStream, rmSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { markdownToBlocks } from '@tryfabric/martian'
import PQueue from 'p-queue'
import {
  ExportFormatSchema,
  type ExportFormat,
  type NotionExportRequest,
  type NotionExportState
} from '../../shared/ipc'
import { EngineError, type EngineService } from '../engine'
import type { StateStore } from '../state'
import {
  MAX_BLOCKS_PER_REQUEST,
  NotionApiError,
  NotionClient,
  pickUploadMode,
  safeFilename
} from './client'

/** Subdirectory of the OS temp dir that holds in-flight zips. */
const TEMP_SUBDIR = 'cowork-notion'
/** Title of the auto-created Notion database. */
const DATABASE_TITLE = 'Cowork Exports'
/** Multi-part uploads keep at most this many parts in flight. */
const MAX_PARALLEL_PARTS = 3
/** All four engine formats — the fallback when settings.formats is unusable. */
const ALL_FORMATS: ExportFormat[] = ['html', 'md', 'json', 'csv']

/**
 * Database property schema (binding, from the plan). 2025-09-03 API:
 * passed as `initial_data_source.properties` on database creation.
 */
const DATABASE_SCHEMA: Record<string, unknown> = {
  Name: { title: {} },
  'Exported At': { date: {} },
  'Task ID': { rich_text: {} },
  Model: { select: {} },
  Space: { select: {} },
  Messages: { number: {} },
  Bundle: { files: {} }
}

// ---------------------------------------------------------------------------
// archiver (CJS, ships no type declarations; @types/archiver would be a new
// dependency, which the task forbids — so a minimal typed surface + a
// createRequire load, which also keeps the dep external in the CJS bundle)
// ---------------------------------------------------------------------------

interface ArchiverEntryData {
  name: string
  [key: string]: unknown
}

interface ZipArchiver {
  on(event: 'error' | 'warning', listener: (err: Error) => void): ZipArchiver
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream
  directory(
    dirpath: string,
    destpath: string | false,
    data?: (entry: ArchiverEntryData) => ArchiverEntryData | false
  ): ZipArchiver
  finalize(): Promise<void>
}

type ArchiverFactory = (format: 'zip', options?: { zlib?: { level?: number } }) => ZipArchiver

const requireModule = createRequire(__filename)
const createArchiver = requireModule('archiver') as ArchiverFactory

// ---------------------------------------------------------------------------
// Bundle metadata (parsed from manifest.json + session.md — offline, no
// engine spawn needed when the bundle already exists)
// ---------------------------------------------------------------------------

interface BundleMeta {
  dir: string
  taskId: string
  title: string
  model: string | null
  spaceName: string | null
  /** `/^##\s/m` occurrences in session.md — cheap proxy, see module doc. */
  messages: number | null
  /** manifest `exported_at` (ISO 8601) or null. */
  exportedAt: string | null
  sessionMd: string | null
}

interface ZipResult {
  path: string
  sizeBytes: number
}

interface UploadResult {
  id: string
  filename: string
}

function parseManifest(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest.json is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

function manifestString(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function matchLine(md: string, re: RegExp): string | null {
  const match = re.exec(md)
  return match === null ? null : match[1].trim()
}

/** Documented proxy: count of `## ` headings (H2) in session.md. */
function countMessagesProxy(sessionMd: string): number {
  return (sessionMd.match(/^##\s/gm) ?? []).length
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]
}

function errorMessage(err: unknown): string {
  if (err instanceof EngineError) {
    const detail = firstLine(err.stderr)
    return detail.length > 0 ? `${err.message} — ${detail}` : err.message
  }
  if (err instanceof NotionApiError) return `Notion API: ${err.message} (${err.code})`
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

/**
 * Post-process martian output: martian resolves every code-block language
 * through its alias map and leaves UNKNOWN languages as `undefined`, which
 * the Notion API rejects — map those (and any non-string leftovers) to
 * 'plain text'. Recurses because code blocks can nest inside quotes, list
 * items, etc.
 */
export function sanitizeCodeLanguages(blocks: unknown[]): unknown[] {
  for (const block of blocks) visitBlock(block)
  return blocks
}

function visitBlock(node: unknown): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) visitBlock(item)
    return
  }
  const record = node as Record<string, unknown>
  const code = record['code']
  if (record['type'] === 'code' && code !== null && typeof code === 'object') {
    const codeRecord = code as Record<string, unknown>
    const lang = codeRecord['language']
    if (typeof lang !== 'string' || lang.length === 0) {
      codeRecord['language'] = 'plain text'
    }
  }
  for (const value of Object.values(record)) visitBlock(value)
}

function textRichText(content: string): unknown[] {
  return [{ type: 'text', text: { content } }]
}

function metadataCallout(meta: BundleMeta, exportedAtIso: string, note: string | null): unknown {
  const lines = [
    `Exported from Claude Cowork on ${exportedAtIso}`,
    `Task ID: ${meta.taskId}`
  ]
  if (meta.model !== null) lines.push(`Model: ${meta.model}`)
  if (meta.spaceName !== null) lines.push(`Space: ${meta.spaceName}`)
  if (meta.messages !== null) lines.push(`Sections: ${meta.messages}`)
  if (note !== null) lines.push(note)
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '\u{1F4E6}' },
      rich_text: textRichText(lines.join('\n').slice(0, 2000))
    }
  }
}

function zipFileBlock(upload: UploadResult): unknown {
  return {
    object: 'block',
    type: 'file',
    file: {
      type: 'file_upload',
      file_upload: { id: upload.id },
      caption: textRichText(upload.filename)
    }
  }
}

/** Select option names: no commas, ≤100 chars. */
function selectName(value: string): string {
  const cleaned = value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

function pageProperties(
  meta: BundleMeta,
  exportedAtIso: string,
  upload: UploadResult | null
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    Name: { title: textRichText(meta.title.slice(0, 2000)) },
    'Exported At': { date: { start: exportedAtIso } },
    'Task ID': { rich_text: textRichText(meta.taskId) }
  }
  if (meta.model !== null) properties['Model'] = { select: { name: selectName(meta.model) } }
  if (meta.spaceName !== null) {
    properties['Space'] = { select: { name: selectName(meta.spaceName) } }
  }
  if (meta.messages !== null) properties['Messages'] = { number: meta.messages }
  if (upload !== null) {
    properties['Bundle'] = {
      files: [{ name: upload.filename, type: 'file_upload', file_upload: { id: upload.id } }]
    }
  }
  return properties
}

// ---------------------------------------------------------------------------
// NotionExporter
// ---------------------------------------------------------------------------

export interface NotionExporterDeps {
  state: StateStore
  engine: EngineService
  sendProgress: (state: NotionExportState) => void
  /** Client factory — a fresh client per run, from the current token. */
  createClient?: (token: string) => NotionClient
}

export class NotionExporter {
  private readonly state: StateStore
  private readonly engine: EngineService
  private readonly sendProgress: (state: NotionExportState) => void
  private readonly createClient: (token: string) => NotionClient
  /** One export at a time — runs queue up behind each other. */
  private readonly queue = new PQueue({ concurrency: 1 })

  constructor(deps: NotionExporterDeps) {
    this.state = deps.state
    this.engine = deps.engine
    this.sendProgress = deps.sendProgress
    this.createClient = deps.createClient ?? ((token) => new NotionClient({ token }))
    purgeStaleTempDir()
  }

  /**
   * Publish one task/bundle to Notion. Never rejects: failures are
   * journaled (status 'error') and emitted on `evt:notionProgress`.
   */
  exportTask(req: NotionExportRequest): Promise<void> {
    return this.queue.add(() => this.runExport(req))
  }

  // -------------------------------------------------------------------------
  // pipeline
  // -------------------------------------------------------------------------

  private async runExport(req: NotionExportRequest): Promise<void> {
    let taskId =
      req.taskId ?? (req.bundleDir !== undefined ? basename(req.bundleDir) : 'unknown')
    let pageUrl: string | null = null
    try {
      const token = this.state.getNotionToken()
      if (token === null) {
        throw new Error('Not connected to Notion — add your integration token first.')
      }
      const config = this.state.getNotionConfig()
      if (config.parentPageId === null) {
        throw new Error('No Notion parent page set — paste a page URL in the Notion tab first.')
      }
      const client = this.createClient(token)

      // 1. resolve bundle (may run an engine export first)
      this.emit(taskId, 'queued', 'Resolving bundle…')
      const meta = await this.resolveBundle(req, (message) =>
        this.emit(taskId, 'queued', message)
      )
      taskId = meta.taskId

      // 2. zipping (auth/ always excluded)
      this.emit(taskId, 'zipping', 'Zipping bundle (auth/ excluded)…')
      const zip = await zipBundleDir(meta.dir, taskId)

      // 3. size check vs the workspace upload limit
      const maxUploadBytes = this.state.getNotionConfig().maxUploadBytes
      let upload: UploadResult | null = null
      let sizeNote: string | null = null
      if (maxUploadBytes !== null && zip.sizeBytes > maxUploadBytes) {
        sizeNote =
          `Bundle zip (${formatBytes(zip.sizeBytes)}) exceeds the workspace upload limit ` +
          `(${formatBytes(maxUploadBytes)}) — attachment skipped.`
        await rm(zip.path, { force: true })
        this.emit(taskId, 'uploading', sizeNote)
      } else {
        // 4. uploading (single-part or multi-part, ≤3 parts in flight)
        this.emit(taskId, 'uploading', `Uploading zip (${formatBytes(zip.sizeBytes)})…`)
        upload = await this.uploadZip(client, zip, meta, taskId)
        await rm(zip.path, { force: true }) // temp zip deleted after upload success
      }

      // 5. ensure database (verify stored ids, else create + store)
      this.emit(taskId, 'creating', 'Preparing Notion database…')
      const dataSourceId = await this.ensureDatabase(client, config.parentPageId)

      // 6. update-or-create: archive any existing page for this task id
      const existing = await client.queryDataSource(dataSourceId, {
        property: 'Task ID',
        rich_text: { equals: taskId }
      })
      for (const page of existing.results) {
        this.emit(taskId, 'creating', 'Archiving previous Notion page…')
        await client.archivePage(page.id)
      }

      // 7. create the page: callout (+ file block) + first ≤100 blocks
      this.emit(taskId, 'creating', 'Creating Notion page…')
      const exportedAtIso = meta.exportedAt ?? new Date().toISOString()
      const mdBlocks =
        meta.sessionMd === null
          ? []
          : sanitizeCodeLanguages(
              markdownToBlocks(meta.sessionMd, { notionLimits: { truncate: true } })
            )
      const prelude: unknown[] = [metadataCallout(meta, exportedAtIso, sizeNote)]
      if (upload !== null) prelude.push(zipFileBlock(upload))
      const headroom = Math.max(0, MAX_BLOCKS_PER_REQUEST - prelude.length)
      const head = mdBlocks.slice(0, headroom)
      const rest = mdBlocks.slice(headroom)
      const page = await client.createPage(
        dataSourceId,
        pageProperties(meta, exportedAtIso, upload),
        [...prelude, ...head]
      )
      pageUrl = page.url ?? null

      // 8. appending: remaining chunks, sequential (client chunks ≤100)
      if (rest.length > 0) {
        this.emit(taskId, 'appending', `Appending ${rest.length} more blocks…`, pageUrl)
        await client.appendBlocks(page.id, rest)
      }

      // 9. done
      this.emit(taskId, 'done', 'Exported to Notion.', pageUrl)
    } catch (err) {
      this.emit(taskId, 'error', errorMessage(err), pageUrl)
    }
  }

  /** Journal patch + renderer event — every state transition goes here. */
  private emit(
    taskId: string,
    status: NotionExportState['status'],
    message: string,
    pageUrl: string | null = null
  ): void {
    const state: NotionExportState = { taskId, status, message, pageUrl }
    try {
      this.state.patchNotionJournal(taskId, state)
    } catch {
      /* journaling must never kill the export */
    }
    this.sendProgress(state)
  }

  /**
   * Locate the bundle for the request. bundleDir given → use it as-is;
   * taskId only → `<settings.outputDir>/<taskId>`, running the engine
   * export first (settings defaults, nothing risky) when manifest.json is
   * missing. Metadata comes from manifest.json + session.md so an already
   * exported bundle publishes without any engine spawn.
   */
  private async resolveBundle(
    req: NotionExportRequest,
    onStatus: (message: string) => void
  ): Promise<BundleMeta> {
    const settings = this.state.getSettings()
    let dir = req.bundleDir ?? join(settings.outputDir, req.taskId ?? '')

    if (!(await fileExists(join(dir, 'manifest.json')))) {
      if (req.taskId === undefined) {
        throw new Error(`Not a valid bundle (missing manifest.json): ${dir}`)
      }
      onStatus('No bundle yet — exporting from Cowork first…')
      const formats = settings.formats.filter(
        (format): format is ExportFormat => ExportFormatSchema.safeParse(format).success
      )
      await this.engine.exportTasks(
        {
          taskIds: [req.taskId],
          outputDir: settings.outputDir,
          formats: formats.length > 0 ? formats : ALL_FORMATS,
          noFiles: false,
          includeAuth: false,
          purgeSource: false,
          source: settings.source,
          ...(settings.coworkRootOverride !== null
            ? { coworkRoot: settings.coworkRootOverride }
            : {})
        },
        () => {
          /* progress detail not surfaced — one status line suffices here */
        },
        'notion' // tagged so the UI Cancel button cannot kill this export
      )
      dir = join(settings.outputDir, req.taskId)
      if (!(await fileExists(join(dir, 'manifest.json')))) {
        throw new Error(`Engine export finished but no bundle appeared at: ${dir}`)
      }
    }

    const manifest = parseManifest(await readFile(join(dir, 'manifest.json'), 'utf8'))
    const taskId = req.taskId ?? manifestString(manifest, 'source_task_id') ?? basename(dir)

    let sessionMd: string | null = null
    try {
      sessionMd = await readFile(join(dir, 'session.md'), 'utf8')
    } catch {
      sessionMd = null // md format not exported — page gets the callout only
    }

    const title =
      (sessionMd !== null ? matchLine(sessionMd, /^#\s+(.+)$/m) : null) ??
      `Cowork task ${taskId.slice(0, 8)}`
    return {
      dir,
      taskId,
      title,
      model: sessionMd !== null ? matchLine(sessionMd, /^- \*\*Model:\*\* (.+)$/m) : null,
      spaceName: sessionMd !== null ? matchLine(sessionMd, /^- \*\*Space:\*\* (.+)$/m) : null,
      messages: sessionMd !== null ? countMessagesProxy(sessionMd) : null,
      exportedAt: manifestString(manifest, 'exported_at'),
      sessionMd
    }
  }

  /**
   * Upload the zip: ≤20MB single-part, else 10MB multi-part with a small
   * worker pool (≤3 parts in flight; the client's serialized queue still
   * spaces the actual requests ≥340ms apart).
   */
  private async uploadZip(
    client: NotionClient,
    zip: ZipResult,
    meta: BundleMeta,
    taskId: string
  ): Promise<UploadResult> {
    const filename = safeFilename(meta.title, taskId)
    const mode = pickUploadMode(zip.sizeBytes)

    if (mode.mode === 'single') {
      const created = await client.createFileUpload({
        filename,
        contentType: 'application/zip'
      })
      await client.sendFileUploadPart(created.id, await readFile(zip.path))
      return { id: created.id, filename }
    }

    const created = await client.createFileUpload({
      filename,
      contentType: 'application/zip',
      mode: 'multi_part',
      numberOfParts: mode.parts
    })
    const handle = await open(zip.path, 'r')
    try {
      let nextPart = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = nextPart
          nextPart += 1
          if (index >= mode.parts) return
          const partNumber = index + 1
          const offset = index * mode.partSize
          const length = Math.min(mode.partSize, zip.sizeBytes - offset)
          const buffer = Buffer.alloc(length)
          await handle.read(buffer, 0, length, offset)
          this.emit(taskId, 'uploading', `Uploading part ${partNumber}/${mode.parts}…`)
          await client.sendFileUploadPart(created.id, buffer, partNumber)
        }
      }
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_PARTS, mode.parts) }, () =>
        worker()
      )
      await Promise.all(workers)
    } finally {
      await handle.close()
    }
    await client.completeFileUpload(created.id)
    return { id: created.id, filename }
  }

  /**
   * Return a usable data source id: verify the stored databaseId (and that
   * the stored dataSourceId still belongs to it), or create the database
   * under the parent page and persist both ids.
   */
  private async ensureDatabase(client: NotionClient, parentPageId: string): Promise<string> {
    const config = this.state.getNotionConfig()
    if (config.databaseId !== null) {
      try {
        const db = await client.getDatabase(config.databaseId)
        if (db.archived !== true && db.in_trash !== true) {
          const sources = db.data_sources ?? []
          const stored = sources.find((source) => source.id === config.dataSourceId)
          const dataSourceId = stored?.id ?? sources[0]?.id
          if (dataSourceId !== undefined) {
            if (dataSourceId !== config.dataSourceId) {
              this.state.setNotionConfig({ ...config, dataSourceId })
            }
            return dataSourceId
          }
        }
        // archived / trashed / no data sources → fall through and recreate
      } catch (err) {
        // 404 = deleted or unshared → recreate; anything else is fatal
        if (!(err instanceof NotionApiError && err.status === 404)) throw err
      }
    }

    const db = await client.createDatabase(parentPageId, DATABASE_TITLE, DATABASE_SCHEMA)
    const dataSourceId = db.data_sources?.[0]?.id
    if (dataSourceId === undefined) {
      throw new Error('Notion did not return a data source id for the new database.')
    }
    this.state.setNotionConfig({
      ...this.state.getNotionConfig(),
      databaseId: db.id,
      dataSourceId
    })
    return dataSourceId
  }
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function tempZipDir(): string {
  return join(app.getPath('temp'), TEMP_SUBDIR)
}

/**
 * Purge `<temp>/cowork-notion` once at exporter construction: successful
 * runs delete their own zip, so anything still there is a leftover from a
 * crashed or killed run. Best-effort.
 */
function purgeStaleTempDir(): void {
  try {
    rmSync(tempZipDir(), { recursive: true, force: true })
  } catch {
    /* locked file etc. — the next successful run cleans up after itself */
  }
}

/**
 * Zip `bundleDir` into `<temp>/cowork-notion/<taskId>.zip`. The `auth/`
 * directory is ALWAYS excluded — the bundle may contain live Claude
 * credentials and those must never reach Notion.
 */
async function zipBundleDir(bundleDir: string, taskId: string): Promise<ZipResult> {
  const dir = tempZipDir()
  await mkdir(dir, { recursive: true })
  const zipPath = join(dir, `${taskId}.zip`)
  await rm(zipPath, { force: true })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(zipPath)
    const archive = createArchiver('zip', { zlib: { level: 9 } })
    output.on('close', () => resolvePromise())
    output.on('error', rejectPromise)
    archive.on('error', rejectPromise)
    archive.pipe(output)
    archive.directory(bundleDir, false, (entry) => {
      const name = entry.name.replace(/\\/g, '/')
      return name === 'auth' || name.startsWith('auth/') ? false : entry
    })
    void archive.finalize()
  })

  const { size } = await stat(zipPath)
  return { path: zipPath, sizeBytes: size }
}
