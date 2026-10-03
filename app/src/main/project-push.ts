/**
 * Push: rebuild saved claude.ai projects as new-layout projects
 * ("channels") in the account a claude.ai page is signed in to.
 *
 * The flow is the one proven live on 2026-10-03 (docs/NEW-LAYOUT-SPEC.md,
 * research/new-layout/push_project.py), per plan project:
 *   1. list channels; skip a live channel with the same name (resume it
 *      only when an earlier ClaudeLift receipt says we made it and it is
 *      not complete)
 *   2. POST /v1/code/channels                      create
 *   3. PATCH /v1/code/channels/{id}/config         instructions
 *   4. POST /api/{org}/upload?store_as_is=true     one upload per Library file
 *      POST /v1/code/channels/{id}/files:write     batches of 25, per-file retry
 *   5. POST /v1/code/memory/channel/{id}/memories  precondition not_exists
 *   6. read back (files:list with cursor, memory list)
 *
 * Every call runs inside the claude.ai page through a PageExecutor (the
 * page's own cookies and origin), one small executeJavaScript per call or
 * file — never one giant payload. A dry run makes GET calls only. Nothing
 * is ever deleted or overwritten. A receipt JSON with every created id is
 * written after each project, so a run can be audited and resumed.
 *
 * Pure helpers (ids, batching, action choice, page-script builders,
 * receipt parsing) are exported for unit tests.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  PushAccount,
  PushAction,
  PushFailure,
  PushPlan,
  PushPlanProject,
  PushProgress,
  PushProjectResult,
  PushRunResult
} from '../shared/ipc'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const PUSH_RECEIPTS_DIR = 'push-receipts'
export const PUSH_PLANS_DIR = 'push-plans'
/** Batch size of files:write (25 proven). */
export const WRITE_BATCH = 25
/** files:list accepts limit 1–500 (501 → 400). */
export const LIST_LIMIT = 500
/**
 * Larger files are not sent; the user adds them by hand. The upload call
 * answers 413 "Uploaded file too large" above about 30 MB (28.8 MB passed,
 * 34.7 MB failed), although the Library itself allows 500 MB per file.
 */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
/** Uploads in flight at once. */
const UPLOAD_CONCURRENCY = 3
const MAX_LIST_PAGES = 100
const PROJECT_URL = 'https://claude.ai/code/project/'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

/** Runs JS in a signed-in https://claude.ai page. */
export interface PageExecutor {
  readonly label: string
  /** Evaluate an async JS expression in the page; resolves with its (JSON-able) value. */
  runInPage(js: string): Promise<unknown>
  dispose(): void
}

