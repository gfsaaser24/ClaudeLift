import { describe, expect, it } from 'vitest'
import { coalesceWorkspaces, isNewLayout } from '../src/main/workspaces'

describe('isNewLayout', () => {
  it('is true only with remote-session-spaces.json, no spaces.json and no tasks', () => {
    expect(isNewLayout({ spacesJson: false, remoteSessionSpaces: true, taskCount: 0 })).toBe(true)
  })

  it('is false when any old-layout marker is present', () => {
    expect(isNewLayout({ spacesJson: true, remoteSessionSpaces: true, taskCount: 0 })).toBe(false)
    expect(isNewLayout({ spacesJson: false, remoteSessionSpaces: true, taskCount: 2 })).toBe(false)
  })

  it('is false without the remote-session-spaces marker', () => {
    expect(isNewLayout({ spacesJson: false, remoteSessionSpaces: false, taskCount: 0 })).toBe(false)
    expect(isNewLayout({ spacesJson: true, remoteSessionSpaces: false, taskCount: 3 })).toBe(false)
  })
})

describe('coalesceWorkspaces newLayout merge', () => {
  const base = {
    accountId: 'A',
    orgId: 'O',
    email: null,
    accountName: null,
    taskCount: 0,
    lastActivityMs: 0,
    signedInNow: false,
    leftover: false,
    newLayout: false
  }
  const mirror = { ...base, root: 'C:\\Roaming\\r', path: 'C:\\Roaming\\r\\A\\O' }
  const store = { ...base, root: 'C:\\x\\LocalCache\\Roaming\\r', path: 'C:\\x\\LocalCache\\Roaming\\r\\A\\O' }

  it('is new layout when either copy is and no copy has tasks', () => {
    expect(coalesceWorkspaces([{ ...mirror, newLayout: true }, store])[0].newLayout).toBe(true)
    expect(coalesceWorkspaces([mirror, { ...store, newLayout: true }])[0].newLayout).toBe(true)
    expect(coalesceWorkspaces([{ ...mirror, newLayout: true }, { ...store, newLayout: true }])[0].newLayout).toBe(true)
  })

  it('is not new layout when neither copy is', () => {
    expect(coalesceWorkspaces([mirror, store])[0].newLayout).toBe(false)
  })

  it('is not new layout when the other copy has tasks', () => {
    const out = coalesceWorkspaces([{ ...mirror, newLayout: true }, { ...store, taskCount: 4 }])
    expect(out).toHaveLength(1)
    expect(out[0].taskCount).toBe(4)
    expect(out[0].newLayout).toBe(false)
  })

  it('keeps the LocalCache path and leaves other accounts alone', () => {
    const other = { ...mirror, accountId: 'B', newLayout: true }
    const out = coalesceWorkspaces([{ ...mirror, newLayout: true }, other, store])
    expect(out).toHaveLength(2)
    expect(out[0].path).toBe(store.path)
    expect(out[0].newLayout).toBe(true)
    expect(out[1]).toEqual(other)
  })

  it('merges keys case-insensitively', () => {
    const out = coalesceWorkspaces([{ ...mirror, newLayout: true }, { ...store, accountId: 'a', orgId: 'o' }])
    expect(out).toHaveLength(1)
    expect(out[0].newLayout).toBe(true)
  })
})
