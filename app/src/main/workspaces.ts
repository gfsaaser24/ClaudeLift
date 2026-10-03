/**
 * Enumerate the Cowork workspaces on this machine for the Migrate view's
 * target picker.
 *
 * On-disk layout (same as the engine's `_workspace_leaves`):
 * `<root>/<account-uuid>/<org-uuid>/local_<task-uuid>.json`, with the
 * Dispatch agent session(s) under `<org>/agent/local_*.json`. A
 * `skills-plugin` dir at either level is not an account/workspace.
 *
 * Each workspace reports its task count and the account email recorded on
 * its tasks (`emailAddress` / `accountName` in any `local_*.json`), so the
 * user can tell which signed-in account it belongs to. No settings reads —
 * the caller passes the roots.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkspaceInfo } from '../shared/ipc'

/** Task metadata files: `local_<id>.json` (case-insensitive). */
const TASK_META_RE = /^local_.+\.json$/i

/** Never treated as an account or workspace dir (mirrors the engine). */
const NOT_A_WORKSPACE = 'skills-plugin'

/** Max task files read per workspace while looking for the email. */
const IDENTITY_PROBE_LIMIT = 50

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && e.name !== NOT_A_WORKSPACE)
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function taskMetaFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && TASK_META_RE.test(e.name)).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** Node keeps a leading BOM on utf8 reads; JSON.parse rejects it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function readIdentity(file: string): Promise<{ email: string; accountName: string | null } | null> {
  try {
    const parsed: unknown = JSON.parse(stripBom(await readFile(file, 'utf8')))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const email = record.emailAddress
    if (typeof email !== 'string' || email === '') return null
    const name = record.accountName
    return { email, accountName: typeof name === 'string' && name !== '' ? name : null }
  } catch {
    return null
  }
}

/**
 * The account Claude Desktop is signed in to right now: `lastKnownAccountUuid`
 * in `config.json` next to `local-agent-mode-sessions`. A freshly signed-in
 * account has an empty workspace (no tasks → no email to show), so this is how
 * the picker can still point at it.
 */
async function signedInAccount(root: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(stripBom(await readFile(join(dirname(root), 'config.json'), 'utf8')))
    const id = (parsed as Record<string, unknown> | null)?.lastKnownAccountUuid
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

export interface CachedAccount {
  email: string
  fullName: string | null
  /** Org uuids this account belongs to (from its memberships). */
  orgIds: string[]
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Accounts the claude.ai page inside Claude Desktop has cached in its
 * IndexedDB (the persisted query cache holds the signed-in `account` object:
 * uuid, email_address, full_name, memberships[].organization.uuid). The data
 * is V8-serialized; one-byte strings are `"` + length byte + bytes, which is
 * what the pattern reads. Pure, for tests: takes the raw file bytes.
 */
export function parseCachedAccounts(bytes: Buffer): Map<string, CachedAccount> {
  const out = new Map<string, CachedAccount>()
  const text = bytes.toString('latin1')
  const re = new RegExp(`"\\x04uuid"\\x24(${UUID})"\\x0demail_address"([\\x01-\\x7f])`, 'g')
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const len = m[2].charCodeAt(0)
    const start = m.index + m[0].length
    const email = text.slice(start, start + len)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue
    // full_name follows email_address in the same object.
    const rest = text.slice(start + len, start + len + 600)
    const nm = /"\x09full_name"([\x01-\x7f])/.exec(rest)
    const fullName = nm !== null ? rest.slice(nm.index + nm[0].length, nm.index + nm[0].length + nm[1].charCodeAt(0)) : null
    // Org uuids listed under this account's memberships (before the next account object).
    const tail = text.slice(start, start + 20000)
    const nextAccount = tail.indexOf('email_address', len + 1)
    const scope = nextAccount > 0 ? tail.slice(0, nextAccount) : tail
    const orgIds = [...new Set([...scope.matchAll(new RegExp(UUID, 'g'))].map((x) => x[0]))]
    const prev = out.get(m[1])
    out.set(m[1], {
      email,
      fullName: fullName ?? prev?.fullName ?? null,
      orgIds: [...new Set([...(prev?.orgIds ?? []), ...orgIds])]
    })
  }
  return out
}

/** Read every claude.ai IndexedDB blob in Claude Desktop's user-data dir. */
async function cachedAccounts(userData: string): Promise<Map<string, CachedAccount>> {
  const merged = new Map<string, CachedAccount>()
  const base = join(userData, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob')
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p, depth + 1)
      } else if (e.isFile()) {
        try {
          if ((await stat(p)).size > 32 * 1024 * 1024) continue
          for (const [id, acct] of parseCachedAccounts(await readFile(p))) {
            const prev = merged.get(id)
            merged.set(id, prev ? { ...acct, orgIds: [...new Set([...prev.orgIds, ...acct.orgIds])] } : acct)
          }
        } catch {
          // unreadable blob: skip
        }
      }
    }
  }
  await walk(base, 0)
  return merged
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/**
 * New layout (projects and threads in the cloud): Claude Desktop keeps only
 * `remote-session-spaces.json` (and rpm/, scheduled tasks) here — no
 * `spaces.json` and no Cowork task files. Writing spaces or tasks into such
 * a folder does not create projects; the work must go through claude.ai
 * (Migrate card D). See docs/NEW-LAYOUT-SPEC.md.
 */
