/**
 * Integration test for WatcherService — REAL filesystem, real chokidar,
 * no mocking. Recreates the on-disk Cowork layout in a tmpdir:
 *
 *   <tmp>/<account-uuid>/<workspace-uuid>/local_<task-uuid>.json
 *
 * and drives the watcher with `rootsOverride: [<tmp>]`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WatcherService } from '../src/main/watcher'

const TEST_TIMEOUT_MS = 15_000

// Real 36-char uuids (8-4-4-4-12).
const ACCOUNT_UUID = '11111111-2222-4333-8444-555555555555'
const WORKSPACE_UUID = '99999999-8888-4777-8666-000000000000'
const TASK_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred() && Date.now() < deadline) {
    await sleep(50)
  }
}

interface Fixture {
  root: string
  wsDir: string
  svc: WatcherService
  dirtyCount: () => number
}

let cleanups: Array<() => Promise<void>> = []

async function startFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'cowork-watcher-'))
  const wsDir = join(root, ACCOUNT_UUID, WORKSPACE_UUID)
  mkdirSync(wsDir, { recursive: true })

  const svc = new WatcherService()
  let count = 0
  svc.onDirty(() => {
    count += 1
  })
  svc.start([root])
  // Let chokidar finish its initial scan so ignoreInitial can't swallow
  // the writes the test is about to make.
  await sleep(400)

  cleanups.push(async () => {
    await svc.stop()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  return { root, wsDir, svc, dirtyCount: () => count }
}

afterEach(async () => {
  for (const cleanup of cleanups) {
    await cleanup()
  }
  cleanups = []
})

describe('WatcherService (real fs)', () => {
  it(
    'emits exactly one dirty when a task metadata file is written',
    async () => {
      const f = await startFixture()

      writeFileSync(
        join(f.wsDir, `local_${TASK_UUID}.json`),
        JSON.stringify({ title: 'hello' })
      )

      await waitFor(() => f.dirtyCount() >= 1, 2000)
      expect(f.dirtyCount()).toBe(1)

      // No trailing extra emits after the debounce window has passed.
      await sleep(700)
      expect(f.dirtyCount()).toBe(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'ignores files that do not match local_<uuid>.json',
    async () => {
      const f = await startFixture()

      writeFileSync(join(f.wsDir, 'notes.txt'), 'not a task file')

      await sleep(1500)
      expect(f.dirtyCount()).toBe(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'debounces two rapid writes to the same file into a single dirty',
    async () => {
      const f = await startFixture()
      const file = join(f.wsDir, `local_${TASK_UUID}.json`)

      writeFileSync(file, JSON.stringify({ rev: 1 }))
      writeFileSync(file, JSON.stringify({ rev: 2 }))

      await waitFor(() => f.dirtyCount() >= 1, 2000)
      // Give any straggler events time to (incorrectly) fire.
      await sleep(800)
      expect(f.dirtyCount()).toBe(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'stop() resolves, deactivates the watcher, and is idempotent',
    async () => {
      const f = await startFixture()

      expect(f.svc.state()).toEqual({ active: true, roots: [f.root] })

      await f.svc.stop()
      expect(f.svc.state().active).toBe(false)

      // Second stop still resolves (idempotent).
      await f.svc.stop()

      // No dirty emits after stop.
      writeFileSync(
        join(f.wsDir, `local_${TASK_UUID}.json`),
        JSON.stringify({ title: 'after stop' })
      )
      await sleep(1200)
      expect(f.dirtyCount()).toBe(0)
    },
    TEST_TIMEOUT_MS
  )
})
