/**
 * NotionView (Task 14): connect / disconnect a Notion integration,
 * pick the parent page, and follow per-task export progress.
 *
 * Three states:
 *  (a) disconnected — token form (password input, client-side
 *      /^(ntn_|secret_)/ check with a validator hint; the token is never
 *      logged or echoed anywhere), a "How to create a Notion integration"
 *      collapse, Connect button with loading. Backend errors surface
 *      verbatim in an alert-error.
 *  (b) connected — stats row (workspace, humanized max upload size,
 *      database linked?), parent-page URL fieldset (Save →
 *      notion:setParentPage; the backend's share-the-page guidance is
 *      shown verbatim in an alert-warning), Disconnect with confirm.
 *  (c) export log — zebra table over the store's notionLog: status badge
 *      (in-flight statuses animate with loading-dots), truncated message
 *      with tooltip, "Open in Notion" link, Retry on error.
 *
 * connect/setParentPage call window.api directly (responses zod-parsed
 * with NotionStatusSchema) so their rejections can render as inline
 * alerts instead of the store's toast-only handling; the store is then
 * synced via refreshNotion(). Disconnect and Retry go through the store
 * actions.
 *
 * NOTE: main/index.ts registers no webContents.setWindowOpenHandler, so
 * window.open() falls back to Electron's default child-window behavior
 * rather than the system browser. Per the task spec we still use
 * window.open for external links (and preventDefault the anchors so the
 * app window itself never navigates).
 */
