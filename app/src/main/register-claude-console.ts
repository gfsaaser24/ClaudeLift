/**
 * ipcMain.handle registrations for the Claude Desktop DevTools bridge
 * (Migrate view, card C): claudeConsole:find / :screenshot (read-only),
 * claudeConsole:runPull (types the account-pull script into the claude.ai
 * DevTools console and waits for its download; progress pushed on
 * evt:claudeConsoleProgress) and claudeConsole:cancel.
 *
 * ERROR CONVENTION — identical to register-tasks.ts: handlers throw a plain
 * Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 * A cancelled pull arrives as kind 'aborted'.
 */
import type { IpcMain, Shell } from 'electron'
import { statSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'
import { ZodError } from 'zod'
import {
  ClaudeConsolePullRequestSchema,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  OpenFolderRequestSchema
} from '../shared/ipc'
import { BridgeError, cancelPull, findClaudeConsole, runPull, screenshotConsole } from './devtools-bridge'
import type { SendToRenderer } from './register-tasks'
import type { StateStore } from './state'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

function toIpcError(err: unknown): Error {
  let shape: IpcErrorShape
  if (err instanceof BridgeError) {
    shape = { kind: err.kind, message: err.message, stderr: '' }
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

/** True when `dir` is `root` or inside it (case-insensitive, Windows paths). */
export function isInsideDir(dir: string, root: string): boolean {
  const rel = relative(resolve(root).toLowerCase(), resolve(dir).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface RegisterClaudeConsoleOptions {
  ipcMain: IpcMain
  shell: Shell
  state: StateStore
  sendToRenderer: SendToRenderer
}

export function registerClaudeConsoleHandlers(options: RegisterClaudeConsoleOptions): void {
  const { ipcMain, shell, state, sendToRenderer } = options

  ipcMain.handle(INVOKE_CHANNELS.claudeConsoleFind, async () => {
    try {
      return await findClaudeConsole()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeConsoleScreenshot, async () => {
    try {
      return { png: await screenshotConsole() }
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeConsoleRunPull, async (_event, payload: unknown) => {
    try {
      const req = ClaudeConsolePullRequestSchema.parse(payload)
      return await runPull(req, (event) => {
        sendToRenderer(EVENT_CHANNELS.claudeConsoleProgress, event)
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeConsoleCancel, () => {
    cancelPull()
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeConsoleOpenOutput, async (_event, payload: unknown) => {
    try {
      const req = OpenFolderRequestSchema.parse(payload)
      const dir = resolve(req.dir)
      if (!isInsideDir(dir, state.getSettings().outputDir)) {
        throw new BridgeError('validation', `not inside the export folder: ${dir}`)
      }
      let isDirectory = false
      try {
        isDirectory = statSync(dir).isDirectory()
      } catch {
        // reported below
      }
      if (!isDirectory) throw new BridgeError('validation', `folder does not exist: ${dir}`)
      const failure = await shell.openPath(dir)
      if (failure !== '') throw new Error(`could not open folder: ${failure}`)
    } catch (err) {
      throw toIpcError(err)
    }
  })
}
