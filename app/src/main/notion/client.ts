/**
 * NotionClient (Task 13): the only place that talks HTTP to the Notion API.
 *
 * Rules (binding, from the plan):
 * - base `https://api.notion.com`, global fetch (Node 22+ / Electron 43);
 * - headers `Authorization: Bearer <token>`, `Notion-Version: 2025-09-03`,
 *   `Content-Type: application/json` — EXCEPT multipart sends, where the
 *   body is a FormData and fetch must set the boundary itself;
 * - every request funnels through a serialized p-queue (concurrency 1,
 *   interval 340ms, intervalCap 1) so requests are ≥340ms apart;
 * - 429 → wait `Retry-After` seconds (fallback 2s), retry, max 5 retries;
 * - 5xx → exponential backoff 1s/2s/4s, max 3 retries;
 * - block appends are auto-chunked to ≤100 blocks per request, sequential;
 * - parent pages are created under a `data_source_id` (NOT database_id).
 *
 * Responses are zod-parsed (loose objects — we validate only the fields we
 * consume) per the plan rule "zod-validate every payload crossing IPC or
 * process boundaries".
 *
 * The pure helpers at the bottom (extractPageId, chunkBlocks,
 * pickUploadMode, safeFilename) are unit-tested in tests/notion.unit.test.ts.
 */
import type { Readable } from 'node:stream'
import PQueue from 'p-queue'
import { z } from 'zod'

export const NOTION_BASE_URL = 'https://api.notion.com'
export const NOTION_VERSION = '2025-09-03'

/** Minimum spacing between requests (Notion allows ~3 req/s per token). */
const MIN_REQUEST_INTERVAL_MS = 340
/** 429 handling: retry up to 5 times, waiting Retry-After (fallback 2s). */
const MAX_RATE_LIMIT_RETRIES = 5
const RATE_LIMIT_FALLBACK_MS = 2_000
/** 5xx handling: retry up to 3 times with 1s / 2s / 4s backoff. */
const MAX_SERVER_ERROR_RETRIES = 3
const SERVER_ERROR_BASE_BACKOFF_MS = 1_000

/** Notion hard limit: ≤100 blocks per create/append request. */
export const MAX_BLOCKS_PER_REQUEST = 100
/** File uploads ≤20MB go up in one part; anything larger is multi-part. */
export const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024
/** Multi-part uploads use 10MB parts (Notion requires 5–20MB per part). */
export const MULTI_PART_CHUNK_BYTES = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Response schemas (loose: only the consumed fields are validated)
// ---------------------------------------------------------------------------

export const NotionUserSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  bot: z
    .looseObject({
      workspace_name: z.string().nullish(),
      workspace_limits: z
        .looseObject({
          max_file_upload_size_in_bytes: z.number().nullish()
        })
        .nullish()
    })
    .nullish()
})

export type NotionUser = z.infer<typeof NotionUserSchema>

export const NotionDataSourceRefSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish()
})

export const NotionDatabaseSchema = z.looseObject({
  id: z.string(),
  archived: z.boolean().nullish(),
  in_trash: z.boolean().nullish(),
  data_sources: z.array(NotionDataSourceRefSchema).nullish()
})

export type NotionDatabase = z.infer<typeof NotionDatabaseSchema>

export const NotionPageSchema = z.looseObject({
  id: z.string(),
  url: z.string().nullish(),
  archived: z.boolean().nullish()
})

export type NotionPage = z.infer<typeof NotionPageSchema>

export const NotionQueryResultSchema = z.looseObject({
  results: z.array(NotionPageSchema),
  has_more: z.boolean().nullish(),
  next_cursor: z.string().nullish()
})

export type NotionQueryResult = z.infer<typeof NotionQueryResultSchema>

export const NotionFileUploadSchema = z.looseObject({
  id: z.string(),
  status: z.string().nullish(),
  upload_url: z.string().nullish()
})

export type NotionFileUpload = z.infer<typeof NotionFileUploadSchema>

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** A non-retryable (or retries-exhausted) Notion API failure. */
export class NotionApiError extends Error {
  readonly status: number
  /** Notion error `code` (e.g. `object_not_found`, `unauthorized`). */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'NotionApiError'
    this.status = status
    this.code = code
  }
}

async function apiErrorFromResponse(res: Response): Promise<NotionApiError> {
  let code = 'unknown'
  let message = `Notion API error ${res.status}`
  try {
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed !== null && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>
      if (typeof body['code'] === 'string') code = body['code']
      if (typeof body['message'] === 'string') message = body['message']
    }
  } catch {
    /* non-JSON error body — keep the fallback message */
  }
  return new NotionApiError(res.status, code, message)
}