export function isNewLayout(markers: { spacesJson: boolean; remoteSessionSpaces: boolean; taskCount: number }): boolean {
  return !markers.spacesJson && markers.taskCount === 0 && markers.remoteSessionSpaces
}

async function describeWorkspace(
  root: string,
  accountId: string,
  orgId: string,
  currentAccount: string | null,
  accounts: Map<string, CachedAccount>
): Promise<WorkspaceInfo> {
  const path = join(root, accountId, orgId)
  const files = [...(await taskMetaFiles(path)), ...(await taskMetaFiles(join(path, 'agent')))]

  const withMtime = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, mtimeMs: (await stat(file)).mtimeMs }
      } catch {
        return { file, mtimeMs: 0 }
      }
    })
  )
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs) // newest first

  let identity: { email: string; accountName: string | null } | null = null
  for (const { file } of withMtime.slice(0, IDENTITY_PROBE_LIMIT)) {
    identity = await readIdentity(file)
    if (identity !== null) break
  }

  // No tasks yet (a freshly signed-in account): fall back to the account the
  // claude.ai page cached. An org that is not among that account's
  // memberships is a leftover folder from switching accounts.
  const cached = accounts.get(accountId)
  const orgKnown = cached !== undefined && cached.orgIds.length > 0
  // An empty folder whose org belongs to another (cached) account.
  const orgOwnedElsewhere =
    files.length === 0 &&
    !(cached?.orgIds.includes(orgId) ?? false) &&
    [...accounts.entries()].some(([id, a]) => id !== accountId && a.orgIds.includes(orgId))
  return {
    path,
    root,
    accountId,
    orgId,
    email: identity?.email ?? cached?.email ?? null,
    accountName: identity?.accountName ?? cached?.fullName ?? null,
    leftover: (orgKnown && !cached.orgIds.includes(orgId)) || orgOwnedElsewhere,
    taskCount: files.length,
    lastActivityMs: withMtime[0]?.mtimeMs ?? (await stat(path).then((st) => st.mtimeMs).catch(() => 0)),
    signedInNow: currentAccount !== null && accountId === currentAccount,
    newLayout: isNewLayout({
      spacesJson: await exists(join(path, 'spaces.json')),
      remoteSessionSpaces: await exists(join(path, 'remote-session-spaces.json')),
      taskCount: files.length
    })
  }
}

/** Every `<root>/<account>/<org>` workspace under the given Cowork roots. */
export async function listWorkspaces(roots: string[]): Promise<WorkspaceInfo[]> {
  const out: WorkspaceInfo[] = []
  for (const root of roots) {
    const current = await signedInAccount(root)
    const accounts = await cachedAccounts(dirname(root))
    for (const accountId of await subdirs(root)) {
      for (const orgId of await subdirs(join(root, accountId))) {
        out.push(await describeWorkspace(root, accountId, orgId, current, accounts))
      }
    }
  }
  // The account signed in to Claude Desktop now first, leftover folders last.
  const rank = (w: WorkspaceInfo): number => (w.leftover ? 2 : w.signedInNow ? 0 : 1)
  return coalesceWorkspaces(out).sort((a, b) => rank(a) - rank(b) || b.lastActivityMs - a.lastActivityMs)
}

/** The MSIX package store (`...\LocalCache\Roaming\Claude\...`), the real
 *  copy behind the `%APPDATA%\Claude` mirror. */
function isLocalCacheRoot(root: string): boolean {
  return /[\\/]LocalCache[\\/]/i.test(root)
}

/**
 * One entry per account/org. With an MSIX install both the `%APPDATA%` mirror
 * and the `LocalCache` store can exist, so the same workspace shows up under
 * two roots. Merge them: the `LocalCache` path wins (writes go there), counts
 * and activity take the max, identity comes from whichever copy has it, and
 * the flags are OR-ed. Order of first appearance is kept.
 */
export function coalesceWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[] {
  const byKey = new Map<string, WorkspaceInfo>()
  for (const ws of list) {
    const key = `${ws.accountId.toLowerCase()}/${ws.orgId.toLowerCase()}`
    const prev = byKey.get(key)
    if (prev === undefined) {
      byKey.set(key, ws)
      continue
    }
    const preferNew = isLocalCacheRoot(ws.root) && !isLocalCacheRoot(prev.root)
    const main = preferNew ? ws : prev
    const other = preferNew ? prev : ws
    byKey.set(key, {
      ...main,
      email: main.email ?? other.email,
      accountName: main.accountName ?? other.accountName,
      taskCount: Math.max(main.taskCount, other.taskCount),
      lastActivityMs: Math.max(main.lastActivityMs, other.lastActivityMs),
      signedInNow: main.signedInNow || other.signedInNow,
      leftover: main.leftover || other.leftover,
      newLayout: (main.newLayout || other.newLayout) && Math.max(main.taskCount, other.taskCount) === 0
    })
  }
  return [...byKey.values()]
}
