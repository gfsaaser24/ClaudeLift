/**
 * ipcMain.handle registrations for the Migrate view:
 * migrate:listWorkspaces (filesystem), migrate:convertClaudeAi and
 * migrate:importAll (engine, NDJSON progress pushed on
 * evt:convertProgress / evt:importAllProgress), migrate:importSpace
 * (engine), migrate:cancel.
 *
 * Every request payload is zod-parsed with the schemas from shared/ipc
 * before it reaches EngineService.
 *
 * ERROR CONVENTION — identical to register-tasks.ts (its `toIpcError` is
 * module-private, so the tiny serializer is mirrored here): handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 * Exit 3 "Claude Desktop is running" arrives as kind 'aborted' with the
 * engine's message in `stderr` (see DESKTOP_RUNNING_MARKER).
 */
import type { IpcMain } from 'electron'
import { ZodError } from 'zod'
import {
  ConvertClaudeAiOptionsSchema,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  ImportAllOptionsSchema,
  ImportSpaceOptionsSchema,
  ListWorkspacesRequestSchema
} from '../shared/ipc'
import { EngineError, type EngineService } from './engine'
import type { SendToRenderer } from './register-tasks'
import type { StateStore } from './state'
import { discoverRoots } from './watcher'
import { listWorkspaces } from './workspaces'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

/** Serialize any thrown value into the plain-Error-with-JSON-message shape. */
function toIpcError(err: unknown): Error {
  let shape: IpcErrorShape
  if (err instanceof EngineError) {
    shape = { kind: err.kind, message: err.message, stderr: err.stderr }
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

export interface RegisterMigrateOptions {
  ipcMain: IpcMain
  engine: EngineService
  state: StateStore
  sendToRenderer: SendToRenderer
}

export function registerMigrateHandlers(options: RegisterMigrateOptions): void {
  const { ipcMain, engine, state, sendToRenderer } = options

  ipcMain.handle(INVOKE_CHANNELS.migrateListWorkspaces, async (_event, payload: unknown) => {
    try {
      const req = ListWorkspacesRequestSchema.parse(payload ?? {})
      // Same root discovery as diagnostics/watcher: an explicit request root
      // wins, then the settings override, then auto-discovery.
      const override = req.coworkRoot ?? state.getSettings().coworkRootOverride
      return await listWorkspaces(discoverRoots(override))
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.migrateConvertClaudeAi, async (_event, payload: unknown) => {
    try {
      const opts = ConvertClaudeAiOptionsSchema.parse(payload)
      return await engine.convertClaudeAi(opts, (event) => {
        sendToRenderer(EVENT_CHANNELS.convertProgress, event)
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.migrateImportAll, async (_event, payload: unknown) => {
    try {
      const opts = ImportAllOptionsSchema.parse(payload)
      return await engine.importAll(opts, (event) => {
        sendToRenderer(EVENT_CHANNELS.importAllProgress, event)
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.migrateImportSpace, async (_event, payload: unknown) => {
    try {
      const opts = ImportSpaceOptionsSchema.parse(payload)
      return await engine.importSpace(opts)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.migrateCancel, () => {
    engine.cancelMigrate()
  })
}
