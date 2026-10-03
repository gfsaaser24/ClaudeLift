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
import { join } from 'node:path'
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

async function describeWorkspace(root: string, accountId: string, orgId: string): Promise<WorkspaceInfo> {
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

  return {
    path,
    root,
    accountId,
    orgId,
    email: identity?.email ?? null,
    accountName: identity?.accountName ?? null,
    taskCount: files.length,
    lastActivityMs: withMtime[0]?.mtimeMs ?? 0
  }
}

/** Every `<root>/<account>/<org>` workspace under the given Cowork roots. */
export async function listWorkspaces(roots: string[]): Promise<WorkspaceInfo[]> {
  const out: WorkspaceInfo[] = []
  for (const root of roots) {
    for (const accountId of await subdirs(root)) {
      for (const orgId of await subdirs(join(root, accountId))) {
        out.push(await describeWorkspace(root, accountId, orgId))
      }
    }
  }
  return out
}