function retryAfterMs(header: string | null): number {
  if (header === null) return RATE_LIMIT_FALLBACK_MS
  const seconds = Number.parseFloat(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_FALLBACK_MS
  return Math.ceil(seconds * 1000)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CreateFileUploadOptions {
  filename: string
  contentType: string
  mode?: 'single_part' | 'multi_part'
  numberOfParts?: number
}

export interface NotionClientOptions {
  token: string
  /** Test hooks. */
  fetchImpl?: typeof fetch
  minIntervalMs?: number
  sleepImpl?: (ms: number) => Promise<void>
}

export class NotionClient {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  /** Serializes and paces every request: 1 in flight, ≥340ms apart. */
  private readonly queue: PQueue

  constructor(options: NotionClientOptions) {
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.queue = new PQueue({
      concurrency: 1,
      interval: options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS,
      intervalCap: 1
    })
  }

  // -- typed endpoints --------------------------------------------------------

  /** GET /v1/users/me — the bot user (workspace name + upload limits). */
  async me(): Promise<NotionUser> {
    return NotionUserSchema.parse(await this.request('GET', '/v1/users/me'))
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return NotionPageSchema.parse(await this.request('GET', `/v1/pages/${pageId}`))
  }

  /** PATCH /v1/pages/:id {archived: true} — used by update-or-create. */
  async archivePage(pageId: string): Promise<NotionPage> {
    return NotionPageSchema.parse(
      await this.request('PATCH', `/v1/pages/${pageId}`, { json: { archived: true } })
    )
  }

  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return NotionDatabaseSchema.parse(
      await this.request('GET', `/v1/databases/${databaseId}`)
    )
  }

  /**
   * POST /v1/databases — Notion-Version 2025-09-03 shape: the property
   * schema goes under `initial_data_source.properties`, and the response
   * carries the created `data_sources` array.
   */
  async createDatabase(
    parentPageId: string,
    title: string,
    propertiesSchema: Record<string, unknown>
  ): Promise<NotionDatabase> {
    return NotionDatabaseSchema.parse(
      await this.request('POST', '/v1/databases', {
        json: {
          parent: { type: 'page_id', page_id: parentPageId },
          title: [{ type: 'text', text: { content: title } }],
          initial_data_source: { properties: propertiesSchema }
        }
      })
    )
  }

  /** POST /v1/pages — parent is a data_source_id (NOT database_id). */
  async createPage(
    dataSourceId: string,
    properties: Record<string, unknown>,
    children: unknown[]
  ): Promise<NotionPage> {
    return NotionPageSchema.parse(
      await this.request('POST', '/v1/pages', {
        json: {
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          properties,
          children
        }
      })
    )
  }

  /** PATCH /v1/blocks/:id/children — auto-chunked ≤100, strictly sequential. */
  async appendBlocks(pageId: string, blocks: unknown[]): Promise<void> {
    for (const chunk of chunkBlocks(blocks)) {
      await this.request('PATCH', `/v1/blocks/${pageId}/children`, {
        json: { children: chunk }
      })
    }
  }

  /** POST /v1/data_sources/:id/query (2025-09-03 replaces database query). */
  async queryDataSource(dataSourceId: string, filter: unknown): Promise<NotionQueryResult> {
    return NotionQueryResultSchema.parse(
      await this.request('POST', `/v1/data_sources/${dataSourceId}/query`, {
        json: { filter }
      })
    )
  }

  async createFileUpload(opts: CreateFileUploadOptions): Promise<NotionFileUpload> {
    const body: Record<string, unknown> = {
      filename: opts.filename,
      content_type: opts.contentType,
      mode: opts.mode ?? 'single_part'
    }
    if (opts.numberOfParts !== undefined) body['number_of_parts'] = opts.numberOfParts
    return NotionFileUploadSchema.parse(
      await this.request('POST', '/v1/file_uploads', { json: body })
    )
  }

  /**
   * POST /v1/file_uploads/:id/send — multipart/form-data via global
   * FormData + Blob; Content-Type is intentionally NOT set so fetch adds
   * the boundary. `partNumber` is required for multi_part uploads.
   */
  async sendFileUploadPart(
    fileUploadId: string,
    data: Buffer | Readable,
    partNumber?: number
  ): Promise<NotionFileUpload> {
    const buf = Buffer.isBuffer(data) ? data : await collectStream(data)
    const form = new FormData()
    form.append('file', new Blob([toArrayBuffer(buf)], { type: 'application/octet-stream' }))
    if (partNumber !== undefined) form.append('part_number', String(partNumber))
    return NotionFileUploadSchema.parse(
      await this.request('POST', `/v1/file_uploads/${fileUploadId}/send`, { form })
    )
  }

  async completeFileUpload(fileUploadId: string): Promise<NotionFileUpload> {
    return NotionFileUploadSchema.parse(
      await this.request('POST', `/v1/file_uploads/${fileUploadId}/complete`, { json: {} })
    )
  }

  // -- transport ----------------------------------------------------------------

  private request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { json?: unknown; form?: FormData } = {}
  ): Promise<unknown> {
    return this.queue.add(async () => {
      let rateLimitRetries = 0
      let serverErrorRetries = 0
      for (;;) {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION
        }
        let body: string | FormData | undefined
        if (opts.form !== undefined) {
          body = opts.form // multipart: fetch sets Content-Type + boundary
        } else if (opts.json !== undefined) {
          headers['Content-Type'] = 'application/json'
          body = JSON.stringify(opts.json)
        }
        const res = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
          method,
          headers,
          body
        })
        if (res.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries += 1
          await this.sleep(retryAfterMs(res.headers.get('retry-after')))
          continue
        }
        if (res.status >= 500 && serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
          serverErrorRetries += 1
          await this.sleep(SERVER_ERROR_BASE_BACKOFF_MS * 2 ** (serverErrorRetries - 1))
          continue
        }
        if (!res.ok) throw await apiErrorFromResponse(res)
        return (await res.json()) as unknown
      }
    })
  }
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

