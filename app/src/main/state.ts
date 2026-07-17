/**
 * StateStore + SecretStore (Task 6).
 *
 * Persistent app state via electron-store (file name `claudelift`,
 * seeded with `schemaVersion: 1`) plus DPAPI-backed secret storage for
 * the Notion token via Electron's safeStorage (base64 ciphertext in the
 * store key `notionTokenEnc` — never plaintext).
 *
 * `mergeSettings` / `defaultSettings` are pure (no Electron access) so
 * they stay unit-testable outside the Electron runtime — see
 * `app/tests/state.unit.test.ts`.
 */
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import Store from 'electron-store'
import { z } from 'zod'
import {
  AppSettingsSchema,
  AppSettingsPatchSchema,
  NotionConfigSchema,
  NotionExportStateSchema
} from '../shared/ipc'
import type {
  AppSettings,
  AppSettingsPatch,
  NotionConfig,
  NotionExportState
} from '../shared/ipc'

// ---------------------------------------------------------------------------
// Window bounds (main-process only — never crosses IPC, so lives here)
// ---------------------------------------------------------------------------

export const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

export type WindowBounds = z.infer<typeof WindowBoundsSchema>

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without the Electron runtime)
// ---------------------------------------------------------------------------

/** Built-in defaults; `documentsDir` is injected so this stays pure. */
export function defaultSettings(documentsDir: string): AppSettings {
  return {
    minimizeToTray: true,
    closeToTray: false,
    startMinimized: false,
    watcherEnabled: true,
    outputDir: join(documentsDir, 'CoworkExports'),
    formats: ['html', 'md', 'json', 'csv'],
    source: 'cowork',
    coworkRootOverride: null,
    bundleViewMode: 'card'
  }
}

/**
 * `settings:set` semantics: shallow-merge `patch` over `current`,
 * zod-validate the merged result with AppSettingsSchema, return it.
 * Throws ZodError on an invalid patch (nothing is persisted by callers
 * in that case). Explicit `undefined` values in the patch are dropped
 * so they cannot clobber existing settings; explicit `null` is kept
 * (it is the valid "reset to auto" value for `coworkRootOverride`).
 */
export function mergeSettings(current: AppSettings, patch: unknown): AppSettings {
  const parsedPatch = AppSettingsPatchSchema.parse(patch)
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsedPatch)) {
    if (value !== undefined) cleaned[key] = value
  }
  return AppSettingsSchema.parse({ ...current, ...cleaned })
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1

const NotionJournalSchema = z.record(z.string(), NotionExportStateSchema)

export type NotionJournal = z.infer<typeof NotionJournalSchema>

type StoreShape = {
  schemaVersion: number
  settings?: AppSettings
  windowBounds?: WindowBounds
  notionConfig?: NotionConfig
  notionTokenEnc?: string
  notionJournal?: NotionJournal
  flags?: Record<string, boolean>
}

const EMPTY_NOTION_CONFIG: NotionConfig = {
  parentPageId: null,
  databaseId: null,
  dataSourceId: null,
  workspaceName: null,
  maxUploadBytes: null
}

const ENCRYPTION_UNAVAILABLE =
  'OS-level encryption is unavailable (safeStorage.isEncryptionAvailable() ' +
  'returned false — Windows DPAPI not ready). The Notion token is only ever ' +
  'stored encrypted, never as plaintext, so it cannot be saved or read right now.'

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private readonly store: Store<StoreShape>

  constructor() {
    this.store = new Store<StoreShape>({
      name: 'claudelift',
      defaults: { schemaVersion: SCHEMA_VERSION }
    })
  }

  // -- settings -------------------------------------------------------------

  /** Stored settings merged over defaults; corrupt data falls back to defaults. */
  getSettings(): AppSettings {
    const defaults = defaultSettings(app.getPath('documents'))
    const stored = AppSettingsPatchSchema.safeParse(this.store.get('settings'))
    return mergeSettings(defaults, stored.success ? stored.data : {})
  }

  /** Shallow-merge + validate + persist; returns the merged settings. */
  setSettings(patch: AppSettingsPatch): AppSettings {
    const merged = mergeSettings(this.getSettings(), patch)
    this.store.set('settings', merged)
    return merged
  }

  // -- window bounds ----------------------------------------------------------

  getWindowBounds(): WindowBounds | null {
    const stored = WindowBoundsSchema.safeParse(this.store.get('windowBounds'))
    return stored.success ? stored.data : null
  }

  saveWindowBounds(bounds: WindowBounds | null): void {
    if (bounds === null) {
      this.store.delete('windowBounds')
    } else {
      this.store.set('windowBounds', WindowBoundsSchema.parse(bounds))
    }
  }

  // -- Notion config ----------------------------------------------------------

  getNotionConfig(): NotionConfig {
    const stored = NotionConfigSchema.safeParse(this.store.get('notionConfig'))
    return stored.success ? stored.data : { ...EMPTY_NOTION_CONFIG }
  }

  setNotionConfig(config: NotionConfig): void {
    this.store.set('notionConfig', NotionConfigSchema.parse(config))
  }

  // -- Notion token (SecretStore) ---------------------------------------------

  /**
   * Decrypts and returns the stored Notion token, or null when none is
   * stored. Throws when a token exists but OS encryption is unavailable.
   * A ciphertext that no longer decrypts (e.g. OS profile changed) is
   * dropped and treated as "no token".
   */
  getNotionToken(): string | null {
    const enc = this.store.get('notionTokenEnc')
    if (enc === undefined) return null
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(ENCRYPTION_UNAVAILABLE)
    }
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      this.store.delete('notionTokenEnc')
      return null
    }
  }

  /**
   * Encrypts and stores the token (base64 ciphertext in `notionTokenEnc`);
   * `null` clears it. Throws — and stores nothing — when OS encryption is
   * unavailable: the token is never persisted as plaintext.
   */
  setNotionToken(token: string | null): void {
    if (token === null) {
      this.store.delete('notionTokenEnc')
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(ENCRYPTION_UNAVAILABLE)
    }
    this.store.set('notionTokenEnc', safeStorage.encryptString(token).toString('base64'))
  }

  // -- Notion export journal (resume support for the exporter) -----------------

  getNotionJournal(): NotionJournal {
    const stored = NotionJournalSchema.safeParse(this.store.get('notionJournal'))
    return stored.success ? stored.data : {}
  }

  patchNotionJournal(taskId: string, state: NotionExportState): void {
    const journal = this.getNotionJournal()
    journal[taskId] = NotionExportStateSchema.parse(state)
    this.store.set('notionJournal', journal)
  }

  clearNotionJournal(): void {
    this.store.delete('notionJournal')
  }

  // -- one-time flags (e.g. 'trayHintShown') ------------------------------------

  getFlag(name: string): boolean {
    const flags = this.store.get('flags')
    return flags?.[name] === true
  }

  setFlag(name: string): void {
    const flags = { ...(this.store.get('flags') ?? {}) }
    flags[name] = true
    this.store.set('flags', flags)
  }

  // -- danger zone ---------------------------------------------------------------

  /** Clears everything, then re-seeds `schemaVersion`. */
  clearAll(): void {
    this.store.clear()
    this.store.set('schemaVersion', SCHEMA_VERSION)
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let instance: StateStore | null = null

export function getStateStore(): StateStore {
  if (instance === null) {
    instance = new StateStore()
  }
  return instance
}
