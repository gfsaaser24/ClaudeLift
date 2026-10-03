import { describe, expect, it } from 'vitest'
import { parseCachedAccounts } from '../src/main/workspaces'

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
