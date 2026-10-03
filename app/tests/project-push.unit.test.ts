/**
 * Unit tests for the project push (src/main/project-push.ts).
 *
 * The page-script builders are evaluated for real (the way a claude.ai page
 * would run them) against a fake `fetch`, and `pushPlan` runs end to end
 * against an in-memory fake of claude.ai.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  PUSH_RECEIPTS_DIR,
  PushError,
  WHOAMI_JS,
  WRITE_BATCH,
  apiCallJs,
  apiErrorText,
  channelsFromResponse,
  chunk,
  decideAction,
  libraryKey,
  nextCursor,
  pickOrg,
  priorRuns,
  projectUrl,
  pushPlan,
  retryDelayMs,
  MAX_RATE_RETRIES,
  taggedId,
  uploadJs,
  type ChannelInfo,
  type PageExecutor,
  type PriorRun
} from '../src/main/project-push'
import { PushPlanProjectSchema, PushPlanSchema, type PushPlan, type PushProgress } from '../src/shared/ipc'

// ---------------------------------------------------------------------------
// independent base58 (22 fixed digits, long division over bytes)
// ---------------------------------------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function refTagged(prefix: string, uuid: string): string {
  const hex = uuid.replace(/-/g, '')
  const bytes: number[] = []
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  const digits: string[] = []
  for (let d = 0; d < 22; d++) {
    let rem = 0
    for (let i = 0; i < bytes.length; i++) {
      const cur = rem * 256 + bytes[i]
      bytes[i] = Math.floor(cur / 58)
      rem = cur % 58
    }
    digits.push(ALPHABET[rem])
  }
  expect(bytes.every((b) => b === 0)).toBe(true) // the value fitted in 22 digits
  return `${prefix}_01${digits.reverse().join('')}`
}

describe('taggedId', () => {
  it('pads a uuid with leading zero bytes to exactly 22 chars with 1s', () => {
    const id = taggedId('file', '00000000-0000-4000-8000-000000000001')
    expect(id.startsWith('file_01')).toBe(true)
    expect(id).toHaveLength('file_01'.length + 22)
    expect(id.slice('file_01'.length).startsWith('1111')).toBe(true)
    expect(id).toBe(refTagged('file', '00000000-0000-4000-8000-000000000001'))
  })

  it('gives 22 chars for a normal uuid and matches the independent encoder', () => {
    const uuid = '3f2a9c41-7d1e-4b6a-9e2f-8c5d1a0b7e64'
    const id = taggedId('file', uuid)
    expect(id).toHaveLength('file_01'.length + 22)
    expect(id).toBe(refTagged('file', uuid))
  })

  it('matches the independent encoder for many random and edge uuids', () => {
    const edge = ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-00000000003a']
    for (const uuid of [...edge, ...Array.from({ length: 200 }, () => randomUUID())]) {
      const id = taggedId('user', uuid.toUpperCase())
      expect(id).toBe(refTagged('user', uuid))
      expect(id).toHaveLength('user_01'.length + 22)
      expect(id.slice(7)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{22}$/)
    }
  })

  it('throws for a non-uuid', () => {
    expect(() => taggedId('file', 'nope')).toThrow(/not a uuid/)
    expect(() => taggedId('file', '1234')).toThrow()
    expect(() => taggedId('file', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toThrow()
  })
})

describe('small helpers', () => {
  it('chunk splits into slices of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    expect(chunk([1, 2], 5)).toEqual([[1, 2]])
  })

  it('libraryKey ignores leading slashes and case', () => {
    expect(libraryKey('/Docs/ReadMe.MD')).toBe('docs/readme.md')
    expect(libraryKey('//docs/readme.md')).toBe('docs/readme.md')
    expect(libraryKey('docs/readme.md')).toBe('docs/readme.md')
  })

  it('projectUrl builds the claude.ai code project URL', () => {
    expect(projectUrl('chan_X')).toBe('https://claude.ai/code/project/chan_X')
  })

  it('apiErrorText reads error.message, error.type, error string, message, else JSON', () => {
    expect(apiErrorText({ error: { message: 'boom', type: 't' } })).toBe('boom')
    expect(apiErrorText({ error: { type: 'invalid_request' } })).toBe('invalid_request')
    expect(apiErrorText({ error: 'plain' })).toBe('plain')
    expect(apiErrorText({ message: 'top' })).toBe('top')
    expect(apiErrorText({ other: 1 })).toBe('{"other":1}')
    expect(apiErrorText(null)).toBeNull()
    expect(apiErrorText(undefined)).toBeNull()
    expect(apiErrorText({ error: { message: 'x'.repeat(500) } })).toHaveLength(300)
  })

  it('pickOrg prefers an org with the chat capability', () => {
    const orgs = [
      { uuid: 'a', name: 'API', capabilities: ['api'] },
      { uuid: 'b', name: 'Chat', capabilities: ['chat', 'x'] }
    ]
    expect(pickOrg(orgs)).toEqual({ uuid: 'b', name: 'Chat' })
    expect(pickOrg([orgs[0]])).toEqual({ uuid: 'a', name: 'API' })
    expect(pickOrg([])).toBeNull()
  })
})

describe('retryDelayMs', () => {
  it('reads "Retry in Ns" from the error message and adds a second', () => {
    expect(retryDelayMs({ error: { message: 'Too many projects created. Retry in 12s.' } })).toBe(13_000)
  })
  it('prefers a numeric retry_after field', () => {
    expect(retryDelayMs({ retry_after: 3 })).toBe(4000)
    expect(retryDelayMs({ error: { retry_after: 2.5, message: 'Retry in 99s' } })).toBe(3500)
  })
  it('waits 15 s when the answer says nothing and caps long waits at 5 minutes', () => {
    expect(retryDelayMs(null)).toBe(15_000)
    expect(retryDelayMs({ error: { message: 'slow down' } })).toBe(15_000)
    expect(retryDelayMs({ retry_after: 3600 })).toBe(300_000)
  })
})

describe('channelsFromResponse', () => {
  it('reads id, name and the archived flag, skipping bad rows', () => {
    const out = channelsFromResponse({
      data: [
        { id: 'c1', name: 'One', archived_at: null },
        { id: 'c2', name: 'Two', archived_at: '2026-01-01T00:00:00Z' },
        { id: 'c3' },
        { name: 'no id' },
        { id: 5, name: 'bad id' },
        null,
        { id: 'c4', name: 'Four' }
      ].filter((x) => x !== null)
    })
    expect(out).toEqual([
      { id: 'c1', name: 'One', archived: false },
      { id: 'c2', name: 'Two', archived: true },
      { id: 'c4', name: 'Four', archived: false }
    ])
  })

  it('returns [] for anything else', () => {
    expect(channelsFromResponse(null)).toEqual([])
    expect(channelsFromResponse({})).toEqual([])
    expect(channelsFromResponse({ data: 'x' })).toEqual([])
  })
})

describe('nextCursor', () => {
  it('is null when has_more is false', () => {
    expect(nextCursor({ has_more: false, next_cursor: 'abc' }, null)).toBeNull()
  })

  it('is null when the cursor did not change or is empty', () => {
    expect(nextCursor({ next_cursor: 'abc' }, 'abc')).toBeNull()
    expect(nextCursor({ next_cursor: '' }, null)).toBeNull()
    expect(nextCursor({}, null)).toBeNull()
    expect(nextCursor(null, null)).toBeNull()
    expect(nextCursor('x', null)).toBeNull()
  })

  it('reads next_cursor, then cursor', () => {
    expect(nextCursor({ next_cursor: 'n', has_more: true }, null)).toBe('n')
    expect(nextCursor({ cursor: 'c' }, 'old')).toBe('c')
    expect(nextCursor({ next_cursor: 'n', cursor: 'c' }, null)).toBe('n')
  })
})

describe('decideAction', () => {
  const channels: ChannelInfo[] = [
    { id: 'c1', name: 'My Project', archived: false },
    { id: 'c2', name: 'Old', archived: true }
  ]
  const none = new Map<string, PriorRun>()

  it('creates when no live channel has the name', () => {
    expect(decideAction('Brand New', 'k', channels, none)).toEqual({ action: 'create', chan: null, reason: null })
  })

  it('skips on a case- and whitespace-insensitive name match', () => {
    expect(decideAction('  my PROJECT ', 'k', channels, none)).toEqual({
      action: 'skip',
      chan: 'c1',
      reason: 'A project with this name exists.'
    })
  })

  it('ignores archived channels', () => {
    expect(decideAction('Old', 'k', channels, none).action).toBe('create')
  })

  it('resumes an incomplete earlier ClaudeLift run on the same channel', () => {
    const r = decideAction('My Project', 'k', channels, new Map([['k', { chan: 'c1', complete: false }]]))
    expect(r.action).toBe('resume')
    expect(r.chan).toBe('c1')
  })

  it('skips a complete earlier run', () => {
    expect(decideAction('My Project', 'k', channels, new Map([['k', { chan: 'c1', complete: true }]]))).toEqual({
      action: 'skip',
      chan: 'c1',
      reason: 'Already rebuilt by ClaudeLift.'
    })
  })

  it('does not trust a receipt for another channel', () => {
    const r = decideAction('My Project', 'k', channels, new Map([['k', { chan: 'other', complete: false }]]))
    expect(r.action).toBe('skip')
    expect(r.reason).toBe('A project with this name exists.')
  })
})

describe('priorRuns', () => {
  const acct = (orgUuid: string) => ({ email: null, orgUuid, orgName: null, projectNames: [] })

  it('ignores dry-run receipts, other orgs and junk', () => {
    const out = priorRuns(
      [
        { dry_run: true, account: acct('org1'), projects: [{ key: 'a', chan: 'c1', complete: true }] },
        { dry_run: false, account: acct('org2'), projects: [{ key: 'b', chan: 'c2', complete: true }] },
        { dry_run: false, account: acct('org1'), projects: [{ key: 'c', chan: null }, { key: 7, chan: 'x' }, { chan: 'y' }, null] },
        { dry_run: false, account: acct('org1') },
        null,
        'str',
        { account: acct('org1'), projects: [{ key: 'e', chan: 'c5' }] }
      ],
      'org1'
    )
    expect(out.size).toBe(0)
  })

  it('later receipts win and complete needs exactly true', () => {
    const out = priorRuns(
      [
        { dry_run: false, account: acct('org1'), projects: [{ key: 'k', chan: 'c1', complete: false }, { key: 'm', chan: 'cm', complete: 'yes' }] },
        { dry_run: false, account: acct('org1'), projects: [{ key: 'k', chan: 'c9', complete: true }] }
      ],
      'org1'
    )
    expect(out.get('k')).toEqual({ chan: 'c9', complete: true })
    expect(out.get('m')).toEqual({ chan: 'cm', complete: false })
  })
})

// ---------------------------------------------------------------------------
// generated page scripts
// ---------------------------------------------------------------------------

type FetchInit = {
  method?: string
  credentials?: string
  headers?: Record<string, string>
  body?: unknown
}

class FakeFile {
  readonly size: number
  constructor(
    readonly parts: unknown[],
    readonly name: string,
    readonly opts: { type?: string } = {}
  ) {
    this.size = (parts[0] as Uint8Array).length
  }
  get type(): string {
    return this.opts.type ?? ''
  }
}

class FakeFormData {
  readonly entries: [string, unknown][] = []
  append(k: string, v: unknown): void {
    this.entries.push([k, v])
  }
}

/** Evaluate a generated page script like the page would, with fakes for the web APIs. */
function evalInPage(js: string, fetchImpl: (url: string, init?: FetchInit) => unknown, extra: { alert?: () => void } = {}): Promise<unknown> {
  const fn = new Function('fetch', 'FormData', 'File', 'atob', 'alert', `return ${js}`)
  return fn(fetchImpl, FakeFormData, FakeFile, atob, extra.alert ?? (() => {})) as Promise<unknown>
}

