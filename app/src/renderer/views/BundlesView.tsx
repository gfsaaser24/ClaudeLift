/**
 * BundlesView (Task 12): scan + browse exported bundles.
 *
 * Toolbar: output dir display, Browse (patches settings.outputDir then
 * rescans), a Cards/List view toggle (persisted via settings.bundleViewMode),
 * and Refresh (wired to store.refreshBundles). Two layouts share the same
 * five actions (Open folder / Preview / Seed / Import / Send to Notion):
 *   - card grid (1 / md:2 / xl:3) with visible action buttons, and
 *   - a compact zebra table with a per-row kebab action menu.
 *
 * Preview/Seed/Import mount their components only while a target bundle
 * is set — each returns null when its `bundle` prop is null, so closing
 * fully unmounts content (memory rule).
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { PickFolderResultSchema, type BundleInfo } from '../../shared/ipc'
import { errorText, useAppStore } from '../store'
import ImportModal from '../components/ImportModal'
import PreviewDrawer from '../components/PreviewDrawer'
import SeedModal from '../components/SeedModal'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 10 ? Math.round(value).toString() : value.toFixed(1)} ${units[unit]}`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function RefreshIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

function PackageIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-10 opacity-40"
      aria-hidden="true"
    >
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="m7.5 4.27 9 5.15" />
    </svg>
  )
}

function GridIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" />
    </svg>
  )
}

function ListIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function KebabIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  )
}

export default function BundlesView(): JSX.Element {
  const bundles = useAppStore((s) => s.bundles)
  const bundlesLoading = useAppStore((s) => s.bundlesLoading)
  const settings = useAppStore((s) => s.settings)
  const refreshBundles = useAppStore((s) => s.refreshBundles)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const setView = useAppStore((s) => s.setView)
  const pushToast = useAppStore((s) => s.pushToast)
  const notionExport = useAppStore((s) => s.notionExport)

  const [preview, setPreview] = useState<BundleInfo | null>(null)
  const [seedTarget, setSeedTarget] = useState<BundleInfo | null>(null)
  const [importTarget, setImportTarget] = useState<BundleInfo | null>(null)

  // Rescan on entry — the output dir may have changed since initApp.
  useEffect(() => {
    void refreshBundles()
  }, [refreshBundles])

  const outputDir = settings?.outputDir ?? ''

  const browse = async (): Promise<void> => {
    try {
      const dir = PickFolderResultSchema.parse(
        await window.api.appPickFolder({ purpose: 'Bundle output directory' })
      )
      if (dir === null) return
      await patchSettings({ outputDir: dir })
      await refreshBundles(dir)
    } catch (err) {
      pushToast('error', `Could not change output folder: ${errorText(err)}`)
    }
  }

  const openFolder = (dir: string): void => {
    window.api.bundlesOpenFolder({ dir }).catch((err: unknown) => {
      pushToast('error', `Open folder failed: ${errorText(err)}`)
    })
  }

  const sendToNotion = (bundle: BundleInfo): void => {
    void notionExport({ bundleDir: bundle.dir })
    pushToast('info', 'Sending to Notion — check the Notion tab for progress')
  }

  const viewMode = settings?.bundleViewMode ?? 'card'
  const setViewMode = (mode: 'card' | 'list'): void => {
    if (mode !== viewMode) void patchSettings({ bundleViewMode: mode })
  }

  return (
    <section>
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Bundles</h1>
        <div className="join max-w-full">
          <div className="input input-sm join-item w-72 max-w-full" title={outputDir}>
            <span className="truncate font-mono text-xs">{outputDir || '…'}</span>
          </div>
          <button type="button" className="btn btn-sm join-item" onClick={() => void browse()}>
            Browse
          </button>
        </div>
        <div className="join" role="group" aria-label="Bundle view mode">
          <button
            type="button"
            className={`btn btn-sm join-item ${viewMode === 'card' ? 'btn-active btn-primary' : ''}`}
            aria-pressed={viewMode === 'card'}
            title="Card view"
            onClick={() => setViewMode('card')}
          >
            <GridIcon />
            <span className="hidden sm:inline">Cards</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm join-item ${viewMode === 'list' ? 'btn-active btn-primary' : ''}`}
            aria-pressed={viewMode === 'list'}
            title="List view"
            onClick={() => setViewMode('list')}
          >
            <ListIcon />
            <span className="hidden sm:inline">List</span>
          </button>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={bundlesLoading}
          onClick={() => void refreshBundles()}
        >
          {bundlesLoading ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : (
            <RefreshIcon />
          )}
          Refresh
        </button>
      </div>

      {bundles.length === 0 ? (
        bundlesLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="skeleton h-40 w-full" />
            <div className="skeleton h-40 w-full" />
            <div className="skeleton h-40 w-full" />
          </div>
        ) : (
          <div className="card card-border mx-auto mt-8 max-w-md bg-base-100">
            <div className="card-body items-center text-center">
              <PackageIcon />
              <h2 className="card-title">No bundles yet</h2>
              <p className="text-sm opacity-70">
                Exported bundles land in{' '}
                <span className="break-all font-mono text-xs">{outputDir || 'the output folder'}</span>.
              </p>
              <div className="card-actions mt-2">
                <button type="button" className="btn btn-primary" onClick={() => setView('tasks')}>
                  Export your first task
                </button>
              </div>
            </div>
          </div>
        )
      ) : viewMode === 'list' ? (
        <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
          <table className="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Title</th>
                <th className="hidden md:table-cell">Task</th>
                <th className="hidden sm:table-cell">Exported</th>
                <th>Size</th>
                <th className="hidden lg:table-cell">Formats</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr key={bundle.dir}>
                  <td className="max-w-[16rem] truncate font-medium" title={bundle.title}>
                    {bundle.title}
                    <span className="mt-0.5 block font-mono text-[11px] opacity-60 md:hidden">
                      {bundle.taskId.slice(0, 8)}
                    </span>
                  </td>
                  <td className="hidden font-mono text-xs md:table-cell" title={bundle.taskId}>
                    {bundle.taskId.slice(0, 8)}
                  </td>
                  <td className="hidden whitespace-nowrap text-xs sm:table-cell">
                    {formatWhen(bundle.exportedAt)}
                  </td>
                  <td className="whitespace-nowrap text-xs">{formatBytes(bundle.sizeBytes)}</td>
                  <td className="hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      <span className="badge badge-outline badge-sm">
                        {bundle.sourcePlatform || 'unknown'}
                      </span>
                      {bundle.formats.map((format) => (
                        <span key={format} className="badge badge-ghost badge-sm">
                          {format}
                        </span>
                      ))}
                      {bundle.hasAuth && <span className="badge badge-warning badge-sm">auth</span>}
                      {bundle.hasSeed && <span className="badge badge-info badge-sm">seed</span>}
                    </div>
                  </td>
                  <td className="text-right">
                    <div className="dropdown dropdown-end">
                      <div
                        tabIndex={0}
                        role="button"
                        className="btn btn-ghost btn-xs"
                        aria-label={`Actions for ${bundle.title}`}
                      >
                        <KebabIcon />
                      </div>
                      <ul
                        tabIndex={0}
                        className="menu dropdown-content z-10 w-44 rounded-box bg-base-100 p-2 shadow-lg"
                      >
                        <li>
                          <button type="button" onClick={() => openFolder(bundle.dir)}>
                            Open folder
                          </button>
                        </li>
                        <li>
                          <button type="button" onClick={() => setPreview(bundle)}>
                            Preview
                          </button>
                        </li>
                        <li>
                          <button type="button" onClick={() => setSeedTarget(bundle)}>
                            Seed
                          </button>
                        </li>
                        <li>
                          <button type="button" onClick={() => setImportTarget(bundle)}>
                            Import
                          </button>
                        </li>
                        <li>
                          <button type="button" onClick={() => sendToNotion(bundle)}>
                            Send to Notion
                          </button>
                        </li>
                      </ul>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bundles.map((bundle) => (
            <div key={bundle.dir} className="card card-border bg-base-100">
              <div className="card-body gap-2 p-4">
                <h2 className="card-title block truncate text-base" title={bundle.title}>
                  {bundle.title}
                </h2>
                <p className="flex flex-wrap items-center gap-x-3 text-xs opacity-70">
                  <span className="font-mono" title={bundle.taskId}>
                    {bundle.taskId.slice(0, 8)}
                  </span>
                  <span>{formatWhen(bundle.exportedAt)}</span>
                  <span>{formatBytes(bundle.sizeBytes)}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  <span className="badge badge-outline badge-sm">
                    {bundle.sourcePlatform || 'unknown'}
                  </span>
                  {bundle.formats.map((format) => (
                    <span key={format} className="badge badge-ghost badge-sm">
                      {format}
                    </span>
                  ))}
                  {bundle.hasAuth && <span className="badge badge-warning badge-sm">auth</span>}
                  {bundle.hasSeed && <span className="badge badge-info badge-sm">seed</span>}
                </div>
                <div className="card-actions mt-1 flex-wrap gap-1">
                  <div className="join">
                    <button
                      type="button"
                      className="btn btn-xs join-item"
                      onClick={() => openFolder(bundle.dir)}
                    >
                      Open folder
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs join-item"
                      onClick={() => setPreview(bundle)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs join-item"
                      onClick={() => setSeedTarget(bundle)}
                    >
                      Seed
                    </button>
                  </div>
                  <div className="join">
                    <button
                      type="button"
                      className="btn btn-xs join-item"
                      onClick={() => setImportTarget(bundle)}
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs join-item"
                      onClick={() => sendToNotion(bundle)}
                    >
                      Send to Notion
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* each returns null while its bundle is null — full unmount on close */}
      <PreviewDrawer bundle={preview} onClose={() => setPreview(null)} />
      <SeedModal bundle={seedTarget} onClose={() => setSeedTarget(null)} />
      <ImportModal bundle={importTarget} onClose={() => setImportTarget(null)} />
    </section>
  )
}
