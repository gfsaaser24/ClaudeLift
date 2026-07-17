/**
 * ipcMain.handle registrations for the notion:* channels (Task 13):
 * notion:connect, notion:disconnect, notion:status, notion:setParentPage,
 * notion:export, notion:retry.
 *
 * ERROR CONVENTION — identical to register-tasks.ts (its `toIpcError` is
 * module-private, so the tiny serializer is mirrored here): handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 * NotionApiError maps 4xx → 'validation' (user-fixable: bad token,
 * unshared page) and 5xx/other → 'crash', with `notion <status> <code>`
 * in `stderr` for diagnostics.
 *
 * notion:export / notion:retry are fire-and-forget: the handler validates
 * (connected + parent page set + payload shape) and rejects on those, but
 * the export itself runs detached — its failures land in the Notion
 * journal (status 'error') and on `evt:notionProgress`, never in the
 * invoke rejection.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { ZodError } from 'zod'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  NotionConnectRequestSchema,
  NotionExportRequestSchema,
  NotionRetryRequestSchema,
  NotionSetParentPageRequestSchema,
  type NotionExportRequest,
  type NotionStatus
} from '../shared/ipc'
import { EngineError, type EngineService } from './engine'
import type { StateStore } from './state'
import { NotionApiError, NotionClient, extractPageId } from './notion/client'
import { NotionExporter } from './notion/exporter'

const SHARE_GUIDANCE =
  'Share the page with your integration: page ••• menu → Connections → add your integration'

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
  } else if (err instanceof NotionApiError) {
    shape = {
      kind: err.status >= 400 && err.status < 500 ? 'validation' : 'crash',
      message: err.message,
      stderr: `notion ${err.status} ${err.code}`
    }
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

export interface RegisterNotionOptions {
  ipcMain: IpcMain
  state: StateStore
  engine: EngineService
  getWindow: () => BrowserWindow | null
  /** Test hook — defaults to the real NotionClient. */
  createClient?: (token: string) => NotionClient
}

export function registerNotionHandlers(options: RegisterNotionOptions): void {
  const { ipcMain, state, engine, getWindow } = options
  const createClient = options.createClient ?? ((token: string) => new NotionClient({ token }))

  const exporter = new NotionExporter({
    state,
    engine,
    createClient,
    sendProgress: (progressState) => {
      getWindow()?.webContents.send(EVENT_CHANNELS.notionProgress, progressState)
    }
  })

  /** `connected` = token stored && config populated (workspaceName set at connect). */
  const currentStatus = (): NotionStatus => {
    const config = state.getNotionConfig()
    return {
      connected: state.getNotionToken() !== null && config.workspaceName !== null,
      config,
      // Hydrated export log: the persisted per-task journal record, as the
      // NotionExportState[] the shared NotionStatus schema carries.
      journal: Object.values(state.getNotionJournal())
    }
  }

  /** Shared guard for the export channels. */
  const assertReadyToExport = (): void => {
    if (state.getNotionToken() === null) {
      throw new Error('Not connected to Notion — add your integration token first.')
    }
    if (state.getNotionConfig().parentPageId === null) {
      throw new Error('No Notion parent page set — paste a page URL first.')
    }
  }

  /** Detach an export run; its errors are journaled by the exporter. */
  const fireExport = (req: NotionExportRequest): void => {
    exporter.exportTask(req).catch((err: unknown) => {
      // exportTask handles its own errors; this only guards the guard.
      console.error('notion export rejected unexpectedly:', err)
    })
  }

  ipcMain.handle(INVOKE_CHANNELS.notionConnect, async (_event, payload: unknown) => {
    try {
      const req = NotionConnectRequestSchema.parse(payload)
      const token = req.token.trim()
      if (token.length === 0) throw new Error('Notion token is empty.')
      const me = await createClient(token).me() // validates the token
      state.setNotionToken(token)
      state.setNotionConfig({
        ...state.getNotionConfig(),
        workspaceName: me.bot?.workspace_name ?? 'Notion workspace',
        maxUploadBytes: me.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? null
      })
      return currentStatus()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.notionDisconnect, () => {
    try {
      state.setNotionToken(null)
      state.setNotionConfig({
        parentPageId: null,
        databaseId: null,
        dataSourceId: null,
        workspaceName: null,
        maxUploadBytes: null
      })
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.notionStatus, () => {
    try {
      return currentStatus()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.notionSetParentPage, async (_event, payload: unknown) => {
    try {
      const req = NotionSetParentPageRequestSchema.parse(payload)
      const pageId = extractPageId(req.url)
      if (pageId === null) {
        throw new Error('Could not find a Notion page id in that URL — paste the full page link.')
      }
      const token = state.getNotionToken()
      if (token === null) throw new Error('Connect to Notion first.')
      try {
        await createClient(token).getPage(pageId) // verify reachable
      } catch (err) {
        if (err instanceof NotionApiError && err.status === 404) {
          throw new Error(SHARE_GUIDANCE)
        }
        throw err
      }
      state.setNotionConfig({ ...state.getNotionConfig(), parentPageId: pageId })
      return currentStatus()
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.notionExport, (_event, payload: unknown) => {
    try {
      const req = NotionExportRequestSchema.parse(payload)
      assertReadyToExport()
      fireExport(req)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.notionRetry, (_event, payload: unknown) => {
    try {
      const req = NotionRetryRequestSchema.parse(payload)
      assertReadyToExport()
      // Re-run the full pipeline for this task; the journal keeps the run's
      // history and update-or-create makes the re-run safe.
      fireExport({ taskId: req.taskId })
    } catch (err) {
      throw toIpcError(err)
    }
  })
}
