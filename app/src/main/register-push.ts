/**
 * ipcMain.handle registrations for the Migrate view, card D "Rebuild
 * projects in the new account" (docs/NEW-LAYOUT-SPEC.md):
 * push:plan (engine `plan-push`), push:account and push:desktopStatus
 * (read-only), push:run (progress pushed on evt:pushProgress), push:cancel.
 *
 * Plans are written only to `<outputDir>/push-plans`, and push:run only
 * reads plans from there, so the renderer cannot point the push at other
 * files. Executors: 'claudeai' = ClaudeLift's own claude.ai sign-in
 * (hidden window, default); 'desktop' = Claude Desktop's page through its
 * Main Process Debugger (optional).
 *
 * ERROR CONVENTION — identical to register-migrate.ts: handlers throw a
 * plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { ZodError } from 'zod'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  PushAccountRequestSchema,
  PushPlanRequestSchema,
  PushPlanSchema,
  PushRunRequestSchema,
  type PushExecutor,
  type PushPlan,
  type PushPlanSummary
} from '../shared/ipc'
import { isClaudeSessionContents, openPushPage } from './claudeai-session'
import { desktopInspectorStatus, openDesktopExecutor } from './desktop-inspector'
import { BridgeError } from './devtools-bridge'
import { EngineError, type EngineService } from './engine'
import { PUSH_PLANS_DIR, PushError, pushPlan, readAccount, type PageExecutor } from './project-push'
import type { SendToRenderer } from './register-tasks'
import type { StateStore } from './state'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

function toIpcError(err: unknown): Error {
  let shape: IpcErrorShape
  if (err instanceof EngineError) {
    shape = { kind: err.kind, message: err.message, stderr: err.stderr }
  } else if (err instanceof BridgeError || err instanceof PushError) {
    shape = { kind: err.kind, message: err.message, stderr: '' }
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

function assertAppSender(event: IpcMainInvokeEvent): void {
  if (isClaudeSessionContents(event.sender)) {
    throw new BridgeError('validation', 'not allowed from a claude.ai page')
  }
}

/** True when `file` is inside `dir` (no `..`, same drive). */
export function isInsideDir(file: string, dir: string): boolean {
  // Windows paths compare without case.
  const rel = relative(resolve(dir).toLowerCase(), resolve(file).toLowerCase())
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel)
}

export function planSummary(plan: PushPlan, planFile: string): PushPlanSummary {
  return {
    planFile,
    source: plan.source,
    projects: plan.projects.map((p) => ({
      key: p.key,
      name: p.name,
      org: p.org ?? null,
      kind: p.kind,
      counts: p.counts,
      instructionsChars: p.instructions.length,
      warnings: p.warnings
    })),
    skipped: plan.skipped.map((s) => s.name ?? '').filter((n) => n !== '')
  }
}

function stamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function openExecutor(kind: PushExecutor): Promise<PageExecutor> {
  return kind === 'desktop' ? openDesktopExecutor(process.execPath) : openPushPage()
}

export interface RegisterPushOptions {
  ipcMain: IpcMain
  engine: EngineService
  state: StateStore
  sendToRenderer: SendToRenderer
}

export function registerPushHandlers(options: RegisterPushOptions): void {
  const { ipcMain, engine, state, sendToRenderer } = options
  let active: AbortController | null = null

  const plansDir = (): string => join(state.getSettings().outputDir, PUSH_PLANS_DIR)

  ipcMain.handle(INVOKE_CHANNELS.pushPlan, async (event, payload: unknown) => {
    try {
      assertAppSender(event)
      const req = PushPlanRequestSchema.parse(payload)
      const dir = plansDir()
      await mkdir(dir, { recursive: true })
      const planFile = join(dir, `plan-${stamp()}.json`)
      return planSummary(await engine.planPush(req, planFile), planFile)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.pushAccount, async (event, payload: unknown) => {
    let exec: PageExecutor | null = null
    try {
      assertAppSender(event)
      const req = PushAccountRequestSchema.parse(payload)
      exec = await openExecutor(req.executor)
      return (await readAccount(exec)).account
    } catch (err) {
      throw toIpcError(err)
    } finally {
      exec?.dispose()
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.pushDesktopStatus, async (event) => {
    try {
      assertAppSender(event)
      return await desktopInspectorStatus(process.execPath)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.pushRun, async (event, payload: unknown) => {
    let exec: PageExecutor | null = null
    const abort = new AbortController()
    try {
      assertAppSender(event)
      if (active !== null) throw new PushError('validation', 'A push is already running.')
      active = abort
      const req = PushRunRequestSchema.parse(payload)
      if (!isInsideDir(req.planFile, plansDir())) {
        throw new PushError('validation', 'The plan must be one ClaudeLift made (in the push-plans folder).')
      }
      const plan = PushPlanSchema.parse(JSON.parse(await readFile(req.planFile, 'utf8')))
      exec = await openExecutor(req.executor)
      return await pushPlan(exec, {
        plan,
        planFile: req.planFile,
        keys: req.keys,
        dryRun: req.dryRun,
        expectEmail: req.expectEmail ?? null,
        outputDir: state.getSettings().outputDir,
        signal: abort.signal,
        onProgress: (progress) => sendToRenderer(EVENT_CHANNELS.pushProgress, progress)
      })
    } catch (err) {
      throw toIpcError(err)
    } finally {
      exec?.dispose()
      if (active === abort) active = null
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.pushCancel, (event) => {
    if (isClaudeSessionContents(event.sender)) return
    active?.abort()
  })
}
