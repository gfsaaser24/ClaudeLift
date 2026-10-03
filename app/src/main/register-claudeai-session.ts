/**
 * ipcMain.handle registrations for the claude.ai session route (Migrate
 * view, card C, "Sign in inside ClaudeLift"): claudeAi:status (read-only),
 * claudeAi:signIn (opens the sign-in window), claudeAi:signOut,
 * claudeAi:runPull (hidden-window pull; progress pushed on
 * evt:claudeAiPullProgress) and claudeAi:cancel. Status changes found by
 * the sign-in window's poll are pushed on evt:claudeAiStatus.
 *
 * ERROR CONVENTION — identical to register-claude-console.ts: handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 * A cancelled pull arrives as kind 'aborted'.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import { ClaudeAiPullRequestSchema, EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc'
import {
  cancelPull,
  isClaudeSessionContents,
  openSignIn,
  pullsDir,
  runPull,
  setStatusListener,
  signOut,
  status
} from './claudeai-session'
import { BridgeError } from './devtools-bridge'
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

/** Defense in depth: claude.ai pages have no preload, but never serve them anyway. */
function assertAppSender(event: IpcMainInvokeEvent): void {
  if (isClaudeSessionContents(event.sender)) {
    throw new BridgeError('validation', 'not allowed from a claude.ai page')
  }
}

export interface RegisterClaudeAiSessionOptions {
  ipcMain: IpcMain
  state: StateStore
  sendToRenderer: SendToRenderer
}

export function registerClaudeAiSessionHandlers(options: RegisterClaudeAiSessionOptions): void {
  const { ipcMain, state, sendToRenderer } = options

  setStatusListener((current) => sendToRenderer(EVENT_CHANNELS.claudeAiStatus, current))

  ipcMain.handle(INVOKE_CHANNELS.claudeAiStatus, async (event) => {
    try {
      assertAppSender(event)
      return await status()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeAiSignIn, async (event) => {
    try {
      assertAppSender(event)
      openSignIn()
      return await status()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeAiSignOut, async (event) => {
    try {
      assertAppSender(event)
      return await signOut()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeAiRunPull, async (event, payload: unknown) => {
    try {
      assertAppSender(event)
      const req = ClaudeAiPullRequestSchema.parse(payload)
      const outDir = pullsDir(state.getSettings().outputDir)
      return await runPull({ ...req, outDir }, (progress) => {
        sendToRenderer(EVENT_CHANNELS.claudeAiPullProgress, progress)
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.claudeAiCancel, (event) => {
    if (isClaudeSessionContents(event.sender)) return
    cancelPull()
  })
}
