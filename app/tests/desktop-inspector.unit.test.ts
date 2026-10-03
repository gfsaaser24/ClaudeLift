/**
 * Unit tests for the pure helpers of the Claude Desktop Main Process Debugger
 * executor. `electron` is mocked because devtools-bridge imports it at load.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => 'C:\\MockHome') },
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

import { BridgeError } from '../src/main/devtools-bridge'
import { isClaudeDesktopPath, mainProcessWrapper, pickInspectorTarget, unwrapAnswer } from '../src/main/desktop-inspector'

describe('pickInspectorTarget', () => {
  it('returns the ws URL of a loopback node target', () => {
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }])).toBe('ws://127.0.0.1:9229/abc')
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'ws://localhost:9229/abc' }])).toBe('ws://localhost:9229/abc')
  })

  it('skips targets that are not type node', () => {
    expect(pickInspectorTarget([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }])).toBeNull()
  })

  it('skips non-loopback hosts, wss and bad URLs', () => {
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'ws://10.0.0.5:9229/abc' }])).toBeNull()
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'ws://evil.com:9229/abc' }])).toBeNull()
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'wss://127.0.0.1:9229/abc' }])).toBeNull()
    expect(pickInspectorTarget([{ type: 'node', webSocketDebuggerUrl: 'not a url' }])).toBeNull()
    expect(pickInspectorTarget([{ type: 'node' }])).toBeNull()
  })

  it('takes the first good target and survives junk', () => {
    expect(
      pickInspectorTarget([null, 5, { type: 'node', webSocketDebuggerUrl: 'ws://8.8.8.8/x' }, { type: 'node', webSocketDebuggerUrl: 'ws://127.0.0.1:1/ok' }])
    ).toBe('ws://127.0.0.1:1/ok')
    expect(pickInspectorTarget('nope')).toBeNull()
    expect(pickInspectorTarget([])).toBeNull()
  })
})

describe('isClaudeDesktopPath', () => {
  const own = 'C:\\Program Files\\ClaudeLift\\ClaudeLift.exe'

  it('accepts claude.exe and claude', () => {
    expect(isClaudeDesktopPath('C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1\\claude.exe', own)).toBe(true)
    expect(isClaudeDesktopPath('C:\\x\\Claude.EXE', own)).toBe(true)
    expect(isClaudeDesktopPath('/Applications/Claude.app/Contents/MacOS/claude', own)).toBe(true)
  })

  it('rejects ClaudeLift itself, look-alikes and empty paths', () => {
    expect(isClaudeDesktopPath(own, own)).toBe(false)
    expect(isClaudeDesktopPath(own.toUpperCase(), own)).toBe(false)
    expect(isClaudeDesktopPath('C:\\x\\claudelift.exe', own)).toBe(false)
    expect(isClaudeDesktopPath('C:\\x\\claude-helper.exe', own)).toBe(false)
    expect(isClaudeDesktopPath('C:\\Claude\\node.exe', own)).toBe(false)
    expect(isClaudeDesktopPath('', own)).toBe(false)
  })
})

describe('mainProcessWrapper', () => {
  type Wc = {
    isDestroyed: () => boolean
    getType: () => string
    getURL: () => string
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  const wc = (url: string, result: unknown, type = 'window', destroyed = false): Wc => ({
    isDestroyed: () => destroyed,
    getType: () => type,
    getURL: () => url,
    executeJavaScript: vi.fn(async () => result)
  })
  const run = (js: string, list: Wc[]): Promise<unknown> => {
    const fakeRequire = (name: string): unknown => {
      if (name !== 'electron') throw new Error(`unexpected require ${name}`)
      return { webContents: { getAllWebContents: () => list } }
    }
    return new Function('require', `return ${mainProcessWrapper(js)}`)(fakeRequire) as Promise<unknown>
  }

  it('runs the page JS in the claude.ai window and returns a JSON string', async () => {
    const other = wc('https://example.com/', 'no')
    const page = wc('https://claude.ai/new', { a: 1 })
    const raw = await run('(async () => ({a:1}))()', [other, page])
    expect(typeof raw).toBe('string')
    expect(JSON.parse(raw as string)).toEqual({ v: { a: 1 } })
    expect(other.executeJavaScript).not.toHaveBeenCalled()
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('passes the page JS as a string literal, byte for byte', async () => {
    const js = "(async () => { const s = \"a'); alert(1); ('\\n\"; return `x${s}` })() // </script>\u2028"
    const page = wc('https://claude.ai/', 7)
    await run(js, [page])
    expect(page.executeJavaScript.mock.calls[0][0]).toBe(js)
    expect(mainProcessWrapper(js)).toContain(JSON.stringify(js))
  })

  it('maps an undefined result to null', async () => {
    const raw = await run('1', [wc('https://claude.ai/', undefined)])
    expect(JSON.parse(raw as string)).toEqual({ v: null })
  })

  it('reports missing when there is no live claude.ai window', async () => {
    const list = [wc('https://claude.ai/', 1, 'webview'), wc('https://claude.ai/', 1, 'window', true), wc('https://notclaude.ai/', 1)]
    expect(JSON.parse((await run('1', list)) as string)).toEqual({ missing: true })
    expect(JSON.parse((await run('1', [])) as string)).toEqual({ missing: true })
  })
})

describe('unwrapAnswer', () => {
  it('returns the value', () => {
    expect(unwrapAnswer('{"v":{"x":1}}')).toEqual({ x: 1 })
    expect(unwrapAnswer('{"v":null}')).toBeNull()
    expect(unwrapAnswer('{}')).toBeNull()
  })

  it('throws a validation BridgeError when the page is missing', () => {
    expect(() => unwrapAnswer('{"missing":true}')).toThrow(BridgeError)
    try {
      unwrapAnswer('{"missing":true}')
      expect.unreachable()
    } catch (err) {
      expect((err as BridgeError).kind).toBe('validation')
    }
  })

  it('throws a crash BridgeError when the answer is not a string', () => {
    try {
      unwrapAnswer(undefined)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).kind).toBe('crash')
    }
  })
})