import { useMemo, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { NotionStatusSchema } from '../../shared/ipc'
import type { NotionExportState, NotionStatus } from '../../shared/ipc'
import { errorText, useAppStore } from '../store'
import ConfirmDangerModal from '../components/ConfirmDangerModal'

// ---------------------------------------------------------------------------
// Constants + pure helpers
// ---------------------------------------------------------------------------

/** Client-side token shape check — Notion secrets start ntn_ or secret_. */
const TOKEN_PATTERN = /^(ntn_|secret_)/

const MIB = 1024 * 1024
const FREE_PLAN_MAX_UPLOAD_BYTES = 5 * MIB

/** 5242880 → "5 MiB", 5368709120 → "5 GiB". */
function humanBytes(bytes: number): string {
  const unit = bytes >= 1024 * MIB ? ('GiB' as const) : ('MiB' as const)
  const value = unit === 'GiB' ? bytes / (1024 * MIB) : bytes / MIB
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${rounded} ${unit}`
}

/**
 * The backend throws this guidance verbatim when the parent page 404s
 * (page not shared with the integration) — see register-notion.ts
 * SHARE_GUIDANCE. Matched by prefix so it renders as a warning, not an
 * error.
 */
function isShareGuidance(message: string): boolean {
  return message.startsWith('Share the page with your integration')
}

/** Open an external URL. See module note about setWindowOpenHandler. */
function openExternal(url: string): void {
  window.open(url, '_blank')
}

// ---------------------------------------------------------------------------
// Inline SVG icons (lucide-style, hand-written paths)
// ---------------------------------------------------------------------------

interface IconProps {
  className?: string
  children: JSX.Element | JSX.Element[]
}

function Icon({ className = 'size-6', children }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function LinkIcon({ className }: { className?: string }): JSX.Element {
  return (
    <Icon {...(className !== undefined ? { className } : {})}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  )
}

function GlobeIcon(): JSX.Element {
  return (
    <Icon>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Icon>
  )
}

function CloudUploadIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m16 16-4-4-4 4" />
    </Icon>
  )
}

function DatabaseIcon(): JSX.Element {
  return (
    <Icon>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Icon>
  )
}

function CircleAlertIcon(): JSX.Element {
  return (
    <Icon>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Icon>
  )
}

function TriangleAlertIcon(): JSX.Element {
  return (
    <Icon>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}

function ExternalLinkIcon(): JSX.Element {
  return (
    <Icon className="size-3.5">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  )
}

// ---------------------------------------------------------------------------
// Export-log status badge
// ---------------------------------------------------------------------------

function StatusBadge({
  status
}: {
  status: NotionExportState['status']
}): JSX.Element {
  if (status === 'done') {
    return <span className="badge badge-success">done</span>
  }
  if (status === 'error') {
    return <span className="badge badge-error">error</span>
  }
  // queued / zipping / uploading / creating / appending — in flight.
  return (
    <span className="badge badge-info gap-1 whitespace-nowrap">
      {status}
      <span className="loading loading-dots loading-xs" aria-hidden="true" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// (a) Disconnected — token form + how-to collapse
// ---------------------------------------------------------------------------

function DisconnectedCard(): JSX.Element {
  const refreshNotion = useAppStore((s) => s.refreshNotion)
  const pushToast = useAppStore((s) => s.pushToast)

  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const tokenValid = TOKEN_PATTERN.test(token)

  const handleConnect = async (
    event: FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!tokenValid || connecting) return
    setConnecting(true)
    setConnectError(null)
    try {
      const status = NotionStatusSchema.parse(
        await window.api.notionConnect({ token })
      )
      setToken('') // drop the secret from renderer state immediately
      await refreshNotion()
      const name = status.config.workspaceName
      pushToast(
        'success',
        name !== null ? `Connected to Notion: ${name}` : 'Connected to Notion'
      )
    } catch (err) {
      setConnectError(errorText(err))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="card card-border bg-base-100">
        <div className="card-body">
          <div className="flex items-center gap-3">
            <LinkIcon className="size-8 text-base-content/60" />
            <div>
              <h2 className="card-title">Connect to Notion</h2>
              <p className="text-sm text-base-content/70">
                Publish exported task bundles into a database in your Notion
                workspace.
              </p>
            </div>
          </div>

          {connectError !== null && (
            <div role="alert" className="alert alert-error mt-2">
              <CircleAlertIcon />
              <span className="whitespace-normal break-words">
                {connectError}
              </span>
            </div>
          )}

          <form onSubmit={(e) => void handleConnect(e)} className="mt-2">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Integration token</legend>
              <input
                type="password"
                className="input validator w-full"
                placeholder="ntn_… or secret_…"
                pattern="(ntn_|secret_).*"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-label="Notion integration token"
              />
              <p className="validator-hint">
                The token must start with ntn_ or secret_
              </p>
              <p className="label">
                Stored encrypted on this computer. Never logged or shared.
              </p>
            </fieldset>

            <div className="card-actions mt-2 justify-end">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={connecting || !tokenValid}
              >
                {connecting && (
                  <span
                    className="loading loading-spinner loading-sm"
                    aria-hidden="true"
                  />
                )}
                Connect
              </button>
            </div>
          </form>

          <div className="collapse-arrow collapse mt-2 border border-base-300 bg-base-200">
            <input
              type="checkbox"
              aria-label="Toggle Notion integration instructions"
            />
            <div className="collapse-title font-medium">
              How to create a Notion integration
            </div>
            <div className="collapse-content text-sm">
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Go to{' '}
                  <a
                    className="link"
                    href="https://app.notion.com/developers"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.preventDefault()
                      openExternal('https://app.notion.com/developers')
                    }}
                  >
                    app.notion.com/developers
                  </a>{' '}
                  and click New integration.
                </li>
                <li>
                  Pick the workspace to install it into — you must be a
                  workspace owner.
                </li>
                <li>
                  Under Capabilities, enable Read content and Insert content.
                </li>
                <li>Copy the integration secret and paste it above.</li>
                <li>
                  Share your target page with the integration: open the page in
                  Notion, click the ••• menu → Connections → add your
                  integration.
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// (b) Connected — stats row + parent page fieldset + disconnect
// ---------------------------------------------------------------------------

function ConnectedPanel({ notion }: { notion: NotionStatus }): JSX.Element {
  const refreshNotion = useAppStore((s) => s.refreshNotion)
  const notionDisconnect = useAppStore((s) => s.notionDisconnect)
  const pushToast = useAppStore((s) => s.pushToast)

  const [parentUrl, setParentUrl] = useState('')
  const [savingParent, setSavingParent] = useState(false)
  const [parentError, setParentError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const { config } = notion
  const databaseLinked = config.databaseId !== null

  const uploadLabel =
    config.maxUploadBytes === null
      ? 'Unknown'
      : config.maxUploadBytes <= FREE_PLAN_MAX_UPLOAD_BYTES
        ? `${humanBytes(config.maxUploadBytes)} — free plan`
        : humanBytes(config.maxUploadBytes)

  const handleSaveParent = async (): Promise<void> => {
    const url = parentUrl.trim()
    if (url === '' || savingParent) return
    setSavingParent(true)
    setParentError(null)
    try {
      NotionStatusSchema.parse(await window.api.notionSetParentPage({ url }))
      setParentUrl('')
      await refreshNotion()
      pushToast('success', 'Notion parent page saved')
    } catch (err) {
      setParentError(errorText(err))
    } finally {
      setSavingParent(false)
    }
  }

  return (
    <>
      <div className="stats stats-vertical w-full border border-base-300 bg-base-100 sm:stats-horizontal">
        <div className="stat">
          <div className="stat-figure text-base-content/40">
            <GlobeIcon />
          </div>
          <div className="stat-title">Workspace</div>
          <div className="stat-value text-lg">
            {config.workspaceName ?? 'Unknown'}
          </div>
        </div>

        <div className="stat">
          <div className="stat-figure text-base-content/40">
            <CloudUploadIcon />
          </div>
          <div className="stat-title">Max upload size</div>
          <div className="stat-value text-lg">{uploadLabel}</div>
          <div className="stat-desc">per-file limit for bundle zips</div>
        </div>

        <div className="stat">
          <div className="stat-figure text-base-content/40">
            <DatabaseIcon />
          </div>
          <div className="stat-title">Database</div>
          <div
            className={`stat-value text-lg ${
              databaseLinked ? 'text-success' : ''
            }`}
          >
            {databaseLinked ? '✓ Linked' : 'Not yet'}
          </div>
          {!databaseLinked && (
            <div className="stat-desc">created on first export</div>
          )}
        </div>
      </div>

      <div className="card card-border bg-base-100">
        <div className="card-body">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Parent page URL</legend>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="url"
                className="input w-full"
                placeholder="https://www.notion.so/Your-page-…"
                spellCheck={false}
                value={parentUrl}
                onChange={(e) => setParentUrl(e.target.value)}
                aria-label="Notion parent page URL"
              />
              <button
                type="button"
                className="btn"
                disabled={savingParent || parentUrl.trim() === ''}
                onClick={() => void handleSaveParent()}
              >
                {savingParent && (
                  <span
                    className="loading loading-spinner loading-sm"
                    aria-hidden="true"
                  />
                )}
                Save
              </button>
            </div>
            <p className="label">
              The exports database is created under this page.{' '}
              {config.parentPageId !== null
                ? `Current page id: ${config.parentPageId}`
                : 'No parent page set yet.'}
            </p>
          </fieldset>

          {parentError !== null &&
            (isShareGuidance(parentError) ? (
              <div role="alert" className="alert alert-warning">
                <TriangleAlertIcon />
                <span className="whitespace-normal break-words">
                  {parentError}
                </span>
              </div>
            ) : (
              <div role="alert" className="alert alert-error">
                <CircleAlertIcon />
                <span className="whitespace-normal break-words">
                  {parentError}
                </span>
              </div>
            ))}

          <div className="card-actions justify-end">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmOpen(true)}
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>

      <ConfirmDangerModal
        open={confirmOpen}
        variant="warning"
        title="Disconnect from Notion?"
        body={
          <p>
            This removes the stored integration token and workspace link from
            this computer. Pages already exported to Notion are not affected —
            you can reconnect at any time.
          </p>
        }
        confirmLabel="Disconnect"
        onConfirm={() => {
          setConfirmOpen(false)
          setParentError(null)
          setParentUrl('')
          void notionDisconnect()
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// (c) Export log table
// ---------------------------------------------------------------------------

function ExportLogCard(): JSX.Element {
  const notionLog = useAppStore((s) => s.notionLog)
  const tasks = useAppStore((s) => s.tasks)
  const notionRetry = useAppStore((s) => s.notionRetry)

  const titleByTaskId = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of tasks) map.set(task.taskId, task.title)
    return map
  }, [tasks])

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body">
        <h2 className="card-title">Export log</h2>

        {notionLog.length === 0 ? (
          <p className="text-sm text-base-content/70">
            No Notion exports yet — send a task from the Tasks or Bundles view.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-zebra table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th className="text-right">Page</th>
                </tr>
              </thead>
              <tbody>
                {notionLog.map((entry) => {
                  const title = titleByTaskId.get(entry.taskId)
                  const pageUrl = entry.pageUrl
                  return (
                    <tr key={entry.taskId}>
                      <td className="max-w-56">
                        <div
                          className="truncate font-medium"
                          title={title ?? entry.taskId}
                        >
                          {title ?? entry.taskId}
                        </div>
                        <div className="truncate font-mono text-xs text-base-content/60">
                          {entry.taskId}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={entry.status} />
                      </td>
                      <td className="max-w-64">
                        {entry.message === '' ? (
                          <span className="text-base-content/50">—</span>
                        ) : (
                          <div
                            className="tooltip tooltip-top max-w-full"
                            data-tip={entry.message}
                          >
                            <span className="block max-w-full truncate text-left">
                              {entry.message}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {pageUrl !== null && (
                            <a
                              className="link link-primary inline-flex items-center gap-1 whitespace-nowrap"
                              href={pageUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => {
                                e.preventDefault()
                                openExternal(pageUrl)
                              }}
                            >
                              Open in Notion
                              <ExternalLinkIcon />
                            </a>
                          )}
                          {entry.status === 'error' && (
                            <button
                              type="button"
                              className="btn btn-xs"
                              onClick={() => void notionRetry(entry.taskId)}
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function NotionView(): JSX.Element {
  const notion = useAppStore((s) => s.notion)
  const notionLog = useAppStore((s) => s.notionLog)

  // notion:status not loaded yet (initApp in flight).
  if (notion === null) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Notion</h1>
        <div className="mt-4 flex flex-col gap-2">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-10 w-1/2" />
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Notion</h1>

      {notion.connected ? (
        <ConnectedPanel notion={notion} />
      ) : (
        <DisconnectedCard />
      )}

      {(notion.connected || notionLog.length > 0) && <ExportLogCard />}
    </section>
  )
}
