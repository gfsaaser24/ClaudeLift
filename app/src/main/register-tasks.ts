/**
 * ipcMain.handle registrations for the engine-backed channels:
 * tasks:list, tasks:export, tasks:exportCancel, bundles:import, bundles:seed.
 *
 * Every request payload is zod-parsed with the schemas from shared/ipc
 * before it reaches EngineService.
 *
 * ERROR CONVENTION (binding for the renderer wrapper): Electron flattens a
 * rejection from an `ipcMain.handle` callback into a bare `Error` whose
 * message is the only thing that survives the wire — custom classes and
 * extra properties (EngineError.kind/stderr) are stripped. So handlers
 * throw a plain Error whose MESSAGE is a JSON document:
 *
 *   {"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}
 *
 * `ipcRenderer.invoke` then rejects with a message of the form
 * `Error invoking remote method '<channel>': Error: <json>`; the renderer
 * extracts the first `{` onwards and JSON.parses it to recover the
 * structured error (falling back to the raw message when parsing fails).
 */
import type { IpcMain } from 'electron'
import { ZodError } from 'zod'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  ExportOptionsSchema,
  ImportOptionsSchema,
  SeedOptionsSchema,
  TasksListRequestSchema,
  type EventChannel,
  type ProgressEvent
} from '../shared/ipc'
import { EngineError, type EngineService } from './engine'

export type SendToRenderer = (channel: EventChannel, payload: unknown) => void

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

export function registerTaskHandlers(ipcMain: IpcMain, engine: EngineService, sendToRenderer: SendToRenderer): void {
  ipcMain.handle(INVOKE_CHANNELS.tasksList, async (_event, payload: unknown) => {
    try {
      const req = TasksListRequestSchema.parse(payload)
      return await engine.listTasks(req.source, req.coworkRoot)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.tasksExport, async (_event, payload: unknown) => {
    try {
      const opts = ExportOptionsSchema.parse(payload)
      return await engine.exportTasks(opts, (event: ProgressEvent) => {
        sendToRenderer(EVENT_CHANNELS.exportProgress, event)
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.tasksExportCancel, () => {
    engine.cancelExport()
  })

  ipcMain.handle(INVOKE_CHANNELS.bundlesImport, async (_event, payload: unknown) => {
    try {
      const opts = ImportOptionsSchema.parse(payload)
      return await engine.importBundle(opts)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.bundlesSeed, async (_event, payload: unknown) => {
    try {
      const opts = SeedOptionsSchema.parse(payload)
      return await engine.makeSeed(opts)
    } catch (err) {
      throw toIpcError(err)
    }
  })
}