export class PushError extends Error {
  constructor(
    readonly kind: 'validation' | 'aborted' | 'crash',
    message: string
  ) {
    super(message)
    this.name = 'PushError'
  }
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Tagged id of a uuid: `<prefix>_01` + base58 of its 16 bytes, left-padded
 * with '1' to 22 chars (file_01…, user_01…). Padding matters: uuids with
 * leading zero bytes give shorter base58 strings that the API rejects.
 */
export function taggedId(prefix: string, uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a uuid: ${uuid}`)
  let n = BigInt(`0x${hex}`)
  let s = ''
  while (n > 0n) {
    s = BASE58[Number(n % 58n)] + s
    n /= 58n
  }
  return `${prefix}_01${s.padStart(22, '1')}`
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Library paths compare without a leading slash and without case. */
export function libraryKey(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase()
}

export function projectUrl(chan: string): string {
  return `${PROJECT_URL}${chan}`
}

export interface ChannelInfo {
  id: string
  name: string
  archived: boolean
}

/** Channels from a `GET /v1/code/channels` answer (`{data:[…]}`). */
export function channelsFromResponse(body: unknown): ChannelInfo[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: ChannelInfo[] = []
  for (const raw of data) {
    const c = raw as { id?: unknown; name?: unknown; archived_at?: unknown }
    if (typeof c.id !== 'string' || typeof c.name !== 'string') continue
    out.push({ id: c.id, name: c.name, archived: c.archived_at != null })
  }
  return out
}

/** Cursor for the next page of a list answer, else null. */
export function nextCursor(body: unknown, current: string | null): string | null {
  const b = body as { next_cursor?: unknown; cursor?: unknown; has_more?: unknown } | null
  if (b === null || typeof b !== 'object') return null
  if (b.has_more === false) return null
  const next = typeof b.next_cursor === 'string' ? b.next_cursor : typeof b.cursor === 'string' ? b.cursor : null
  return next !== null && next !== '' && next !== current ? next : null
}

export interface PriorRun {
  chan: string
  complete: boolean
}

/** What to do with one plan project, given the live channels and earlier ClaudeLift receipts. */
export function decideAction(
  name: string,
  key: string,
  channels: readonly ChannelInfo[],
  prior: ReadonlyMap<string, PriorRun>,
  topUp = false
): { action: PushAction; chan: string | null; reason: string | null } {
  const wanted = name.trim().toLowerCase()
  const live = channels.find((c) => !c.archived && c.name.trim().toLowerCase() === wanted)
  if (live === undefined) return { action: 'create', chan: null, reason: null }
  const before = prior.get(key)
  if (before !== undefined && before.chan === live.id) {
    if (before.complete && topUp) {
      return { action: 'resume', chan: live.id, reason: 'Made by ClaudeLift; adding what is new.' }
    }
    return before.complete
      ? { action: 'skip', chan: live.id, reason: 'Already rebuilt by ClaudeLift.' }
      : { action: 'resume', chan: live.id, reason: 'Made by ClaudeLift earlier; adding what is missing.' }
  }
  return { action: 'skip', chan: live.id, reason: 'A project with this name exists.' }
}

/** Short error text from an API answer body (never the request content). */
export function apiErrorText(body: unknown): string | null {
  if (body === null || body === undefined) return null
  const b = body as { error?: { message?: unknown; type?: unknown } | string; message?: unknown }
  if (typeof b.error === 'object' && b.error !== null) {
    if (typeof b.error.message === 'string') return b.error.message.slice(0, 300)
    if (typeof b.error.type === 'string') return b.error.type
  }
  if (typeof b.error === 'string') return b.error.slice(0, 300)
  if (typeof b.message === 'string') return b.message.slice(0, 300)
  try {
    return JSON.stringify(body).slice(0, 300)
  } catch {
    return null
  }
}

/** Org to use: the first one with the chat capability, else the first one. */
export function pickOrg(orgs: readonly { uuid: string; name: string | null; capabilities: string[] }[]): {
  uuid: string
  name: string | null
} | null {
  const org = orgs.find((o) => o.capabilities.includes('chat')) ?? orgs[0]
  return org === undefined ? null : { uuid: org.uuid, name: org.name }
}

// -- page scripts ------------------------------------------------------------

/** JSON is valid JS (ES2019+), so a JSON literal is a safe way to pass arguments. */
function lit(value: unknown): string {
  return JSON.stringify(value)
}

/** One `/v1/code/*` call with the headers the app uses. Resolves `{ok, status, j}`. */
export function apiCallJs(org: string, method: string, url: string, body?: unknown): string {
  return `(async (a) => {
  const h = { accept: 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': a.org }
  if (a.body !== null) h['content-type'] = 'application/json'
  let r
  try {
    r = await fetch(a.url, { method: a.method, credentials: 'include', headers: h, body: a.body === null ? undefined : JSON.stringify(a.body) })
  } catch (e) {
    return { ok: false, status: 0, j: { error: { message: 'Network error: ' + String(e && e.message || e) } } }
  }
  let j = null
  try { j = await r.json() } catch (_) {}
  return { ok: r.ok, status: r.status, j }
})(${lit({ org, method, url, body: body === undefined ? null : body })})`
}

/** Upload one file (base64) to the org's file store. Resolves `{ok, status, file_uuid, j}`. */
export function uploadJs(org: string, name: string, mime: string, b64: string): string {
  return `(async (a) => {
  const bin = atob(a.b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const fd = new FormData()
  fd.append('file', new File([bytes], a.name, { type: a.mime }))
  let r
  try {
    r = await fetch('/api/' + a.org + '/upload?store_as_is=true', { method: 'POST', credentials: 'include', body: fd })
  } catch (e) {
    return { ok: false, status: 0, file_uuid: null, j: { error: { message: 'Network error: ' + String(e && e.message || e) } } }
  }
  let j = null
  try { j = await r.json() } catch (_) {}
  return { ok: r.ok, status: r.status, file_uuid: j && typeof j.file_uuid === 'string' ? j.file_uuid : null, j: r.ok ? null : j }
})(${lit({ org, name, mime, b64 })})`
}

/** Who is signed in: org list and the account email (bootstrap, then account profile). */
export const WHOAMI_JS = `(async () => {
  const get = async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } })
      return r.ok ? await r.json() : null
    } catch (_) { return null }
  }
  const findEmail = (o, d) => {
    if (!o || typeof o !== 'object' || d > 3) return null
    for (const k of ['email_address', 'email']) if (typeof o[k] === 'string' && o[k].includes('@')) return o[k]
    for (const v of Object.values(o)) { const f = findEmail(v, d + 1); if (f) return f }
    return null
  }
  const orgs = await get('/api/organizations')
  const boot = await get('/api/bootstrap')
  const prof = await get('/api/account_profile')
  return {
    orgs: Array.isArray(orgs) ? orgs.map((o) => ({ uuid: String(o.uuid), name: o.name == null ? null : String(o.name), capabilities: Array.isArray(o.capabilities) ? o.capabilities.map(String) : [] })) : null,
    email: findEmail(boot && boot.account, 0) || findEmail(prof, 0)
  }
})()`

// -- receipts ----------------------------------------------------------------

export interface ReceiptProject extends PushProjectResult {
  files: { path: string; source_file_id: string }[]
  memory_ids: string[]
}

export interface Receipt {
  receipt_version: 1
  started_at: string
  finished_at: string | null
  dry_run: boolean
  executor: string
  plan_file: string
  account: PushAccount
  cancelled: boolean
  projects: ReceiptProject[]
}

/** Latest run per plan key for this org from earlier (non-dry-run) receipts. */
export function priorRuns(receipts: readonly unknown[], orgUuid: string): Map<string, PriorRun> {
  const out = new Map<string, PriorRun>()
  for (const raw of receipts) {
    const r = raw as Partial<Receipt> | null
    if (r === null || typeof r !== 'object' || r.dry_run !== false) continue
    if (r.account?.orgUuid !== orgUuid || !Array.isArray(r.projects)) continue
    for (const p of r.projects) {
      if (typeof p?.key !== 'string' || typeof p.chan !== 'string') continue
      out.set(p.key, { chan: p.chan, complete: p.complete === true })
    }
  }
  return out
}

async function readReceipts(dir: string): Promise<unknown[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch {
      // a broken receipt is ignored
    }
  }
  return out
}

function stamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// API over an executor
// ---------------------------------------------------------------------------

/** How often one call is retried after HTTP 429. */
export const MAX_RATE_RETRIES = 40
const DEFAULT_RETRY_MS = 15_000
const MAX_RETRY_MS = 5 * 60_000

/** Wait asked for by a 429 answer ("Retry in 12s" / retry_after), plus a second; 15 s when it says nothing. */
export function retryDelayMs(body: unknown): number {
  const b = body as { retry_after?: unknown; error?: { retry_after?: unknown } } | null
  const field = b?.retry_after ?? b?.error?.retry_after
  let sec: number | null = typeof field === 'number' && Number.isFinite(field) ? field : null
  if (sec === null) {
    const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(apiErrorText(body) ?? '')
    if (m !== null) sec = Number(m[1])
  }
  if (sec === null) return DEFAULT_RETRY_MS
  return Math.min(MAX_RETRY_MS, Math.max(1000, Math.ceil(sec * 1000) + 1000))
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface ApiAnswer {
  ok: boolean
  status: number
  j: unknown
}

function asAnswer(raw: unknown): ApiAnswer {
  const r = raw as Partial<ApiAnswer> | null
  if (r === null || typeof r !== 'object' || typeof r.status !== 'number') {
    throw new PushError('crash', 'The claude.ai page gave no answer.')
  }
  return { ok: r.ok === true, status: r.status, j: r.j ?? null }
}

class Api {
  constructor(
    private readonly exec: PageExecutor,
    readonly org: string,
    private readonly signal: AbortSignal | null = null,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly onWait: ((line: string) => void) | null = null
  ) {}

  /**
   * Run one page call; on HTTP 429 wait as long as claude.ai asks ("Retry
   * in 12s"), then try again (MAX_RATE_RETRIES times). Bulk project
   * creation hits this limit after about a dozen projects.
   */
  private async withRetry<T extends { status: number; body: unknown }>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await run()
      if (res.status !== 429 || attempt >= MAX_RATE_RETRIES) return res
      const ms = retryDelayMs(res.body)
      this.onWait?.(`claude.ai asks to slow down; waiting ${Math.round(ms / 1000)} s`)
      await this.abortableSleep(ms)
      if (this.signal?.aborted === true) throw new PushError('aborted', 'Push cancelled.')
    }
  }