const okJson = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('apiCallJs', () => {
  it('calls fetch with the method, url and the app headers, content-type only with a body', async () => {
    const fetchSpy = vi.fn(async () => okJson({ hello: 1 }))
    const got = await evalInPage(apiCallJs('org-1', 'GET', '/v1/code/channels?scope=all'), fetchSpy)
    expect(got).toEqual({ ok: true, status: 200, j: { hello: 1 } })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, FetchInit]
    expect(url).toBe('/v1/code/channels?scope=all')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    expect(init.body).toBeUndefined()
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': 'org-1'
    })
    expect(init.headers).not.toHaveProperty('content-type')
  })

  it('sends a JSON body with a content-type header', async () => {
    const fetchSpy = vi.fn(async () => okJson({}, 201))
    await evalInPage(apiCallJs('org-1', 'POST', '/v1/code/channels', { name: 'X', n: [1, 2] }), fetchSpy)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, FetchInit]
    expect(init.method).toBe('POST')
    expect(init.headers!['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'X', n: [1, 2] })
  })

  it('reports ok false and a null body when the answer is not JSON', async () => {
    const fetchSpy = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      }
    })
    expect(await evalInPage(apiCallJs('o', 'GET', '/x'), fetchSpy)).toEqual({ ok: false, status: 502, j: null })
  })

  it('passes hostile text as data, not code', async () => {
    const alertSpy = vi.fn()
    const hostile = "a'); alert(1); ('"
    const nasty = { name: hostile, html: '</script><script>alert(2)</script>', sep: 'x y z', back: '\\"`${alert(3)}' }
    const fetchSpy = vi.fn(async () => okJson({}))
    await evalInPage(apiCallJs(hostile, 'POST', `/v1/${hostile}`, nasty), fetchSpy, { alert: alertSpy })
    expect(alertSpy).not.toHaveBeenCalled()
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, FetchInit]
    expect(url).toBe(`/v1/${hostile}`)
    expect(init.headers!['x-organization-uuid']).toBe(hostile)
    expect(JSON.parse(init.body as string)).toEqual(nasty)
  })
})

