/**
 * Unit tests for the pure helpers of the claude.ai session route.
 *
 * `electron` is mocked: claudeai-session imports BrowserWindow/session (and
 * devtools-bridge imports app/clipboard) at module load, but nothing here
 * opens a window, creates a session or signs in.
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
  },
  session: {
    fromPartition: vi.fn(() => {
      throw new Error('tests must not create a session')
    })
  },
  BrowserWindow: vi.fn(() => {
    throw new Error('tests must not open a window')
  })
}))

import {
  CLAUDE_PARTITION,
  isAllowedSessionUrl,
  isAllowedSubframeUrl,
  isClaudeUrl,
  isLoginUrl,
  isPullDownload,
  orgsFromResponse,
  parsePullConsoleLine,
  pullsDir
} from '../src/main/claudeai-session'
import { pullFileName } from '../src/main/devtools-bridge'
import {
  ClaudeAiPullProgressSchema,
  ClaudeAiPullRequestSchema,
  ClaudeAiSessionStatusSchema
} from '../src/shared/ipc'

describe('isAllowedSessionUrl', () => {
  it('allows claude.ai and its sign-in providers over https', () => {
    expect(isAllowedSessionUrl('https://claude.ai/login')).toBe(true)
    expect(isAllowedSessionUrl('https://claude.ai/new?x=1#y')).toBe(true)
    expect(isAllowedSessionUrl('https://www.anthropic.com/legal')).toBe(true)
    expect(isAllowedSessionUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(true)
    expect(isAllowedSessionUrl('https://accounts.google.co.uk/CheckCookie')).toBe(true)
    expect(isAllowedSessionUrl('https://accounts.youtube.com/accounts/SetSID')).toBe(true)
    expect(isAllowedSessionUrl('https://appleid.apple.com/auth/authorize')).toBe(true)
    expect(isAllowedSessionUrl('https://login.microsoftonline.com/common/oauth2')).toBe(true)
    expect(isAllowedSessionUrl('https://api.workos.com/sso/authorize')).toBe(true)
    expect(isAllowedSessionUrl('https://acme.okta.com/app/x')).toBe(true)
    expect(isAllowedSessionUrl('about:blank')).toBe(true)
  })

  it('blocks file:, http:, other schemes and look-alike hosts', () => {
    expect(isAllowedSessionUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedSessionUrl('http://claude.ai/login')).toBe(false)
    expect(isAllowedSessionUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedSessionUrl('data:text/html,<b>x</b>')).toBe(false)
    expect(isAllowedSessionUrl('https://claude.ai.evil.com/login')).toBe(false)
    expect(isAllowedSessionUrl('https://evilclaude.ai/')).toBe(false)
    expect(isAllowedSessionUrl('https://accounts.google.com.evil.com/')).toBe(false)
    expect(isAllowedSessionUrl('https://user:pass@claude.ai/')).toBe(false)
    expect(isAllowedSessionUrl('https://example.com/')).toBe(false)
    expect(isAllowedSessionUrl('not a url')).toBe(false)
  })
})

describe('isAllowedSubframeUrl', () => {
  it('allows web content in sub-frames but never local files', () => {
    expect(isAllowedSubframeUrl('https://challenges.cloudflare.com/x')).toBe(true)
    expect(isAllowedSubframeUrl('about:blank')).toBe(true)
    expect(isAllowedSubframeUrl('blob:https://claude.ai/123')).toBe(true)
    expect(isAllowedSubframeUrl('file:///C:/secret.txt')).toBe(false)
    expect(isAllowedSubframeUrl('http://example.com/')).toBe(false)
    expect(isAllowedSubframeUrl('chrome://settings')).toBe(false)
  })
})

describe('isClaudeUrl / isLoginUrl', () => {
  it('recognizes claude.ai pages', () => {
    expect(isClaudeUrl('https://claude.ai/')).toBe(true)
    expect(isClaudeUrl('https://claude.ai/project/abc')).toBe(true)
    expect(isClaudeUrl('https://www.claude.ai/')).toBe(false)
    expect(isClaudeUrl('https://claude.ai.evil.com/')).toBe(false)
    expect(isClaudeUrl('')).toBe(false)
  })

  it('recognizes the sign-in pages only', () => {
    expect(isLoginUrl('https://claude.ai/login')).toBe(true)
    expect(isLoginUrl('https://claude.ai/login?returnTo=%2Fnew')).toBe(true)
    expect(isLoginUrl('https://claude.ai/logout')).toBe(true)
    expect(isLoginUrl('https://claude.ai/magic-link#abc')).toBe(true)
    expect(isLoginUrl('https://claude.ai/new')).toBe(false)
    expect(isLoginUrl('https://claude.ai/loginx')).toBe(false)
    expect(isLoginUrl('https://evil.com/login')).toBe(false)
  })
})

describe('parsePullConsoleLine', () => {
  it('strips the %c directive and its CSS argument', () => {
    expect(parsePullConsoleLine('%c[pull] color:#E2571D;font-weight:bold Acme: 3 project(s)')).toBe(
      'Acme: 3 project(s)'
    )
  })

  it('accepts an already formatted line', () => {
    expect(parsePullConsoleLine('[pull] Done: 2 project(s), 1.2 MB → claudelift-pull-x.json')).toBe(
      'Done: 2 project(s), 1.2 MB → claudelift-pull-x.json'
    )
    expect(parsePullConsoleLine('  [pull] Wrong window: run this …')).toBe('Wrong window: run this …')
  })

  it('keeps a colon in the text when there was no %c', () => {
    expect(parsePullConsoleLine('[pull] Done: 1')).toBe('Done: 1')
  })

  it('ignores every other console message', () => {
    expect(parsePullConsoleLine('Download the React DevTools')).toBeNull()
    expect(parsePullConsoleLine('x [pull] not at the start')).toBeNull()
    expect(parsePullConsoleLine('')).toBeNull()
  })

  it('caps very long lines', () => {
    const line = parsePullConsoleLine(`[pull] ${'a'.repeat(5000)}`)
    expect(line?.length).toBe(2001)
  })
})

describe('isPullDownload', () => {
  const runId = '20261002-101500-abc123'

  it('matches only this run’s pull file', () => {
    expect(isPullDownload(pullFileName(runId), runId)).toBe(true)
    expect(isPullDownload(pullFileName(runId).toUpperCase(), runId)).toBe(true)
    expect(isPullDownload('claudelift-pull-other.json', runId)).toBe(false)
    expect(isPullDownload(`${pullFileName(runId)}.crdownload`, runId)).toBe(false)
    expect(isPullDownload('report.pdf', runId)).toBe(false)
  })
})

describe('orgsFromResponse', () => {
  it('is signed in for 200 + a non-empty array, keeping only org names', () => {
    const body = [
      { uuid: 'u1', name: 'Personal', capabilities: ['chat'], settings: { secret: 'x' } },
      { uuid: 'u2', name: '  Team  ' },
      { uuid: 'u3' }
    ]
    expect(orgsFromResponse(200, body)).toEqual({ signedIn: true, orgNames: ['Personal', 'Team'] })
  })

  it('is signed out for errors, empty lists and other shapes', () => {
    expect(orgsFromResponse(403, [{ name: 'x' }])).toEqual({ signedIn: false, orgNames: [] })
    expect(orgsFromResponse(200, [])).toEqual({ signedIn: false, orgNames: [] })
    expect(orgsFromResponse(200, { error: 'nope' })).toEqual({ signedIn: false, orgNames: [] })
    expect(orgsFromResponse(200, null)).toEqual({ signedIn: false, orgNames: [] })
  })
})

describe('pullsDir and constants', () => {
  it('puts pulls under the export folder', () => {
    expect(pullsDir(join('C:', 'out'))).toBe(join('C:', 'out', 'claude-account-pulls'))
  })

  it('uses a persistent dedicated partition', () => {
    expect(CLAUDE_PARTITION).toBe('persist:claudeai')
  })
})

describe('claude.ai IPC schemas', () => {
  it('validates pull requests like the DevTools route', () => {
    expect(ClaudeAiPullRequestSchema.safeParse({ runId: 'abcd-1234', chats: 'list' }).success).toBe(true)
    expect(ClaudeAiPullRequestSchema.safeParse({ runId: '../x', chats: 'list' }).success).toBe(false)
    expect(ClaudeAiPullRequestSchema.safeParse({ runId: 'abcd', chats: 'all' }).success).toBe(false)
    // outDir is chosen by main, never by the renderer.
    expect(ClaudeAiPullRequestSchema.parse({ runId: 'abcd', chats: 'none', outDir: 'C:\\x' })).toEqual({
      runId: 'abcd',
      chats: 'none'
    })
  })

  it('parses status and progress payloads', () => {
    expect(
      ClaudeAiSessionStatusSchema.safeParse({ signedIn: true, orgNames: ['A'], signInWindowOpen: false, error: null })
        .success
    ).toBe(true)
    expect(
      ClaudeAiPullProgressSchema.safeParse({
        runId: 'abcd',
        phase: 'running',
        elapsedSec: 3,
        line: 'Acme: 3 project(s)',
        fileBytes: null
      }).success
    ).toBe(true)
  })
})