  /** The back-off wait ends at once on cancel (it can be up to 5 minutes). */
  private abortableSleep(ms: number): Promise<void> {
    const signal = this.signal
    if (signal === null) return this.sleep(ms)
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      void this.sleep(ms).then(done, done)
    })
  }

  async call(method: string, url: string, body?: unknown): Promise<ApiAnswer> {
    const res = await this.withRetry(async () => {
      const a = asAnswer(await this.exec.runInPage(apiCallJs(this.org, method, url, body)))
      return { ...a, body: a.j }
    })
    return { ok: res.ok, status: res.status, j: res.j }
  }

  async upload(name: string, mime: string, data: Buffer): Promise<{ ok: boolean; status: number; fileUuid: string | null; error: string | null }> {
    const b64 = data.toString('base64')
    const res = await this.withRetry(async () => {
      const raw = (await this.exec.runInPage(uploadJs(this.org, name, mime, b64))) as {
        ok?: boolean
        status?: number
        file_uuid?: string | null
        j?: unknown
      } | null
      if (raw === null || typeof raw !== 'object') throw new PushError('crash', 'The claude.ai page gave no answer.')
      return { raw, status: typeof raw.status === 'number' ? raw.status : 0, body: raw.j }
    })
    const raw = res.raw
    return {
      ok: raw.ok === true,
      status: typeof raw.status === 'number' ? raw.status : 0,
      fileUuid: typeof raw.file_uuid === 'string' ? raw.file_uuid : null,
      error: raw.ok === true ? null : apiErrorText(raw.j)
    }
  }

  async channels(): Promise<ChannelInfo[]> {
    // limit=200 keeps big accounts in one page; older servers that refuse it get the plain call.
    let base = '/v1/code/channels?scope=all&limit=200'
    let res = await this.call('GET', base)
    if (res.status === 400) {
      base = '/v1/code/channels?scope=all'
      res = await this.call('GET', base)
    }
    if (!res.ok) throw new PushError('crash', `Could not list the projects (HTTP ${res.status}): ${apiErrorText(res.j) ?? ''}`)
    const out = channelsFromResponse(res.j)
    // A short list could hide a project with the same name and cause a
    // duplicate, so any failure here stops the run instead of returning part.
    let cursor = nextCursor(res.j, null)
    for (let page = 0; cursor !== null; page++) {
      if (page >= MAX_LIST_PAGES) throw new PushError('crash', 'The project list has too many pages.')
      const more = await this.call('GET', `${base}&cursor=${encodeURIComponent(cursor)}`)
      if (!more.ok) {
        throw new PushError('crash', `Could not list all projects (HTTP ${more.status}): ${apiErrorText(more.j) ?? ''}`)
      }
      out.push(...channelsFromResponse(more.j))
      cursor = nextCursor(more.j, cursor)
    }
    return out
  }

  /** Every file path in a project's Library (directories left out). */
  async libraryPaths(chan: string): Promise<string[]> {
    const paths: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const body: Record<string, unknown> = { recursive: true, limit: LIST_LIMIT }
      if (cursor !== null) body.cursor = cursor
      const res = await this.call('POST', `/v1/code/channels/${chan}/files:list`, body)
      if (!res.ok) throw new PushError('crash', `Could not list the Library (HTTP ${res.status}): ${apiErrorText(res.j) ?? ''}`)
      const entries = (res.j as { entries?: unknown } | null)?.entries
      const list = Array.isArray(entries) ? entries : []
      for (const e of list) {
        const entry = e as { path?: unknown; is_directory?: unknown }
        if (typeof entry.path === 'string' && entry.is_directory !== true) paths.push(entry.path)
      }
      const next = nextCursor(res.j, cursor)
      if (next === null || list.length === 0) break
      cursor = next
    }
    return paths
  }

  async memoryCount(chan: string): Promise<number> {
    // The default page is 20 notes; the app itself asks for 100.
    const res = await this.call('GET', `/v1/code/memory/channel/${chan}/memories?limit=100`)
    if (!res.ok) throw new PushError('crash', `Could not read the memory notes back (HTTP ${res.status}).`)
    const data = (res.j as { data?: unknown } | null)?.data
    return Array.isArray(data) ? data.length : 0
  }
}