describe('page-side network errors', () => {
  const boom = async (): Promise<never> => {
    throw new TypeError('Failed to fetch')
  }

  it('apiCallJs resolves ok:false, status 0 when fetch throws', async () => {
    const got = (await evalInPage(apiCallJs('o', 'GET', '/x'), boom)) as { ok: boolean; status: number; j: unknown }
    expect(got.ok).toBe(false)
    expect(got.status).toBe(0)
    expect(JSON.stringify(got.j)).toContain('Failed to fetch')
  })

  it('uploadJs resolves ok:false, status 0, null file_uuid when fetch throws', async () => {
    const got = (await evalInPage(uploadJs('o', 'a', 'text/plain', 'YQ=='), boom)) as { ok: boolean; status: number; file_uuid: unknown }
    expect(got).toMatchObject({ ok: false, status: 0, file_uuid: null })
  })
})

describe('uploadJs', () => {
  it('uploads the decoded bytes as multipart form data to the org store', async () => {
    const fetchSpy = vi.fn(async () => okJson({ file_uuid: '11111111-2222-4333-8444-555555555555' }))
    const b64 = Buffer.from('hello').toString('base64')
    const got = await evalInPage(uploadJs('org-1', 'a.md', 'text/markdown', b64), fetchSpy)
    expect(got).toEqual({ ok: true, status: 200, file_uuid: '11111111-2222-4333-8444-555555555555', j: null })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, FetchInit]
    expect(url).toBe('/api/org-1/upload?store_as_is=true')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers).toBeUndefined()
    const fd = init.body as FakeFormData
    expect(fd.entries).toHaveLength(1)
    const [field, file] = fd.entries[0] as [string, FakeFile]
    expect(field).toBe('file')
    expect(file.name).toBe('a.md')
    expect(file.type).toBe('text/markdown')
    expect(file.size).toBe(5)
    expect(Array.from(file.parts[0] as Uint8Array)).toEqual(Array.from(Buffer.from('hello')))
  })

  it('returns the error body of a failed upload and a null file_uuid', async () => {
    const fetchSpy = async () => okJson({ error: { message: 'too big' } }, 413)
    expect(await evalInPage(uploadJs('o', 'a', 'text/plain', ''), fetchSpy)).toEqual({
      ok: false,
      status: 413,
      file_uuid: null,
      j: { error: { message: 'too big' } }
    })
  })

  it('passes a hostile file name and org as data', async () => {
    const alertSpy = vi.fn()
    const hostile = "a'); alert(1); ('</script> "
    const fetchSpy = vi.fn(async () => okJson({ file_uuid: 'u' }))
    await evalInPage(uploadJs(hostile, hostile, "text/plain'); alert(2); ('", 'YQ=='), fetchSpy, { alert: alertSpy })
    expect(alertSpy).not.toHaveBeenCalled()
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, FetchInit]
    expect(url).toBe(`/api/${hostile}/upload?store_as_is=true`)
    const file = (init.body as FakeFormData).entries[0][1] as FakeFile
    expect(file.name).toBe(hostile)
    expect(file.type).toBe("text/plain'); alert(2); ('")
  })
})

