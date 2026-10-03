/**
 * Claude Desktop's Main Process Debugger as a page executor (optional
 * route for the project push and the DevTools fallback).
 *
 * Claude Desktop → Developer → "Enable Main Process Debugger" opens a Node
 * inspector on 127.0.0.1:9229. Over it, code in Claude Desktop's main
 * process finds the window whose page is on https://claude.ai and runs JS
 * there with `executeJavaScript` — the results come back directly. No
 * typing, no clipboard, no window titles. (`--remote-debugging-port` on the
 * command line is refused by the app; this menu item is the supported way.)
 *
 * Only a loopback inspector whose process path names Claude is used, never
 * ClaudeLift's own process. Pure helpers are exported for unit tests.
 */
import { BridgeError } from './devtools-bridge'

export const INSPECTOR_URL = 'http://127.0.0.1:9229'
const PROBE_TIMEOUT_MS = 1500
const EVAL_TIMEOUT_MS = 10 * 60 * 1000

interface InspectorTarget {
  type?: string
  webSocketDebuggerUrl?: string
}

/** The main-process target of a `/json/list` answer (loopback only), else null. */
export function pickInspectorTarget(list: unknown): string | null {
  if (!Array.isArray(list)) return null
  for (const raw of list as InspectorTarget[]) {
    if (raw?.type !== 'node' || typeof raw.webSocketDebuggerUrl !== 'string') continue
    try {
      const url = new URL(raw.webSocketDebuggerUrl)
      if (url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
        return raw.webSocketDebuggerUrl
      }
    } catch {
      // not a URL
    }
  }
  return null
}

/** Is `execPath` Claude Desktop (and not this app)? */
export function isClaudeDesktopPath(execPath: string, ownExecPath: string): boolean {
  if (execPath === '' || execPath.toLowerCase() === ownExecPath.toLowerCase()) return false
  const exe = execPath.split(/[\\/]/).pop() ?? ''
  return /^claude(\.exe)?$/i.test(exe)
}

/** Main-process expression that runs `pageJs` in Claude Desktop's claude.ai page; resolves a JSON string. */
export function mainProcessWrapper(pageJs: string): string {
  return `(async () => {
  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)
  const { webContents } = req('electron')
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getType() === 'window' && w.getURL().startsWith('https://claude.ai'))
  if (!wc) return JSON.stringify({ missing: true })
  const v = await wc.executeJavaScript(${JSON.stringify(pageJs)}, true)
  return JSON.stringify({ v: v === undefined ? null : v })
})()`
}

/** Like mainProcessWrapper, but starts `pageJs` without waiting for it (long scripts such as the pull). */
export function mainProcessStarter(pageJs: string): string {
  return `(async () => {
  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)
  const { webContents } = req('electron')
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getType() === 'window' && w.getURL().startsWith('https://claude.ai'))
  if (!wc) return JSON.stringify({ missing: true })
  wc.executeJavaScript(${JSON.stringify(pageJs)}, true).catch(() => undefined)
  return JSON.stringify({ v: true })
})()`
}

/** Unwrap the wrapper's answer. */
export function unwrapAnswer(raw: unknown): unknown {
  if (typeof raw !== 'string') throw new BridgeError('crash', 'Claude Desktop gave no answer.')
  const parsed = JSON.parse(raw) as { missing?: boolean; v?: unknown }
  if (parsed.missing === true) {
    throw new BridgeError('validation', 'Claude Desktop has no claude.ai page open. Open the Claude Desktop window and try again.')
  }
  return parsed.v ?? null
}

async function listTargets(): Promise<unknown> {
  const res = await fetch(`${INSPECTOR_URL}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  return res.json()
}

interface Cdp {
  send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): void
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  ws.addEventListener('message', (ev: MessageEvent) => {
    let msg: { id?: number; result?: Record<string, unknown>; error?: unknown }
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const p = pending.get(msg.id)
    if (p === undefined) return
    pending.delete(msg.id)
    if (msg.error !== undefined) p.reject(new BridgeError('crash', `Inspector error: ${JSON.stringify(msg.error).slice(0, 300)}`))
    else p.resolve(msg.result ?? {})
  })
  const failAll = (): void => {
    for (const p of pending.values()) p.reject(new BridgeError('crash', 'The connection to Claude Desktop closed.'))
    pending.clear()
  }
  ws.addEventListener('close', failAll)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new BridgeError('crash', 'Could not connect to Claude Desktop’s debugger.')), {
      once: true
    })
  })
  return {
    send(method, params) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new BridgeError('crash', 'The connection to Claude Desktop closed.'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      ws.close()
    }
  }
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const res = (await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true,
    timeout: EVAL_TIMEOUT_MS
  })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
  if (res.exceptionDetails !== undefined) {
    const d = res.exceptionDetails
    throw new BridgeError('crash', `Claude Desktop: ${(d.exception?.description ?? d.text ?? 'script error').slice(0, 300)}`)
  }
  return res.result?.value
}

/** Is Claude Desktop's Main Process Debugger open? Read-only. */
export async function desktopInspectorStatus(ownExecPath: string): Promise<{ available: boolean; detail: string }> {
  let wsUrl: string | null
  try {
    wsUrl = pickInspectorTarget(await listTargets())
  } catch {
    return { available: false, detail: 'Not open. In Claude Desktop: Developer → Enable Main Process Debugger.' }
  }
  if (wsUrl === null) return { available: false, detail: 'Port 9229 answers, but it is not a main-process debugger.' }
  let cdp: Cdp | null = null
  try {
    cdp = await connect(wsUrl)
    const execPath = await evaluate(cdp, 'process.execPath')
    if (typeof execPath !== 'string' || !isClaudeDesktopPath(execPath, ownExecPath)) {
      return { available: false, detail: 'The debugger on port 9229 is not Claude Desktop.' }
    }
    return { available: true, detail: 'Claude Desktop’s Main Process Debugger is open.' }
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    cdp?.close()
  }
}

/** Connect to Claude Desktop's main process and return a page executor. Dispose it when done. */
export async function openDesktopExecutor(ownExecPath: string): Promise<{
  label: string
  runInPage(js: string): Promise<unknown>
  /** Start `js` in the page and return at once (its result is not awaited). */
  startInPage(js: string): Promise<void>
  dispose(): void
}> {
  let wsUrl: string | null
  try {
    wsUrl = pickInspectorTarget(await listTargets())
  } catch {
    wsUrl = null
  }
  if (wsUrl === null) {
    throw new BridgeError('validation', 'Claude Desktop’s debugger is not open. In Claude Desktop: Developer → Enable Main Process Debugger.')
  }
  const cdp = await connect(wsUrl)
  const execPath = await evaluate(cdp, 'process.execPath').catch(() => null)
  if (typeof execPath !== 'string' || !isClaudeDesktopPath(execPath, ownExecPath)) {
    cdp.close()
    throw new BridgeError('validation', 'The debugger on port 9229 is not Claude Desktop.')
  }
  return {
    label: 'Claude Desktop',
    async runInPage(js: string): Promise<unknown> {
      return unwrapAnswer(await evaluate(cdp, mainProcessWrapper(js)))
    },
    async startInPage(js: string): Promise<void> {
      unwrapAnswer(await evaluate(cdp, mainProcessStarter(js)))
    },
    dispose: () => cdp.close()
  }
}
