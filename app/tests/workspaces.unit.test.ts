import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coalesceWorkspaces, listWorkspaces, parseCachedAccounts } from '../src/main/workspaces'

/** One-byte V8 string as the claude.ai IndexedDB cache stores it. */
const str = (s: string): string => `"${String.fromCharCode(s.length)}${s}`

describe('parseCachedAccounts', () => {
  const acct = '5bf3f70f-a50b-4d20-b413-dc90b7a9cfca'
  const org = 'c7958373-168b-4bb6-865a-a3ac5b60c76d'

  it('reads uuid, email, name and membership orgs of the cached account', () => {
    const blob =
      '\xff\x11o' +
      str('account') + 'o' + str('uuid') + str(acct) + str('email_address') + str('new@example.com') +
      str('full_name') + str('Sam') + str('memberships') + 'Ao' + str('organization') + 'o' + str('uuid') + str(org)
    const out = parseCachedAccounts(Buffer.from(blob, 'latin1'))
    expect(out.get(acct)).toEqual({ email: 'new@example.com', fullName: 'Sam', orgIds: expect.arrayContaining([org]) })
  })

  it('ignores data without an account record', () => {
    expect(parseCachedAccounts(Buffer.from('"\x04uuid"\x24nothing-here', 'latin1')).size).toBe(0)
  })
})

describe('listWorkspaces across MSIX roots', () => {
  const acct = '11111111-2222-4333-8444-555555555555'
  const org = '66666666-7777-4888-9999-aaaaaaaaaaaa'
  const otherAcct = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  const otherOrg = '00000000-1111-4222-8333-444444444444'
  let tmp = ''

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claudelift-ws-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('merges the same account/org found under both roots into one entry', async () => {
    const mirror = join(tmp, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions')
    const store = join(
      tmp, 'AppData', 'Local', 'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions'
    )
    // Same workspace in both roots; only the mirror copy has a task file.
    await mkdir(join(mirror, acct, org), { recursive: true })
    await mkdir(join(store, acct, org), { recursive: true })
    await writeFile(
      join(mirror, acct, org, 'local_x.json'),
      JSON.stringify({ emailAddress: 'me@example.com', accountName: 'Me' })
    )
    // The store's config says this account is signed in now.
    await writeFile(join(dirname(store), 'config.json'), JSON.stringify({ lastKnownAccountUuid: acct }))
    // A different workspace, only in the mirror, with a newer task.
    await mkdir(join(mirror, otherAcct, otherOrg), { recursive: true })
    await writeFile(join(mirror, otherAcct, otherOrg, 'local_y.json'), JSON.stringify({ emailAddress: 'o@example.com' }))

    const out = await listWorkspaces([mirror, store])

    expect(out).toHaveLength(2)
    const merged = out[0]
    expect(merged).toMatchObject({
      accountId: acct,
      orgId: org,
      root: store,
      path: join(store, acct, org),
      email: 'me@example.com',
      accountName: 'Me',
      taskCount: 1,
      signedInNow: true,
      leftover: false
    })
    expect(out[1]).toMatchObject({ accountId: otherAcct, path: join(mirror, otherAcct, otherOrg), signedInNow: false })
  })
})

describe('coalesceWorkspaces', () => {
  const base = {
    accountId: 'A',
    orgId: 'O',
    email: null,
    accountName: null,
    taskCount: 0,
    lastActivityMs: 0,
    signedInNow: false,
    leftover: false
  }

  it('prefers the LocalCache path and takes the newest activity and largest count', () => {
    const out = coalesceWorkspaces([
      { ...base, root: 'C:\LocalCache\r', path: 'C:\LocalCache\r\A\O', lastActivityMs: 5, leftover: true },
      { ...base, root: 'C:\Roaming\r', path: 'C:\Roaming\r\A\O', taskCount: 3, lastActivityMs: 9, email: 'e@x.io' }
    ])
    expect(out).toEqual([
      {
        ...base,
        root: 'C:\LocalCache\r',
        path: 'C:\LocalCache\r\A\O',
        taskCount: 3,
        lastActivityMs: 9,
        email: 'e@x.io',
        leftover: true
      }
    ])
  })
})
