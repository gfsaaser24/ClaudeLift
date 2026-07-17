/**
 * Unit tests for the pure state helpers (Task 6).
 *
 * `electron` and `electron-store` are mocked: the real modules need the
 * Electron runtime, and these tests exercise the pure merge/validate
 * helpers (plus StateStore behavior that the mocks can back faithfully).
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => join('C:', 'MockHome', 'Documents'))
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()

    constructor(options?: { defaults?: Record<string, unknown> }) {
      for (const [key, value] of Object.entries(options?.defaults ?? {})) {
        this.data.set(key, value)
      }
    }

    get(key: string): unknown {
      return this.data.get(key)
    }

    set(key: string, value: unknown): void {
      this.data.set(key, value)
    }

    delete(key: string): void {
      this.data.delete(key)
    }

    clear(): void {
      this.data.clear()
    }
  }
}))

import { StateStore, defaultSettings, mergeSettings } from '../src/main/state'

const DOCS = join('C:', 'MockHome', 'Documents')

describe('defaultSettings', () => {
  it('fills every default from the plan', () => {
    expect(defaultSettings(DOCS)).toEqual({
      minimizeToTray: true,
      closeToTray: false,
      startMinimized: false,
      watcherEnabled: true,
      outputDir: join(DOCS, 'CoworkExports'),
      formats: ['html', 'md', 'json', 'csv'],
      source: 'cowork',
      coworkRootOverride: null,
      bundleViewMode: 'card'
    })
  })
})

describe('mergeSettings', () => {
  const defaults = defaultSettings(DOCS)

  it('empty patch returns the defaults unchanged (defaults fill)', () => {
    expect(mergeSettings(defaults, {})).toEqual(defaults)
  })

  it('shallow-merges only the patched keys', () => {
    const merged = mergeSettings(defaults, { closeToTray: true, formats: ['md'] })
    expect(merged.closeToTray).toBe(true)
    expect(merged.formats).toEqual(['md'])
    // untouched keys keep their defaults
    expect(merged.minimizeToTray).toBe(true)
    expect(merged.outputDir).toBe(join(DOCS, 'CoworkExports'))
  })

  it('drops explicit undefined values instead of clobbering', () => {
    const merged = mergeSettings(defaults, { outputDir: undefined })
    expect(merged.outputDir).toBe(join(DOCS, 'CoworkExports'))
  })

  it('rejects an invalid enum value', () => {
    expect(() => mergeSettings(defaults, { source: 'bogus' })).toThrow()
  })

  it('rejects a wrongly-typed value', () => {
    expect(() => mergeSettings(defaults, { formats: 'md' })).toThrow()
    expect(() => mergeSettings(defaults, { minimizeToTray: 'yes' })).toThrow()
  })

  it('rejects a non-object patch', () => {
    expect(() => mergeSettings(defaults, 'nope')).toThrow()
  })

  it('null coworkRootOverride roundtrip', () => {
    const custom = mergeSettings(defaults, {
      coworkRootOverride: join('C:', 'CustomRoot')
    })
    expect(custom.coworkRootOverride).toBe(join('C:', 'CustomRoot'))

    // null is a VALID value (reset to auto) and must survive the merge,
    // unlike undefined which is dropped.
    const reset = mergeSettings(custom, { coworkRootOverride: null })
    expect(reset.coworkRootOverride).toBeNull()
  })
})

describe('StateStore (mock-backed)', () => {
  it('getSettings returns defaults on a fresh store; setSettings persists the merge', () => {
    const store = new StateStore()
    expect(store.getSettings()).toEqual(defaultSettings(DOCS))

    const merged = store.setSettings({ watcherEnabled: false })
    expect(merged.watcherEnabled).toBe(false)
    expect(store.getSettings()).toEqual(merged)
  })

  it('one-time flags default false and stick once set', () => {
    const store = new StateStore()
    expect(store.getFlag('trayHintShown')).toBe(false)
    store.setFlag('trayHintShown')
    expect(store.getFlag('trayHintShown')).toBe(true)
  })

  it('never stores a plaintext token: setNotionToken throws when encryption is unavailable, null clears', () => {
    const store = new StateStore()
    expect(() => store.setNotionToken('ntn_secret')).toThrow(/never/i)
    expect(store.getNotionToken()).toBeNull()
    expect(() => store.setNotionToken(null)).not.toThrow()
  })

  it('clearAll wipes state and re-seeds schemaVersion', () => {
    const store = new StateStore()
    store.setSettings({ closeToTray: true })
    store.setFlag('trayHintShown')
    store.clearAll()
    expect(store.getSettings()).toEqual(defaultSettings(DOCS))
    expect(store.getFlag('trayHintShown')).toBe(false)
  })
})