/** Which account the page is signed in to, plus its live project names. Read-only. */
export async function readAccount(
  exec: PageExecutor,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; onWait?: (line: string) => void } = {}
): Promise<{ account: PushAccount; channels: ChannelInfo[]; api: Api }> {
  const who = (await exec.runInPage(WHOAMI_JS)) as {
    orgs?: { uuid: string; name: string | null; capabilities: string[] }[] | null
    email?: string | null
  } | null
  if (who === null || typeof who !== 'object' || !Array.isArray(who.orgs) || who.orgs.length === 0) {
    throw new PushError('validation', 'The claude.ai page is not signed in. Sign in first.')
  }
  const org = pickOrg(who.orgs)
  if (org === null) throw new PushError('validation', 'The account has no organization.')
  const api = new Api(exec, org.uuid, opts.signal ?? null, opts.sleep, opts.onWait ?? null)
  const channels = await api.channels()
  const account: PushAccount = {
    email: typeof who.email === 'string' ? who.email : null,
    orgUuid: org.uuid,
    orgName: org.name,
    projectNames: channels.filter((c) => !c.archived).map((c) => c.name)
  }
  return { account, channels, api }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface PushRunOptions {
  plan: PushPlan
  planFile: string
  keys: readonly string[]
  dryRun: boolean
  /** Must match the page's account email on a write run. */
  expectEmail: string | null
  /** `<settings.outputDir>` — receipts go to `<outputDir>/push-receipts`. */
  outputDir: string
  signal: AbortSignal
  onProgress: (event: PushProgress) => void
  /** Test hook for the 429 back-off wait. */
  sleep?: (ms: number) => Promise<void>
  /** Resume finished ClaudeLift projects too (adds only what is missing). */
  topUp?: boolean
}

function emptyResult(p: PushPlanProject, action: PushAction, chan: string | null, reason: string | null): ReceiptProject {
  return {
    key: p.key,
    name: p.name,
    action,
    reason,
    chan,
    url: chan === null ? null : projectUrl(chan),
    instructions: null,
    library: { planned: p.library.length, written: 0, existing: 0, failed: [] },
    memory: { planned: p.memory.length, written: 0, existing: 0, failed: [] },
    verify: null,
    complete: false,
    error: null,
    files: [],
    memory_ids: []
  }
}

async function pool<T>(items: readonly T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let stop = false
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (!stop && next < items.length) {
      const item = items[next++]
      try {
        await worker(item)
      } catch (err) {
        stop = true
        throw err
      }
    }
  })
  // Wait for every worker to stop before the caller moves on, then rethrow.
  const settled = await Promise.allSettled(runners)
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}