// ---------------------------------------------------------------------------
// fake claude.ai + pushPlan
// ---------------------------------------------------------------------------

const ORG = '0f0f0f0f-1111-4222-8333-444444444444'

interface Call {
  method: string
  path: string
  url: string
  body: unknown
  headers: Record<string, string>
}

class FakeClaude {
  calls: Call[] = []
  channels: { id: string; name: string; archived_at: string | null }[] = [{ id: 'chan_E', name: 'Existing', archived_at: null }]
  files = new Map<string, string[]>()
  memories = new Map<string, unknown[]>()
  config = new Map<string, unknown>()
  contextSources = new Map<string, unknown[]>()
  uploads: { name: string; uuid: string }[] = []
  email = 'new@example.com'
  /** files:write with more than one file answers 400. */
  failBatches = false
  /** files:write containing one of these paths answers 400. */
  failPaths = new Set<string>()
  /** files:write answers 200 but leaves these paths out of its results (and does not store them). */
  dropPaths = new Set<string>()
  memoryStatus = 200
  /** The next N project creates answer 429 "Too many projects created. Retry in 12s." */
  rateLimitedCreates = 0
  /** The next N uploads answer 429 with retry_after 2. */
  rateLimitedUploads = 0
  /** Every upload answers 429 "Exceeded file limits" (the account's upload limit). */
  fileLimit = false
  private created = 0

  fetch = async (url: string, init: FetchInit = {}): Promise<unknown> => {
    const method = init.method ?? 'GET'
    const path = url.split('?')[0]
    const isForm = init.body instanceof FakeFormData
    const body = isForm || init.body === undefined ? init.body : JSON.parse(init.body as string)
    this.calls.push({ method, path, url, body, headers: init.headers ?? {} })
    return this.route(method, path, body)
  }

  private route(method: string, path: string, body: unknown): unknown {
    if (method === 'GET' && path === '/api/organizations') return okJson([{ uuid: ORG, name: 'Org', capabilities: ['chat'] }])
    if (method === 'GET' && path === '/api/bootstrap') return okJson({ account: { email_address: this.email } })
    if (method === 'GET' && path === '/api/account_profile') return okJson({}, 404)
    if (method === 'GET' && path === '/v1/code/channels') return okJson({ data: this.channels })
    if (method === 'POST' && path === '/v1/code/channels') {
      if (this.rateLimitedCreates > 0) {
        this.rateLimitedCreates--
        return okJson({ error: { type: 'rate_limit_error', message: 'Too many projects created. Retry in 12s.' } }, 429)
      }
      const id = ++this.created === 1 ? 'chan_X' : `chan_X${this.created}`
      this.channels.push({ id, name: (body as { name: string }).name, archived_at: null })
      this.files.set(id, [])
      return okJson({ channel: { id } }, 201)
    }
    const one = /^\/v1\/code\/channels\/(chan_[^/]+)$/.exec(path)
    if (one !== null) {
      if (method === 'PATCH') this.contextSources.set(one[1], (body as { context_sources: unknown[] }).context_sources)
      return okJson({ channel: { id: one[1], context_sources: this.contextSources.get(one[1]) ?? [] } })
    }
    let m = /^\/v1\/code\/channels\/([^/]+)\/config$/.exec(path)
    if (m !== null) {
      if (method === 'PATCH') {
        this.config.set(m[1], (body as { system_prompt_addendum: string }).system_prompt_addendum)
        return okJson({})
      }
      return okJson({ system_prompt_addendum: this.config.get(m[1]) ?? null })
    }
    if (method === 'POST' && path === `/api/${ORG}/upload`) {
      if (this.fileLimit) {
        return okJson(
          { type: 'error', error: { type: 'rate_limit_error', message: 'Exceeded file limits', details: { error_code: 'file_limit_exceeded' } } },
          429
        )
      }
      if (this.rateLimitedUploads > 0) {
        this.rateLimitedUploads--
        return okJson({ error: { type: 'rate_limit_error', message: 'Too many uploads.' }, retry_after: 2 }, 429)
      }
      const file = (body as FakeFormData).entries[0][1] as FakeFile
      const uuid = randomUUID()
      this.uploads.push({ name: file.name, uuid })
      return okJson({ file_uuid: uuid })
    }
    m = /^\/v1\/code\/channels\/([^/]+)\/files:write$/.exec(path)
    if (m !== null && method === 'POST') {
      const files = (body as { files: { path: string; source_file_id: string }[] }).files
      if ((this.failBatches && files.length > 1) || files.some((f) => this.failPaths.has(f.path))) {
        return okJson({ error: { message: 'bad entry' } }, 400)
      }
      const kept = files.filter((f) => !this.dropPaths.has(f.path))
      this.files.get(m[1])!.push(...kept.map((f) => f.path))
      return okJson({ results: kept.map((f) => ({ path: f.path, entry: {} })) })
    }
    m = /^\/v1\/code\/channels\/([^/]+)\/files:list$/.exec(path)
    if (m !== null && method === 'POST') {
      const entries = (this.files.get(m[1]) ?? []).map((p) => ({ path: p, is_directory: false }))
      return okJson({ entries, has_more: false })
    }
    m = /^\/v1\/code\/memory\/channel\/([^/]+)\/memories$/.exec(path)
    if (m !== null) {
      const list = this.memories.get(m[1]) ?? []
      if (method === 'POST') {
        if (this.memoryStatus !== 200) return okJson({ error: { message: 'exists' } }, this.memoryStatus)
        list.push(body)
        this.memories.set(m[1], list)
        return okJson({ id: `mem_${list.length}` })
      }
      return okJson({ data: list })
    }
    return okJson({ error: { message: `no route ${method} ${path}` } }, 404)
  }

