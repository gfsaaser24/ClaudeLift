/**
 * ipcMain.handle registrations for the filesystem-backed bundle channels
 * (Task 12): bundles:scan, bundles:readMarkdown, bundles:openFolder.
 * (bundles:import / bundles:seed are engine-backed and live in
 * register-tasks.ts.)
 *
 * bundles:scan takes no arguments — it always scans the persisted
 * settings.outputDir, read fresh from the StateStore on every call so a
 * Settings-page change is picked up without a restart.
 *
 * ERROR CONVENTION — identical to register-tasks.ts (its `toIpcError` is
 * module-private, so the tiny serializer is mirrored here): handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 */
import type { IpcMain, Shell } from 'electron'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ZodError } from 'zod'
import {
  INVOKE_CHANNELS,
  OpenFolderRequestSchema,
  ReadMarkdownRequestSchema
} from '../shared/ipc'
import { readBundleMarkdown, scanBundles } from './bundles'
import type { StateStore } from './state'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

/** Handler-level request rejection — maps to kind 'validation', not 'crash'. */
class ValidationError extends Error {}

/** Serialize any thrown value into the plain-Error-with-JSON-message shape. */
function toIpcError(err: unknown): Error {
  let shape: IpcErrorShape
  if (err instanceof ZodError) {
    const detail = err.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    shape = { kind: 'validation', message: `invalid request payload — ${detail}`, stderr: '' }
  } else if (err instanceof ValidationError) {
    shape = { kind: 'validation', message: err.message, stderr: '' }
  } else {
    shape = { kind: 'crash', message: err instanceof Error ? err.message : String(err), stderr: '' }
  }
  return new Error(JSON.stringify(shape))
}

/** True when `path` is an existing regular file (never throws). */
function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export interface RegisterBundleOptions {
  ipcMain: IpcMain
  shell: Shell
  getState: () => StateStore
}

export function registerBundleHandlers(options: RegisterBundleOptions): void {
  const { ipcMain, shell, getState } = options

  ipcMain.handle(INVOKE_CHANNELS.bundlesScan, async () => {
    try {
      return await scanBundles(getState().getSettings().outputDir)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.bundlesReadMarkdown, async (_event, payload: unknown) => {
    try {
      const req = ReadMarkdownRequestSchema.parse(payload)
      return await readBundleMarkdown(req.bundleDir)
    } catch (err) {
      throw toIpcError(err)
    }
  })

  // Same normalize + require-manifest.json containment as readBundleMarkdown:
  // only a real bundle directory — or the configured output root itself,
  // which the UI opens directly — may reach shell.openPath. Files are
  // rejected outright so this channel can never launch one.
  ipcMain.handle(INVOKE_CHANNELS.bundlesOpenFolder, async (_event, payload: unknown) => {
    try {
      const req = OpenFolderRequestSchema.parse(payload)
      const dir = resolve(req.dir)
      let isDirectory: boolean
      try {
        isDirectory = statSync(dir).isDirectory()
      } catch {
        throw new ValidationError(`folder does not exist: ${dir}`)
      }
      if (!isDirectory) {
        throw new ValidationError(`not a folder: ${dir}`)
      }
      const isBundleDir = isFileSync(join(dir, 'manifest.json'))
      const isOutputRoot =
        dir.toLowerCase() === resolve(getState().getSettings().outputDir).toLowerCase()
      if (!isBundleDir && !isOutputRoot) {
        throw new ValidationError(`not a bundle directory (missing manifest.json): ${dir}`)
      }
      const failure = await shell.openPath(dir)
      if (failure !== '') {
        throw new Error(`could not open folder: ${failure}`)
      }
    } catch (err) {
      throw toIpcError(err)
    }
  })
}