/** Run (or dry-run) the chosen plan projects through `exec`. */
export async function pushPlan(exec: PageExecutor, opts: PushRunOptions): Promise<PushRunResult> {
  const chosen = opts.plan.projects.filter((p) => opts.keys.includes(p.key))
  if (chosen.length === 0) throw new PushError('validation', 'No project of the plan was chosen.')
  const total = chosen.length
  const progress = (
    p: PushPlanProject | null,
    index: number,
    phase: PushProgress['phase'],
    done = 0,
    of = 0,
    line: string | null = null
  ): void => {
    opts.onProgress({ key: p?.key ?? null, name: p?.name ?? null, index, total, phase, done, of, line })
  }
  const checkCancel = (): void => {
    if (opts.signal.aborted) throw new PushError('aborted', 'Push cancelled.')
  }

  // The project being worked on, so a rate-limit wait shows where it is.
  let current: { p: PushPlanProject; index: number } | null = null
  progress(null, 0, 'account', 0, 0, `Checking the account in ${exec.label}…`)
  const { account, channels, api } = await readAccount(exec, {
    signal: opts.signal,
    sleep: opts.sleep,
    onWait: (line) => progress(current?.p ?? null, current?.index ?? 0, 'checking', 0, 0, line)
  })
  if (!opts.dryRun) {
    if (opts.expectEmail === null || opts.expectEmail === '') {
      throw new PushError('validation', 'Check the target account first, then run again.')
    }
    if (account.email === null || account.email.toLowerCase() !== opts.expectEmail.toLowerCase()) {
      throw new PushError(
        'validation',
        `The page is signed in to ${account.email ?? 'an unknown account'}, not ${opts.expectEmail}. Nothing was written.`
      )
    }
  }

  const receiptsDir = join(opts.outputDir, PUSH_RECEIPTS_DIR)
  const prior = priorRuns(await readReceipts(receiptsDir), account.orgUuid)
  await mkdir(receiptsDir, { recursive: true })
  // Milliseconds in the name: two runs in one second never share a receipt.
  const receiptFile = join(receiptsDir, `${opts.dryRun ? 'dry-run' : 'push'}-${stamp()}-${String(Date.now() % 1000).padStart(3, '0')}.json`)
  const receipt: Receipt = {
    receipt_version: 1,
    started_at: new Date().toISOString(),
    finished_at: null,
    dry_run: opts.dryRun,
    executor: exec.label,
    plan_file: opts.planFile,
    account,
    cancelled: false,
    projects: []
  }
  const save = (): Promise<void> => writeFile(receiptFile, JSON.stringify(receipt, null, 1), 'utf8')
  const live = [...channels]

  try {
    for (const [i, p] of chosen.entries()) {
      checkCancel()
      const index = i + 1
      current = { p, index }
      progress(p, index, 'checking')
      const decision = decideAction(p.name, p.key, live, prior, opts.topUp === true)
      const res = emptyResult(p, decision.action, decision.chan, decision.reason)
      receipt.projects.push(res)
      if (opts.dryRun || decision.action === 'skip') {
        res.complete = decision.action === 'skip'
        progress(p, index, 'done', 0, 0, `${p.name}: ${decision.action}${decision.reason !== null ? ` (${decision.reason})` : ''}`)
        continue
      }
      try {
        await pushOne(api, p, res, index, progress, checkCancel, save)
        if (res.chan !== null && decision.action === 'create') live.push({ id: res.chan, name: p.name, archived: false })
      } catch (err) {
        if (err instanceof PushError && err.kind === 'aborted') throw err
        res.error = err instanceof Error ? err.message : String(err)
        progress(p, index, 'done', 0, 0, `${p.name}: failed — ${res.error}`)
      }
      await save()
    }
  } catch (err) {
    if (!(err instanceof PushError && err.kind === 'aborted')) throw err
    receipt.cancelled = true
  } finally {
    receipt.finished_at = new Date().toISOString()
    await save()
  }

  return {
    dryRun: opts.dryRun,
    account,
    receiptFile,
    cancelled: receipt.cancelled,
    projects: receipt.projects.map(({ files: _files, memory_ids: _ids, ...rest }) => rest)
  }
}

