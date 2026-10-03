/**
 * Unit tests for the pure helpers of the Claude Desktop DevTools bridge.
 *
 * `electron` is mocked: the bridge imports app/clipboard at module load,
 * but nothing here touches a real window, clipboard or PowerShell.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => join('C:', 'MockHome', 'Downloads'))
  },
  clipboard: {
    readText: vi.fn(() => ''),
    readHTML: vi.fn(() => ''),
    readRTF: vi.fn(() => ''),
    readImage: vi.fn(() => ({ isEmpty: () => true })),
    writeText: vi.fn(),
    write: vi.fn(),
    clear: vi.fn()
  }
}))

import {
  buildPullScript,
  encodePowerShell,
  isClaudeConsoleTitle,
  matchPullFile,
  parseFindOutput,
  parsePowerShellJson,
  pickClaudeConsole,
  psQuote,
  pullFileName,
  updateStability,
  type PsWindow
} from '../src/main/devtools-bridge'
import { isInsideDir } from '../src/main/register-claude-console'
import { ClaudeConsolePullRequestSchema, ConvertProgressEventSchema, convertDoneExtras } from '../src/shared/ipc'

const win = (title: string, hwnd = 1): PsWindow => ({
  hwnd,
  title,
  left: 0,
  top: 0,
  right: 800,
  bottom: 600,
  minimized: false
})

describe('isClaudeConsoleTitle', () => {
  it('accepts the claude.ai DevTools title with or without a path', () => {
    expect(isClaudeConsoleTitle('Developer Tools - https://claude.ai')).toBe(true)
    expect(isClaudeConsoleTitle('Developer Tools - https://claude.ai/new')).toBe(true)
    expect(isClaudeConsoleTitle('Developer Tools - https://claude.ai/project/abc?x=1')).toBe(true)
  })

  it('rejects the app-shell DevTools and look-alike hosts', () => {
    expect(isClaudeConsoleTitle('Developer Tools - file:///C:/x/app.asar/index.html')).toBe(false)
    expect(isClaudeConsoleTitle('Developer Tools - https://claude.ai.evil.com/')).toBe(false)
    expect(isClaudeConsoleTitle('Developer Tools - https://claude.aix')).toBe(false)
    expect(isClaudeConsoleTitle('Claude')).toBe(false)
  })
})

describe('pickClaudeConsole', () => {
  it('skips the app-shell DevTools and picks the claude.ai one', () => {
    const picked = pickClaudeConsole([
      win('Developer Tools - file:///C:/app.asar/index.html', 1),
      win('Developer Tools - https://claude.ai/new', 2)
    ])
    expect(picked?.hwnd).toBe(2)
  })

  it('returns null when only other windows exist', () => {
    expect(pickClaudeConsole([win('Developer Tools - file:///x', 1)])).toBeNull()
    expect(pickClaudeConsole([])).toBeNull()
  })
})

describe('parsePowerShellJson', () => {
  it('takes the last JSON line and ignores noise and a BOM', () => {
    const out = '\uFEFFWARNING: something\r\n{"ok":true,"n":1}\r\n{"ok":true,"n":2}\r\n'
    expect(parsePowerShellJson(out)).toEqual({ ok: true, n: 2 })
  })

  it('skips a truncated trailing line', () => {
    expect(parsePowerShellJson('{"ok":true}\n{"ok":tr')).toEqual({ ok: true })
  })

  it('throws when there is no JSON', () => {
    expect(() => parsePowerShellJson('nothing here')).toThrow(/no JSON/)
  })
})

describe('parseFindOutput', () => {
  it('parses a window array', () => {
    const out = JSON.stringify({
      ok: true,
      windows: [win('Developer Tools - https://claude.ai/new', 1234)]
    })
    expect(parseFindOutput(out)).toHaveLength(1)
    expect(parseFindOutput(out)[0].hwnd).toBe(1234)
  })

  it('accepts a lone object and an empty list', () => {
    const one = JSON.stringify({ ok: true, windows: win('Developer Tools - https://claude.ai', 7) })
    expect(parseFindOutput(one).map((w) => w.hwnd)).toEqual([7])
    expect(parseFindOutput('{"ok":true,"windows":[]}')).toEqual([])
    expect(parseFindOutput('{"ok":true,"windows":null}')).toEqual([])
  })

  it('surfaces the script error message', () => {
    expect(() => parseFindOutput('{"ok":false,"error":"boom"}')).toThrow('boom')
  })
})

describe('matchPullFile', () => {
  const runId = '20261002-101500-abc123'

  it('matches the exact file name', () => {
    expect(matchPullFile(['a.json', pullFileName(runId)], runId)).toBe(`claudelift-pull-${runId}.json`)
  })

  it('accepts a browser de-dupe suffix but prefers the exact name', () => {
    expect(matchPullFile([`claudelift-pull-${runId} (1).json`], runId)).toBe(`claudelift-pull-${runId} (1).json`)
    expect(
      matchPullFile([`claudelift-pull-${runId} (1).json`, `claudelift-pull-${runId}.json`], runId)
    ).toBe(`claudelift-pull-${runId}.json`)
  })

  it('ignores partial downloads and other runs', () => {
    expect(matchPullFile([`claudelift-pull-${runId}.json.crdownload`], runId)).toBeNull()
    expect(matchPullFile(['claudelift-pull-other.json', 'Unconfirmed 123.crdownload'], runId)).toBeNull()
    expect(matchPullFile([`claudelift-pull-${runId}x.json`], runId)).toBeNull()
  })
})

describe('updateStability', () => {
  it('is stable only after the same non-zero size for the window', () => {
    let s = updateStability(null, 100, 0, 3000)
    expect(s.stable).toBe(false)
    s = updateStability(s.state, 100, 2000, 3000)
    expect(s.stable).toBe(false)
    s = updateStability(s.state, 100, 3000, 3000)
    expect(s.stable).toBe(true)
  })

  it('restarts the window when the size changes', () => {
    let s = updateStability(null, 100, 0, 3000)
    s = updateStability(s.state, 200, 2500, 3000)
    expect(s.state.since).toBe(2500)
    s = updateStability(s.state, 200, 4000, 3000)
    expect(s.stable).toBe(false)
    s = updateStability(s.state, 200, 5500, 3000)
    expect(s.stable).toBe(true)
  })

  it('never calls an empty file stable', () => {
    let s = updateStability(null, 0, 0, 3000)
    s = updateStability(s.state, 0, 10_000, 3000)
    expect(s.stable).toBe(false)
  })
})

describe('buildPullScript', () => {
  it('prepends the options global as valid JS', () => {
    const js = buildPullScript('console.log(1)', { runId: 'abcd', chats: 'list' })
    expect(js.split('\n')[0]).toBe('globalThis.__CLAUDELIFT_PULL_OPTS = {"runId":"abcd","chats":"list"};')
    expect(js.endsWith('console.log(1)')).toBe(true)
    const g: { __CLAUDELIFT_PULL_OPTS?: unknown } = {}
    new Function('globalThis', js.split('\n')[0])(g)
    expect(g.__CLAUDELIFT_PULL_OPTS).toEqual({ runId: 'abcd', chats: 'list' })
  })
})

describe('PowerShell quoting / encoding', () => {
  it('doubles single quotes', () => {
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'")
  })

  it('encodes UTF-16LE base64', () => {
    expect(Buffer.from(encodePowerShell('Ab'), 'base64')).toEqual(Buffer.from([0x41, 0, 0x62, 0]))
  })
})

describe('pull request schema', () => {
  it('rejects run ids that could break a file name or the JS', () => {
    expect(ClaudeConsolePullRequestSchema.safeParse({ runId: 'abcd-1234', chats: 'full' }).success).toBe(true)
    expect(ClaudeConsolePullRequestSchema.safeParse({ runId: '../x', chats: 'list' }).success).toBe(false)
    expect(ClaudeConsolePullRequestSchema.safeParse({ runId: 'a"b;c', chats: 'list' }).success).toBe(false)
    expect(ClaudeConsolePullRequestSchema.safeParse({ runId: 'abcd', chats: 'all' }).success).toBe(false)
  })
})

describe('convert done extras', () => {
  it('keeps unknown numeric counters from a newer engine', () => {
    const done = ConvertProgressEventSchema.parse({
      event: 'done',
      output: 'C:\\out',
      conversations: 0,
      projects: 3,
      memory_files: 2,
      design_chats: 0,
      artifact_files: 0,
      account_files: 4,
      note: 'text is ignored'
    })
    expect(convertDoneExtras(done as Record<string, unknown>)).toEqual({ account_files: 4 })
  })
})

describe('isInsideDir', () => {
  it('accepts the root and folders below it, case-insensitively', () => {
    expect(isInsideDir('C:\\Out', 'C:\\out')).toBe(true)
    expect(isInsideDir('C:\\out\\claude-account', 'C:\\Out')).toBe(true)
  })

  it('rejects siblings and parents', () => {
    expect(isInsideDir('C:\\out2', 'C:\\out')).toBe(false)
    expect(isInsideDir('C:\\', 'C:\\out')).toBe(false)
    expect(isInsideDir('D:\\out', 'C:\\out')).toBe(false)
  })
})
