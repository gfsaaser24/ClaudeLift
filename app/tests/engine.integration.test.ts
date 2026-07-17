/**
 * Integration tests: EngineService against the REAL cowork-export sidecar
 * (app/resources/engine/cowork-export/cowork-export.exe) and this machine's
 * real Cowork task store. No engine mocking — only 'electron' is mocked
 * (EngineService imports `app` for packaged-path resolution, which the
 * exePathOverride ctor hook bypasses anyway).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { EngineError, EngineService } from '../src/main/engine'
import { CoworkTaskSchema, type ProgressEvent } from '../src/shared/ipc'

const exePath = fileURLToPath(
  new URL('../resources/engine/cowork-export/cowork-export.exe', import.meta.url)
)

const engine = new EngineService({ exePathOverride: exePath })

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('EngineService (real sidecar)', () => {
  it('listTasks("cowork") returns real tasks, each passing CoworkTaskSchema', async () => {
    const tasks = await engine.listTasks('cowork')
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      const parsed = CoworkTaskSchema.safeParse(task)
      expect(parsed.success, `task ${task.taskId} failed schema: ${parsed.success ? '' : parsed.error.message}`).toBe(true)
    }
  })

  it('exportTasks exports the most recent task (md, no files) with task_start → task_done → done', async () => {
    const tasks = await engine.listTasks('cowork')
    // most recent task that can actually export (no transcript = engine skip)
    const candidates = tasks
      .filter((t) => t.hasTranscript)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    expect(candidates.length).toBeGreaterThan(0)
    const newest = candidates[0]

    const outputDir = makeTmpDir('cowork-export-it-')
    const events: ProgressEvent[] = []
    const result = await engine.exportTasks(
      {
        taskIds: [newest.taskId],
        outputDir,
        formats: ['md'],
        noFiles: true,
        includeAuth: false,
        purgeSource: false,
        source: 'cowork'
      },
      (event) => events.push(event)
    )

    expect(result.exported).toBe(1)

    const names = events.map((e) => e.event)
    expect(names[0]).toBe('task_start')
    expect(names).toContain('task_done')
    expect(names[names.length - 1]).toBe('done')

    const start = events.find((e) => e.event === 'task_start')
    expect(start).toBeDefined()
    if (start?.event === 'task_start') {
      expect(start.task_id).toBe(newest.taskId)
      // batch-adjusted (1 of 1), not raw per-process numbering
      expect(start.index).toBe(1)
      expect(start.total).toBe(1)
    }

    const done = events[events.length - 1]
    if (done.event === 'done') {
      expect(done.exported).toBe(1)
      expect(done.total).toBe(1)
    }

    const taskDone = events.find((e) => e.event === 'task_done')
    expect(taskDone).toBeDefined()
    if (taskDone?.event === 'task_done') {
      expect(existsSync(join(taskDone.target, 'manifest.json'))).toBe(true)
      expect(existsSync(join(taskDone.target, 'session.md'))).toBe(true)
    }
  })

  it('listTasks with --cowork-root at an empty dir returns [] (engine exit 0)', async () => {
    const emptyRoot = makeTmpDir('cowork-empty-root-')
    const tasks = await engine.listTasks('cowork', emptyRoot)
    expect(tasks).toEqual([])
  })

  it('exportTasks on a bogus id rejects with EngineError kind "none"', async () => {
    const outputDir = makeTmpDir('cowork-export-bogus-')
    const promise = engine.exportTasks(
      {
        taskIds: ['ffffffff-ffff-ffff-ffff-ffffffffffff'],
        outputDir,
        formats: ['md'],
        noFiles: true,
        includeAuth: false,
        purgeSource: false,
        source: 'cowork'
      },
      () => {}
    )
    await expect(promise).rejects.toBeInstanceOf(EngineError)
    await expect(promise).rejects.toMatchObject({ kind: 'none', code: 1 })
  })
})
