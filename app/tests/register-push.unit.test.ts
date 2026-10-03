import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => 'C:\\MockHome') },
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() }
}))

import { isInsideDir, planSummary } from '../src/main/register-push'
import { PushPlanSchema } from '../src/shared/ipc'

describe('isInsideDir', () => {
  const dir = resolve('C:\\out\\ClaudeLift')

  it('is true for files and nested files inside the dir', () => {
    expect(isInsideDir(join(dir, 'push-plans', 'a.json'), dir)).toBe(true)
    expect(isInsideDir(join(dir, 'a.json'), dir)).toBe(true)
  })

  it('is false for the dir itself', () => {
    expect(isInsideDir(dir, dir)).toBe(false)
  })

  it('is false for a .. escape', () => {
    expect(isInsideDir(join(dir, '..', 'other.json'), dir)).toBe(false)
    expect(isInsideDir(join(dir, 'push-plans', '..', '..', 'x.json'), dir)).toBe(false)
    expect(isInsideDir(resolve(dir, '..'), dir)).toBe(false)
  })

  it('is false for a sibling that shares the name prefix', () => {
    expect(isInsideDir(`${dir}-evil${process.platform === 'win32' ? '\\' : '/'}a.json`, dir)).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('is false on another drive', () => {
    expect(isInsideDir('D:\\out\\ClaudeLift\\a.json', 'C:\\out\\ClaudeLift')).toBe(false)
  })
})

describe('planSummary', () => {
  const plan = PushPlanSchema.parse({
    plan_version: 1,
    source: 'C:\\conv',
    projects: [
      {
        key: 'k1',
        name: 'One',
        org: 'Acme',
        kind: 'claude-project',
        instructions: 'hello there',
        library: [{ path: '/a.md', file: 'C:\\f\\a.md', size: 3, mime: 'text/markdown' }],
        memory: [{ path: '/m.md', content: 'SECRET NOTE' }],
        counts: { docs: 1, files: 0 },
        warnings: ['w1']
      },
      { key: 'k2', name: 'Two', kind: 'chat-history', library: [], memory: [], counts: {} }
    ],
    skipped: [{ name: 'Skipped A' }, { name: null }, {}, { name: '' }, { name: 'Skipped B' }]
  })

  it('summarises projects without file paths or memory text', () => {
    const s = planSummary(plan, 'C:\\plans\\p.json')
    expect(s.planFile).toBe('C:\\plans\\p.json')
    expect(s.source).toBe('C:\\conv')
    expect(s.projects).toHaveLength(2)
    expect(s.projects[0]).toMatchObject({ key: 'k1', name: 'One', org: 'Acme', kind: 'claude-project', instructionsChars: 11, warnings: ['w1'] })
    expect(s.projects[0].counts.docs).toBe(1)
    expect(s.projects[1]).toMatchObject({ key: 'k2', org: null, instructionsChars: 0, warnings: [] })
    expect(JSON.stringify(s)).not.toContain('SECRET NOTE')
    expect(JSON.stringify(s)).not.toContain('a.md')
  })

  it('lists only non-empty skipped names', () => {
    expect(planSummary(plan, 'p').skipped).toEqual(['Skipped A', 'Skipped B'])
  })
})