/** Copy a Buffer's bytes into a standalone ArrayBuffer (clean BlobPart). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/notion.unit.test.ts)
// ---------------------------------------------------------------------------

const HYPHENATED_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const PLAIN_ID = /[0-9a-f]{32}/gi

/**
 * Extract a Notion page/database id from a URL: strip the query string
 * (`?v=<view-id>` on database URLs would otherwise shadow the page id),
 * find the LAST run of 32 hex chars (title slugs precede the id), and
 * return it hyphenated 8-4-4-4-12 lowercase. Already-hyphenated ids are
 * accepted too. Returns null when no id is present.
 */
export function extractPageId(url: string): string | null {
  const withoutQuery = url.split('?', 1)[0]
  const hyphenated = withoutQuery.match(HYPHENATED_ID)
  if (hyphenated !== null && hyphenated.length > 0) {
    return hyphenated[hyphenated.length - 1].toLowerCase()
  }
  const plain = withoutQuery.match(PLAIN_ID)
  if (plain !== null && plain.length > 0) {
    const hex = plain[plain.length - 1].toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return null
}

/** Split blocks into chunks of ≤`chunkSize` (Notion caps requests at 100). */
export function chunkBlocks<T>(blocks: readonly T[], chunkSize = MAX_BLOCKS_PER_REQUEST): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`chunkBlocks: chunkSize must be a positive integer, got ${chunkSize}`)
  }
  const chunks: T[][] = []
  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize))
  }
  return chunks
}

export type UploadMode =
  | { mode: 'single' }
  | { mode: 'multi_part'; parts: number; partSize: number }

/** ≤20MB → single-part; larger → multi-part in 10MB parts. */
export function pickUploadMode(sizeBytes: number): UploadMode {
  if (sizeBytes <= SINGLE_PART_MAX_BYTES) return { mode: 'single' }
  return {
    mode: 'multi_part',
    parts: Math.ceil(sizeBytes / MULTI_PART_CHUNK_BYTES),
    partSize: MULTI_PART_CHUNK_BYTES
  }
}

/** Base name budget before the `.zip` suffix. */
const MAX_FILENAME_BASE_CHARS = 80
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * Build a Notion-safe zip filename from a task title + id: invalid
 * filename characters stripped, base capped at 80 chars (well under
 * Notion's 900-byte filename limit even for 4-byte UTF-8 chars), and the
 * task id preserved in full whenever it fits so filenames stay unique —
 * the title is what gets truncated.
 */
export function safeFilename(title: string, taskId: string): string {
  const clean = (value: string): string =>
    value.replace(INVALID_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const cleanTitle = clean(title)
  const cleanId = clean(taskId)

  let base: string
  if (cleanId.length >= MAX_FILENAME_BASE_CHARS) {
    base = cleanId.slice(0, MAX_FILENAME_BASE_CHARS)
  } else if (cleanId.length === 0) {
    base = cleanTitle.slice(0, MAX_FILENAME_BASE_CHARS).trim()
  } else {
    const titleRoom = MAX_FILENAME_BASE_CHARS - cleanId.length - 1
    const titlePart = cleanTitle.slice(0, titleRoom).trim()
    base = titlePart.length > 0 ? `${titlePart}-${cleanId}` : cleanId
  }
  // Windows disallows trailing dots/spaces on filenames.
  base = base.replace(/[. ]+$/g, '')
  if (base.length === 0) base = 'cowork-bundle'
  return `${base}.zip`
}