  executor(): PageExecutor {
    return {
      label: 'fake page',
      dispose: () => {},
      runInPage: (js) => evalInPage(js, this.fetch as (url: string, init?: FetchInit) => unknown)
    }
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('files:list'))
  }
  fileWrites(): Call[] {
    return this.calls.filter((c) => c.path.endsWith('files:write'))
  }
}

describe('pushPlan', () => {
  let tmp = ''
  let outputDir = ''
  let srcDir = ''

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claudelift-push-'))
    outputDir = join(tmp, 'out')
    srcDir = join(tmp, 'src')
    await mkdir(outputDir, { recursive: true })
    await mkdir(srcDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  async function project(
    key: string,
    name: string,
    fileCount: number,
    over: Record<string, unknown> = {}
  ): Promise<ReturnType<typeof PushPlanProjectSchema.parse>> {
    const library = []
    for (let i = 0; i < fileCount; i++) {
      const file = join(srcDir, `${key}-${i}.md`)
      await writeFile(file, `content ${key} ${i}`)
      library.push({ path: `/docs/${key}-${i}.md`, file, size: 10, mime: 'text/markdown' })
    }
    return PushPlanProjectSchema.parse({
      key,
      name,
      kind: 'claude-project',
      instructions: 'Be helpful.',
      library,
      memory: [{ path: '/notes.md', content: 'remember this' }],
      counts: {},
      ...over
    })
  }

  const planOf = (...projects: ReturnType<typeof PushPlanProjectSchema.parse>[]): PushPlan =>
    PushPlanSchema.parse({ plan_version: 1, source: 'test', projects })

  const run = (
    fake: FakeClaude,
    plan: PushPlan,
    over: Partial<Parameters<typeof pushPlan>[1]> = {}
  ): Promise<Awaited<ReturnType<typeof pushPlan>>> =>
    pushPlan(fake.executor(), {
      plan,
      planFile: join(outputDir, 'plan.json'),
      keys: plan.projects.map((p) => p.key),
      dryRun: false,
      expectEmail: 'new@example.com',
      outputDir,
      signal: new AbortController().signal,
      onProgress: () => {},
      ...over
    })

  const receiptFiles = async (prefix = ''): Promise<string[]> => {
    try {
      return (await readdir(join(outputDir, PUSH_RECEIPTS_DIR))).filter((n) => n.startsWith(prefix))
    } catch {
      return []
    }
  }
  const readReceipt = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'))

  it('WHOAMI_JS reads orgs and the account email from the page', async () => {
    const fake = new FakeClaude()
    const who = (await evalInPage(WHOAMI_JS, fake.fetch as never)) as { orgs: unknown[]; email: string }
    expect(who.email).toBe('new@example.com')
    expect(who.orgs).toEqual([{ uuid: ORG, name: 'Org', capabilities: ['chat'] }])
  })

  it('a dry run makes only GET calls and writes a dry-run receipt', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 3), await project('p2', 'Existing', 1))
    const events: PushProgress[] = []
    const res = await run(fake, plan, { dryRun: true, expectEmail: null, onProgress: (e) => events.push(e) })

    expect(fake.calls.length).toBeGreaterThan(0)
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(res.account).toMatchObject({ email: 'new@example.com', orgUuid: ORG, projectNames: ['Existing'] })
    expect(res.projects.map((p) => [p.name, p.action, p.complete])).toEqual([
      ['New Project', 'create', false],
      ['Existing', 'skip', true]
    ])
    expect(res.projects[1].reason).toBe('A project with this name exists.')
    expect(res.projects[0]).not.toHaveProperty('files')
    expect(events.some((e) => e.phase === 'done')).toBe(true)

    const names = await receiptFiles()
    expect(names).toHaveLength(1)
    expect(names[0].startsWith('dry-run-')).toBe(true)
    const receipt = await readReceipt(res.receiptFile)
    expect(receipt).toMatchObject({ dry_run: true, executor: 'fake page', cancelled: false })
    expect(receipt.finished_at).not.toBeNull()
  })

  it('refuses a real run whose account email does not match and writes nothing', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 2))
    await expect(run(fake, plan, { expectEmail: 'old@example.com' })).rejects.toThrow(/not old@example\.com/)
    await expect(run(fake, plan, { expectEmail: null })).rejects.toBeInstanceOf(PushError)
    expect(fake.writes()).toEqual([])
    expect(fake.uploads).toEqual([])
    expect(await receiptFiles()).toEqual([])
    await expect(readdir(join(outputDir, PUSH_RECEIPTS_DIR))).rejects.toThrow()
  })

  it('matches the expected email case-insensitively', async () => {
    const fake = new FakeClaude()
    const res = await run(fake, planOf(await project('p1', 'New Project', 1)), { expectEmail: 'NEW@Example.com' })
    expect(res.projects[0].action).toBe('create')
  })

  it('throws when no plan project was chosen', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 1))
    await expect(run(fake, plan, { keys: ['nope'] })).rejects.toThrow(/No project/)
  })

  it('creates, uploads, writes in batches of 25, adds memory, verifies and writes a receipt', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 30), await project('p2', 'Existing', 2))
    const events: PushProgress[] = []
    const res = await run(fake, plan, { onProgress: (e) => events.push(e) })

    // create + instructions
    const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/code/channels')!
    expect(create.body).toEqual({ name: 'New Project', visibility: 'private', context_sources: [] })
    const patch = fake.calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/v1/code/channels/chan_X/config')
    expect(patch.body).toEqual({ system_prompt_addendum: 'Be helpful.' })

    // every /v1/code call carries the headers
    for (const c of fake.calls.filter((c) => c.path.startsWith('/v1/code'))) {
      expect(c.headers['anthropic-beta']).toBe('ccr-byoc-2025-07-29')
      expect(c.headers['x-organization-uuid']).toBe(ORG)
      if (c.body !== undefined && c.body !== null) expect(c.headers['content-type']).toBe('application/json')
      else expect(c.headers).not.toHaveProperty('content-type')
    }

    // uploads and write batches
    expect(fake.uploads).toHaveLength(30)
    const writes = fake.fileWrites()
    expect(WRITE_BATCH).toBe(25)
    expect(writes.map((w) => (w.body as { files: unknown[] }).files.length).sort((a, b) => a - b)).toEqual([5, 25])
    const sent = writes.flatMap((w) => (w.body as { files: { path: string; source_file_id: string }[] }).files)
    expect(new Set(sent.map((f) => f.path)).size).toBe(30)
    expect(new Set(sent.map((f) => f.source_file_id))).toEqual(new Set(fake.uploads.map((u) => taggedId('file', u.uuid))))

    // memory with the not_exists precondition
    const mem = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/code/memory/channel/chan_X/memories')!
    expect(mem.body).toEqual({ path: '/notes.md', content: 'remember this', precondition: { type: 'not_exists' } })

    // result
    const [made, skipped] = res.projects
    expect(made).toMatchObject({
      key: 'p1',
      action: 'create',
      chan: 'chan_X',
      url: 'https://claude.ai/code/project/chan_X',
      instructions: 'set',
      complete: true,
      error: null,
      verify: { libraryFiles: 30, memoryFiles: 1 }
    })
    expect(made.library).toMatchObject({ planned: 30, written: 30, existing: 0, failed: [] })
    expect(made.memory).toMatchObject({ planned: 1, written: 1, failed: [] })
    expect(skipped).toMatchObject({ action: 'skip', reason: 'A project with this name exists.', chan: 'chan_E', complete: true })
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(1)
    expect(events.map((e) => e.phase)).toEqual(expect.arrayContaining(['account', 'checking', 'create', 'instructions', 'library', 'memory', 'verify', 'done']))

    // receipt file
    expect(res.receiptFile.startsWith(join(outputDir, PUSH_RECEIPTS_DIR, 'push-'))).toBe(true)
    const receipt = await readReceipt(res.receiptFile)
    expect(receipt).toMatchObject({ receipt_version: 1, dry_run: false, cancelled: false, plan_file: join(outputDir, 'plan.json') })
    expect(receipt.account).toMatchObject({ email: 'new@example.com', orgUuid: ORG })
    const rp = receipt.projects[0]
    expect(rp.chan).toBe('chan_X')
    expect(rp.files).toHaveLength(30)
    for (const f of rp.files) expect(f.source_file_id).toMatch(/^file_01[1-9A-HJ-NP-Za-km-z]{22}$/)
    expect(rp.memory_ids).toEqual(['mem_1'])
  })

  it('waits and retries when claude.ai rate-limits project creation (429)', async () => {
    const fake = new FakeClaude()
    fake.rateLimitedCreates = 2
    const waits: number[] = []
    const plan = planOf(await project('p1', 'Limited', 2))
    const res = await run(fake, plan, { sleep: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([13_000, 13_000])
    expect(res.projects[0].error).toBeNull()
    expect(res.projects[0].complete).toBe(true)
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(3)
  })

  it('gives up after MAX_RATE_RETRIES and reports the 429', async () => {
    const fake = new FakeClaude()
    fake.rateLimitedCreates = MAX_RATE_RETRIES + 5
    const plan = planOf(await project('p1', 'Always limited', 1))
    const res = await run(fake, plan, { sleep: async () => {} })
    expect(res.projects[0].error).toMatch(/HTTP 429/)
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(MAX_RATE_RETRIES + 1)
  })

  it('waits and retries a rate-limited upload, then writes the file', async () => {
    const fake = new FakeClaude()
    fake.rateLimitedUploads = 2
    const waits: number[] = []
    const plan = planOf(await project('p1', 'Upload limited', 1))
    const res = await run(fake, plan, { sleep: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([3000, 3000])
    expect(fake.calls.filter((c) => c.path === `/api/${ORG}/upload`)).toHaveLength(3)
    expect(res.projects[0].library).toMatchObject({ written: 1, failed: [] })
    expect(res.projects[0].complete).toBe(true)
  })

  it('a cancel ends a long 429 wait at once', async () => {
    const fake = new FakeClaude()
    fake.rateLimitedCreates = 1
    const ctl = new AbortController()
    const plan = planOf(await project('p1', 'Long wait', 1))
    // A sleep that never ends by itself: only the cancel can end the wait.
    const pending = run(fake, plan, { signal: ctl.signal, sleep: () => new Promise(() => {}) })
    await new Promise((r) => setTimeout(r, 50))
    ctl.abort()
    const res = await pending
    expect(res.cancelled).toBe(true)
  })

  it('a path claude.ai leaves out of the files:write results counts as failed, not written', async () => {
    const fake = new FakeClaude()
    fake.dropPaths.add('/docs/p1-1.md')
    const plan = planOf(await project('p1', 'Dropped', 3))
    const res = await run(fake, plan)
    expect(res.projects[0].library.written).toBe(2)
    expect(res.projects[0].library.failed).toEqual([
      expect.objectContaining({ path: '/docs/p1-1.md', step: 'write', error: 'claude.ai did not confirm this path' })
    ])
    expect(res.projects[0].complete).toBe(false)
  })

  it('links PC folders as local_folder context sources, keeping existing ones', async () => {
    const fake = new FakeClaude()
    const plan = planOf(
      await project('p1', 'Folders', 1, {
        context_sources: [
          { kind: 'local_folder', name: 'Brain', path: String.raw`C:\x\Brain` },
          { kind: 'local_folder', name: 'Old' }
        ]
      })
    )
    fake.contextSources.set('chan_X', [{ kind: 'local_folder', name: 'old', path: '', url: '' }])
    const res = await run(fake, plan)
    expect(res.projects[0].complete).toBe(true)
    const patch = fake.calls.find((c) => c.method === 'PATCH' && c.path === '/v1/code/channels/chan_X')
    expect(patch?.body).toEqual({
      context_sources: [
        { kind: 'local_folder', name: 'old' },
        { kind: 'local_folder', name: 'Brain' }
      ]
    })
  })

  it('topUp resumes a finished ClaudeLift project and adds only new files', async () => {
    const fake = new FakeClaude()
    const first = planOf(await project('p1', 'Grows', 2))
    await run(fake, first)
    const grown = planOf(await project('p1', 'Grows', 4))
    const skipped = await run(fake, grown)
    expect(skipped.projects[0].action).toBe('skip')
    const before = fake.uploads.length
    const topped = await run(fake, grown, { topUp: true })
    expect(topped.projects[0].action).toBe('resume')
    expect(fake.uploads.length - before).toBe(2)
    expect(topped.projects[0].library).toMatchObject({ written: 2, existing: 2 })
  })

  it('stops the whole run at the account upload limit, without waiting', async () => {
    const fake = new FakeClaude()
    fake.fileLimit = true
    const waits: number[] = []
    const plan = planOf(await project('p1', 'First', 3), await project('p2', 'Second', 1))
    const res = await run(fake, plan, { sleep: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([])
    expect(res.stopped).toMatch(/upload limit/)
    expect(res.projects).toHaveLength(1)
    expect(res.projects[0].error).toMatch(/upload limit/)
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(1)
    const receipt = await readReceipt(join(outputDir, PUSH_RECEIPTS_DIR, (await receiptFiles('push-'))[0]))
    expect(receipt.stopped).toMatch(/upload limit/)
  })

  it('a cancel during the 429 wait stops the run', async () => {
    const fake = new FakeClaude()
    fake.rateLimitedCreates = 5
    const ctl = new AbortController()
    const plan = planOf(await project('p1', 'Cancelled', 1))
    const res = await run(fake, plan, { signal: ctl.signal, sleep: async () => ctl.abort() })
    expect(res.cancelled).toBe(true)
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(1)
  })

  it('a second real run skips the project it already rebuilt', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 3))
    await run(fake, plan)
    const writesBefore = fake.writes().length
    const uploadsBefore = fake.uploads.length

    const again = await run(fake, plan)
    expect(again.projects[0]).toMatchObject({ action: 'skip', reason: 'Already rebuilt by ClaudeLift.', chan: 'chan_X', complete: true })
    expect(fake.writes().length).toBe(writesBefore)
    expect(fake.uploads.length).toBe(uploadsBefore)
  })

  it('resumes an incomplete earlier run: only missing files are sent, memory not duplicated', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 3))
    fake.failPaths.add('/docs/p1-1.md')
    const first = await run(fake, plan)
    expect(first.projects[0].complete).toBe(false)
    expect(first.projects[0].library.failed).toHaveLength(1)

    fake.failPaths.clear()
    fake.memoryStatus = 409
    const second = await run(fake, plan)
    const p = second.projects[0]
    expect(p.action).toBe('resume')
    expect(p.library).toMatchObject({ planned: 3, written: 1, existing: 2, failed: [] })
    expect(p.memory).toMatchObject({ written: 0, existing: 1 })
    expect(p.instructions).toBe('kept')
    expect(p.complete).toBe(true)
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/code/channels')).toHaveLength(1)
  })

  it('retries a rejected batch one file at a time', async () => {
    const fake = new FakeClaude()
    fake.failBatches = true
    const plan = planOf(await project('p1', 'New Project', 3))
    const res = await run(fake, plan)
    const sizes = fake.fileWrites().map((w) => (w.body as { files: unknown[] }).files.length)
    expect(sizes).toEqual([3, 1, 1, 1])
    expect(res.projects[0].library).toMatchObject({ written: 3, failed: [] })
    expect(res.projects[0].complete).toBe(true)
  })

  it('reports a file whose single write is also rejected', async () => {
    const fake = new FakeClaude()
    fake.failPaths.add('/docs/p1-1.md')
    const plan = planOf(await project('p1', 'New Project', 3))
    const res = await run(fake, plan)
    const p = res.projects[0]
    expect(p.library.written).toBe(2)
    expect(p.library.failed).toEqual([{ path: '/docs/p1-1.md', step: 'write', status: 400, error: 'bad entry' }])
    expect(p.complete).toBe(false)
  })

  it('does not upload a file larger than MAX_UPLOAD_BYTES and reports it failed', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 2))
    plan.projects[0].library[1].size = MAX_UPLOAD_BYTES + 1
    const res = await run(fake, plan)
    const p = res.projects[0]
    expect(fake.uploads).toHaveLength(1)
    expect(fake.uploads[0].name).toBe('p1-0.md')
    expect(p.library.written).toBe(1)
    expect(p.library.failed).toHaveLength(1)
    expect(p.library.failed[0]).toMatchObject({ path: '/docs/p1-1.md', step: 'upload', status: null })
    expect(p.library.failed[0].error).toMatch(/30 MB/)
    expect(p.complete).toBe(false)
  })

  it('reports an unreadable local file as a read failure', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 2))
    plan.projects[0].library[0].file = join(srcDir, 'missing.md')
    const res = await run(fake, plan)
    expect(res.projects[0].library.failed[0]).toMatchObject({ step: 'read', status: null })
    expect(res.projects[0].library.written).toBe(1)
  })

  it('skips the instructions call when there are none', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 1, { instructions: '   ' }))
    const res = await run(fake, plan)
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(res.projects[0].instructions).toBe('none')
  })

  it('an aborted signal stops the run, sets cancelled and keeps what was made in the receipt', async () => {
    const fake = new FakeClaude()
    const plan = planOf(await project('p1', 'New Project', 5), await project('p2', 'Second', 1))
    const ac = new AbortController()
    const res = await run(fake, plan, {
      signal: ac.signal,
      onProgress: (e) => {
        if (e.phase === 'instructions') ac.abort()
      }
    })
    expect(res.cancelled).toBe(true)
    expect(fake.uploads).toHaveLength(0)
    expect(res.projects.map((p) => p.key)).toEqual(['p1'])
    expect(res.projects[0].chan).toBe('chan_X')
    const receipt = await readReceipt(res.receiptFile)
    expect(receipt.cancelled).toBe(true)
    expect(receipt.finished_at).not.toBeNull()
    expect(receipt.projects[0].chan).toBe('chan_X')
  })

  it('an already aborted signal does nothing but write a cancelled receipt', async () => {
    const fake = new FakeClaude()
    const ac = new AbortController()
    ac.abort()
    const res = await run(fake, planOf(await project('p1', 'New Project', 2)), { signal: ac.signal })
    expect(res.cancelled).toBe(true)
    expect(res.projects).toEqual([])
    expect(fake.writes()).toEqual([])
  })

  it('records a failed create as the project error and moves on', async () => {
    const fake = new FakeClaude()
    const original = fake.fetch
    fake.fetch = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && url === '/v1/code/channels') return okJson({ error: { message: 'quota' } }, 403)
      return original(url, init)
    }
    const res = await run(fake, planOf(await project('p1', 'New Project', 1)))
    expect(res.projects[0].error).toMatch(/Could not create the project \(HTTP 403\): quota/)
    expect(res.projects[0].complete).toBe(false)
  })

  it('one upload whose page call rejects fails only that file', async () => {
    const fake = new FakeClaude()
    const base = fake.executor()
    const exec: PageExecutor = {
      ...base,
      runInPage: async (js) => {
        if (js.includes('upload?store_as_is') && js.includes('p1-1.md')) throw new Error('page crashed')
        return base.runInPage(js)
      }
    }
    const plan = planOf(await project('p1', 'New Project', 4))
    const res = await pushPlan(exec, {
      plan,
      planFile: 'p',
      keys: ['p1'],
      dryRun: false,
      expectEmail: 'new@example.com',
      outputDir,
      signal: new AbortController().signal,
      onProgress: () => {}
    })
    const p = res.projects[0]
    expect(p.error).toBeNull()
    expect(p.library.written).toBe(3)
    expect(p.library.failed).toHaveLength(1)
    expect(p.library.failed[0]).toMatchObject({ path: '/docs/p1-1.md', step: 'upload', status: null })
    expect(p.library.failed[0].error).toMatch(/page crashed/)
    expect(p.complete).toBe(false)
    const before = fake.calls.length
    const uploadsBefore = fake.uploads.length
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.calls.length).toBe(before)
    expect(fake.uploads.length).toBe(uploadsBefore)
  })

  it('stops before any create when a later channel page fails', async () => {
    const fake = new FakeClaude()
    const original = fake.fetch
    fake.fetch = async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/v1/code/channels')) {
        if (url.includes('cursor=')) return okJson({ error: { message: 'down' } }, 500)
        return okJson({ data: fake.channels, next_cursor: 'c2' })
      }
      return original(url, init)
    }
    await expect(run(fake, planOf(await project('p1', 'New Project', 1)))).rejects.toThrow(/HTTP 500/)
    expect(fake.writes()).toEqual([])
    await expect(run(fake, planOf(await project('p1', 'New Project', 1)), { dryRun: true, expectEmail: null })).rejects.toThrow(/HTTP 500/)
  })

  it('drops limit=200 on the retry and on later pages after a 400', async () => {
    const fake = new FakeClaude()
    const original = fake.fetch
    const listUrls: string[] = []
    fake.fetch = async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/v1/code/channels')) {
        listUrls.push(url)
        if (url.includes('limit=200')) return okJson({ error: { message: 'no limit' } }, 400)
        if (!url.includes('cursor=')) return okJson({ data: fake.channels, next_cursor: 'c2' })
        return okJson({ data: [{ id: 'chan_Z', name: 'Page Two', archived_at: null }] })
      }
      return original(url, init)
    }
    const res = await run(fake, planOf(await project('p1', 'Page Two', 1)), { dryRun: true, expectEmail: null })
    expect(listUrls).toEqual([
      '/v1/code/channels?scope=all&limit=200',
      '/v1/code/channels?scope=all',
      '/v1/code/channels?scope=all&cursor=c2'
    ])
    expect(res.projects[0]).toMatchObject({ action: 'skip', chan: 'chan_Z' })
  })

  it('throws when the page is not signed in', async () => {
    const exec: PageExecutor = { label: 'x', dispose: () => {}, runInPage: async () => ({ orgs: null, email: null }) }
    const plan = planOf(await project('p1', 'New Project', 1))
    await expect(
      pushPlan(exec, {
        plan,
        planFile: 'p',
        keys: ['p1'],
        dryRun: true,
        expectEmail: null,
        outputDir,
        signal: new AbortController().signal,
        onProgress: () => {}
      })
    ).rejects.toThrow(/not signed in/)
  })
})