async function pushOne(
  api: Api,
  p: PushPlanProject,
  res: ReceiptProject,
  index: number,
  progress: (p: PushPlanProject, index: number, phase: PushProgress['phase'], done?: number, of?: number, line?: string | null) => void,
  checkCancel: () => void,
  save: () => Promise<void>
): Promise<void> {
  // 1. create (or reuse on resume)
  let existingPaths = new Set<string>()
  if (res.action === 'create') {
    progress(p, index, 'create', 0, 0, `${p.name}: creating the project`)
    const c = await api.call('POST', '/v1/code/channels', { name: p.name, visibility: 'private', context_sources: [] })
    const id = (c.j as { channel?: { id?: unknown } } | null)?.channel?.id
    if (!c.ok || typeof id !== 'string') {
      throw new PushError('crash', `Could not create the project (HTTP ${c.status}): ${apiErrorText(c.j) ?? ''}`)
    }
    res.chan = id
    res.url = projectUrl(id)
    await save()
  } else if (res.chan !== null) {
    existingPaths = new Set((await api.libraryPaths(res.chan)).map(libraryKey))
  }
  const chan = res.chan
  if (chan === null) throw new PushError('crash', 'No project id.')

  // 1b. linked PC folders (as the Library's "Add folder" records them)
  if (p.context_sources.length > 0) {
    checkCancel()
    const got = await api.call('GET', `/v1/code/channels/${chan}`)
    const current = ((got.j as { channel?: { context_sources?: unknown } } | null)?.channel?.context_sources ?? []) as {
      kind?: unknown
      name?: unknown
    }[]
    const merged = current
      .filter((c) => typeof c.kind === 'string' && typeof c.name === 'string')
      .map((c) => ({ kind: c.kind as string, name: c.name as string }))
    const have = new Set(merged.map((c) => `${c.kind}\u0000${c.name.toLowerCase()}`))
    const add = p.context_sources.filter((c) => !have.has(`${c.kind}\u0000${c.name.toLowerCase()}`))
    if (!got.ok) {
      res.library.failed.push({ path: '(folders)', step: 'folders', status: got.status, error: apiErrorText(got.j) })
    } else if (add.length > 0) {
      progress(p, index, 'create', 0, 0, `${p.name}: linking folder(s) ${add.map((c) => c.name).join(', ')}`)
      const patched = await api.call('PATCH', `/v1/code/channels/${chan}`, {
        context_sources: [...merged, ...add.map((c) => ({ kind: c.kind, name: c.name }))]
      })
      if (!patched.ok) {
        res.library.failed.push({ path: '(folders)', step: 'folders', status: patched.status, error: apiErrorText(patched.j) })
      }
    }
  }

  // 2. instructions
  checkCancel()
  if (p.instructions.trim() === '') {
    res.instructions = 'none'
  } else {
    let keep = false
    if (res.action === 'resume') {
      const cfg = await api.call('GET', `/v1/code/channels/${chan}/config`)
      // Unknown is not empty: never replace instructions we could not read.
      if (!cfg.ok) throw new PushError('crash', `Could not read the project settings (HTTP ${cfg.status}).`)
      const j = cfg.j as { system_prompt_addendum?: unknown; config?: { system_prompt_addendum?: unknown } } | null
      const current = j?.system_prompt_addendum ?? j?.config?.system_prompt_addendum
      keep = typeof current === 'string' && current.trim() !== ''
    }
    if (keep) {
      res.instructions = 'kept'
    } else {
      progress(p, index, 'instructions', 0, 0, `${p.name}: instructions (${p.instructions.length} chars)`)
      const cfg = await api.call('PATCH', `/v1/code/channels/${chan}/config`, { system_prompt_addendum: p.instructions })
      res.instructions = cfg.ok ? 'set' : 'failed'
      if (!cfg.ok) {
        res.library.failed.push({ path: '(instructions)', step: 'instructions', status: cfg.status, error: apiErrorText(cfg.j) })
      }
    }
  }

  // 3. Library: upload, then files:write in batches of 25 as uploads finish
  const todo = p.library.filter((f) => {
    if (existingPaths.has(libraryKey(f.path))) {
      res.library.existing++
      return false
    }
    return true
  })
  let done = 0
  const pending: { path: string; source_file_id: string }[] = []
  const fail = (f: PushFailure): void => {
    res.library.failed.push(f)
  }
  const flush = async (all: boolean): Promise<void> => {
    while (pending.length >= WRITE_BATCH || (all && pending.length > 0)) {
      const batch = pending.splice(0, WRITE_BATCH)
      const w = await api.call('POST', `/v1/code/channels/${chan}/files:write`, { files: batch })
      if (!w.ok) {
        // One bad entry rejects the whole batch: retry one by one.
        for (const e of batch) {
          const one = await api.call('POST', `/v1/code/channels/${chan}/files:write`, { files: [e] })
          if (one.ok && writtenOk(one.j, e.path)) {
            res.library.written++
            res.files.push(e)
          } else {
            fail({ path: e.path, step: 'write', status: one.status, error: apiErrorText(one.j) })
          }
        }
        continue
      }
      const results = (w.j as { results?: unknown } | null)?.results
      const byPath = new Map<string, { entry?: unknown; error?: unknown }>()
      if (Array.isArray(results)) {
        for (const r of results as { path?: unknown; entry?: unknown; error?: unknown }[]) {
          if (typeof r.path === 'string') byPath.set(libraryKey(r.path), r)
        }
      }
      for (const e of batch) {
        const r = byPath.get(libraryKey(e.path))
        // With a results list, only a confirmed path counts: claude.ai answers
        // 200 for paths it silently drops (e.g. control characters in a name).
        if ((r === undefined && byPath.size === 0) || (r !== undefined && r.entry != null)) {
          res.library.written++
          res.files.push(e)
        } else {
          fail({ path: e.path, step: 'write', status: w.status, error: (r && apiErrorText(r.error)) ?? 'claude.ai did not confirm this path' })
        }
      }
    }
  }

  const poolError: unknown = await pool(todo, UPLOAD_CONCURRENCY, async (f) => {
    checkCancel()
    if (f.size > MAX_UPLOAD_BYTES) {
      fail({ path: f.path, step: 'upload', status: null, error: 'Larger than 30 MB (the claude.ai upload limit). Add it to the project by hand.' })
    } else {
      let data: Buffer | null = null
      try {
        data = await readFile(f.file)
      } catch (err) {
        fail({ path: f.path, step: 'read', status: null, error: err instanceof Error ? err.message : String(err) })
      }
      if (data !== null) {
        try {
          const up = await api.upload(basename(f.path), f.mime, data)
          if (up.ok && up.fileUuid !== null) pending.push({ path: f.path, source_file_id: taggedId('file', up.fileUuid) })
          else fail({ path: f.path, step: 'upload', status: up.status, error: up.error })
        } catch (err) {
          // One failed call (e.g. a network drop) fails this file, not the project.
          fail({ path: f.path, step: 'upload', status: null, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    done++
    progress(p, index, 'library', done, todo.length)
    if (pending.length >= WRITE_BATCH) await flush(false)
  })
    .then(() => null)
    .catch((err: unknown) => err)
  // Files already uploaded are still written (and recorded), even after a cancel.
  let stopError: unknown = poolError
  try {
    await flush(true)
  } catch (err) {
    stopError ??= err
  }
  await save()
  if (stopError !== null) throw stopError
  checkCancel()

  // 4. memory notes (keys were blanked by the engine; never overwrite)
  for (const [m, note] of p.memory.entries()) {
    checkCancel()
    const r = await api.call('POST', `/v1/code/memory/channel/${chan}/memories`, {
      path: note.path,
      content: note.content,
      precondition: { type: 'not_exists' }
    })
    if (r.ok) {
      res.memory.written++
      const id = (r.j as { id?: unknown } | null)?.id
      if (typeof id === 'string') res.memory_ids.push(id)
    } else if (r.status === 409 || r.status === 412) {
      res.memory.existing++
    } else {
      res.memory.failed.push({ path: note.path, step: 'memory', status: r.status, error: apiErrorText(r.j) })
    }
    progress(p, index, 'memory', m + 1, p.memory.length)
  }

  // 5. read back
  progress(p, index, 'verify', 0, 0, `${p.name}: checking what is there`)
  const libraryFiles = (await api.libraryPaths(chan)).length
  const memoryFiles = await api.memoryCount(chan)
  res.verify = { libraryFiles, memoryFiles }
  res.complete =
    res.library.failed.length === 0 &&
    res.memory.failed.length === 0 &&
    res.instructions !== 'failed' &&
    libraryFiles >= p.library.length &&
    memoryFiles >= p.memory.length
  progress(
    p,
    index,
    'done',
    0,
    0,
    `${p.name}: ${res.library.written} files, ${res.memory.written} memory notes` +
      (res.library.failed.length + res.memory.failed.length > 0
        ? `, ${res.library.failed.length + res.memory.failed.length} failed`
        : '')
  )
}

/** A single-file files:write answer: written when its result has an entry (or no results list at all). */
function writtenOk(body: unknown, path: string): boolean {
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return true
  const r = (results as { path?: unknown; entry?: unknown }[]).find(
    (x) => typeof x.path === 'string' && libraryKey(x.path) === libraryKey(path)
  )
  if (r === undefined) return results.length === 0
  return r.entry != null
}
