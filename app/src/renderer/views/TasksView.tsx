/**
 * TasksView (Task 10): live task list with toolbar filters, virtualized
 * rows (@tanstack/react-virtual), batch selection, and per-row actions.
 *
 * Conventions honored here:
 * - All state/actions come from the shared zustand store (read-only file
 *   for this task); silent refreshes (evt:tasksChanged) keep scroll and
 *   selection because the store swaps arrays without flipping
 *   tasksLoading and the row keys are stable taskIds.
 * - Direct window.api responses are zod-parsed with the shared response
 *   schemas (bundlesSeed → SeedResultSchema below); void responses have
 *   nothing to parse.
 * - daisyUI 5 semantic classes only; icons are hand-written inline SVG
 *   (lucide-style, stroke = currentColor).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SeedResultSchema } from '../../shared/ipc'
import type { BundleInfo, CoworkTask, TaskSource } from '../../shared/ipc'
import { errorText, useAppStore } from '../store'
import type { TaskFilters } from '../store'
import ExportModal from '../components/ExportModal'

// ---------------------------------------------------------------------------
// Constants + pure helpers
// ---------------------------------------------------------------------------

/** A task counts as "active now" when it saw activity within 3 minutes. */
const ACTIVE_WINDOW_MS = 3 * 60_000

/** Virtualized row height estimate (px); measureElement refines it. */
const ROW_ESTIMATE_PX = 64

/** '4m ago' style relative time from an epoch-ms timestamp. */
export function relativeTime(epochMs: number, nowMs: number): string {
  const diffS = Math.max(0, Math.floor((nowMs - epochMs) / 1000))
  if (diffS < 60) return 'just now'
  const m = Math.floor(diffS / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/** 'claude-opus-4-8' → 'opus-4-8' (badge stays readable at row width). */
export function shortModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model
}

/** taskId → string safe for HTML ids and CSS dashed-idents. */
function idSlug(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '')
}

const SOURCE_OPTIONS: ReadonlyArray<{ value: TaskSource; label: string }> = [
  { value: 'cowork', label: 'Cowork' },
  { value: 'code', label: 'Code' },
  { value: 'both', label: 'Both' }
]

const SORT_OPTIONS: ReadonlyArray<{
  value: TaskFilters['sort']
  label: string
}> = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'created', label: 'Created' },
  { value: 'title', label: 'Title A–Z' }
]

// ---------------------------------------------------------------------------
// Inline SVG icons (lucide-style paths, hand-written)
// ---------------------------------------------------------------------------

function Icon({
  className = 'size-4',
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
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

function SearchIcon(): JSX.Element {
  return (
    <Icon className="size-4 opacity-50">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  )
}

function RefreshIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Icon>
  )
}

function XIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

function EllipsisVerticalIcon(): JSX.Element {
  return (
    <Icon>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Icon>
  )
}

// ---------------------------------------------------------------------------
// Row action menu (daisyUI dropdown, popover API — recommended syntax)
// ---------------------------------------------------------------------------

interface RowMenuProps {
  task: CoworkTask
  onExport: (task: CoworkTask) => void
  onSeed: (task: CoworkTask) => void
  onSendToNotion: (task: CoworkTask) => void
  onOpenFolder: (task: CoworkTask) => void
  onCopyId: (task: CoworkTask) => void
}

function RowMenu({
  task,
  onExport,
  onSeed,
  onSendToNotion,
  onOpenFolder,
  onCopyId
}: RowMenuProps): JSX.Element {
  const slug = idSlug(task.taskId)
  const menuId = `task-menu-${slug}`
  const anchorName = `--task-menu-anchor-${slug}`

  const items: Array<{ label: string; action: (task: CoworkTask) => void }> = [
    { label: 'Export…', action: onExport },
    { label: 'Seed…', action: onSeed },
    { label: 'Send to Notion', action: onSendToNotion },
    { label: 'Open folder', action: onOpenFolder },
    { label: 'Copy id', action: onCopyId }
  ]

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        popoverTarget={menuId}
        style={{ anchorName } as CSSProperties}
        aria-label={`Actions for ${task.title || task.taskId}`}
      >
        <EllipsisVerticalIcon />
      </button>
      <ul
        className="dropdown dropdown-end menu w-48 rounded-box bg-base-100 shadow-sm"
        popover="auto"
        id={menuId}
        style={{ positionAnchor: anchorName } as CSSProperties}
      >
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              popoverTarget={menuId}
              popoverTargetAction="hide"
              onClick={() => item.action(task)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// ---------------------------------------------------------------------------
// TasksView
// ---------------------------------------------------------------------------

export default function TasksView(): JSX.Element {
  const tasks = useAppStore((s) => s.tasks)
  const tasksLoading = useAppStore((s) => s.tasksLoading)
  const filters = useAppStore((s) => s.filters)
  const selection = useAppStore((s) => s.selection)
  const settings = useAppStore((s) => s.settings)
  const diagnostics = useAppStore((s) => s.diagnostics)
  const bundles = useAppStore((s) => s.bundles)
  const exportModal = useAppStore((s) => s.exportModal)

  const setView = useAppStore((s) => s.setView)
  const refreshTasks = useAppStore((s) => s.refreshTasks)
  const setFilter = useAppStore((s) => s.setFilter)
  const toggleSelect = useAppStore((s) => s.toggleSelect)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const openExportModal = useAppStore((s) => s.openExportModal)
  const closeExportModal = useAppStore((s) => s.closeExportModal)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const notionExport = useAppStore((s) => s.notionExport)
  const pushToast = useAppStore((s) => s.pushToast)
  const visibleTasks = useAppStore((s) => s.visibleTasks)

  // Clock tick so relative times + the active-now dot stay fresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // visibleTasks() returns a fresh array; memoize on its actual inputs
  // (the store derives it from tasks + filters).
  const visible = useMemo(
    () => visibleTasks(),
    [visibleTasks, tasks, filters]
  )

  const spaces = useMemo(() => {
    const names = new Set<string>()
    for (const t of tasks) if (t.spaceName !== '') names.add(t.spaceName)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [tasks])

  // Virtualized list (scroll container = parentRef element).
  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 10
  })

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const bundleFor = (taskId: string): BundleInfo | undefined =>
    bundles.find((b) => b.taskId === taskId)

  const handleSourceChange = (value: TaskSource): void => {
    void patchSettings({ source: value }).then(() => refreshTasks())
  }

  const handleExportOne = (task: CoworkTask): void => {
    openExportModal([task])
  }

  const handleExportSelected = (): void => {
    const picked = tasks.filter((t) => selection.has(t.taskId))
    if (picked.length === 0) return
    openExportModal(picked)
  }

  const handleSeed = (task: CoworkTask): void => {
    const bundle = bundleFor(task.taskId)
    if (bundle === undefined) {
      pushToast('info', 'Export this task first')
      return
    }
    void (async () => {
      try {
        const result = SeedResultSchema.parse(
          await window.api.bundlesSeed({ bundleDir: bundle.dir, mode: 'standard' })
        )
        pushToast(
          'success',
          `Seed written: ${result.outputPath} (${result.chars} chars)`
        )
      } catch (err) {
        pushToast('error', `Seed failed: ${errorText(err)}`)
      }
    })()
  }

  // notion:export auto-exports a bundle when none exists yet, so no
  // "Export this task first" gate here — just call it.
  const handleSendToNotion = (task: CoworkTask): void => {
    void notionExport({ taskId: task.taskId })
  }

  const handleOpenFolder = (task: CoworkTask): void => {
    if (task.taskDir === null) {
      pushToast('info', 'No folder available for this task')
      return
    }
    const dir = task.taskDir
    void (async () => {
      try {
        await window.api.bundlesOpenFolder({ dir })
      } catch (err) {
        pushToast('error', `Could not open folder: ${errorText(err)}`)
      }
    })()
  }

  const handleCopyId = (task: CoworkTask): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(task.taskId)
        pushToast('success', 'Task id copied')
      } catch (err) {
        pushToast('error', `Copy failed: ${errorText(err)}`)
      }
    })()
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const showInitialSkeleton = tasksLoading && tasks.length === 0
  const scannedRoots = diagnostics?.scannedRoots ?? []
  const sourceValue = settings?.source ?? filters.source

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Tasks</h1>

        <label className="input w-56">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search title or id"
            value={filters.search}
            onChange={(e) => setFilter({ search: e.currentTarget.value })}
          />
        </label>

        <select
          className="select w-40"
          aria-label="Space"
          value={filters.space}
          onChange={(e) => setFilter({ space: e.currentTarget.value })}
        >
          <option value="all">All spaces</option>
          {spaces.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          className="select w-32"
          aria-label="Source"
          value={sourceValue}
          onChange={(e) =>
            handleSourceChange(e.currentTarget.value as TaskSource)
          }
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <select
          className="select w-44"
          aria-label="Sort"
          value={filters.sort}
          onChange={(e) =>
            setFilter({ sort: e.currentTarget.value as TaskFilters['sort'] })
          }
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={filters.showArchived}
            onChange={(e) =>
              setFilter({ showArchived: e.currentTarget.checked })
            }
          />
          Show archived
        </label>

        <button
          type="button"
          className="btn btn-ghost btn-square"
          aria-label="Refresh tasks"
          disabled={tasksLoading}
          onClick={() => void refreshTasks()}
        >
          {tasksLoading ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            <RefreshIcon />
          )}
        </button>
      </header>

      {/* List / loading / empty states */}
      {showInitialSkeleton ? (
        <div className="flex flex-col gap-2">
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-16 w-2/3" />
        </div>
      ) : visible.length === 0 ? (
        tasks.length === 0 ? (
          <div className="card card-border max-w-xl bg-base-100">
            <div className="card-body">
              <h2 className="card-title">No tasks found</h2>
              <p className="text-sm opacity-70">
                Nothing turned up in the scanned cowork roots:
              </p>
              {scannedRoots.length > 0 ? (
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {scannedRoots.map((root) => (
                    <li key={root} className="break-all">
                      {root}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs opacity-70">
                  No cowork roots were discovered on this machine.
                </p>
              )}
              <div className="card-actions mt-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setView('settings')}
                >
                  Open Settings
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="card card-border max-w-xl bg-base-100">
            <div className="card-body">
              <h2 className="card-title">No matching tasks</h2>
              <p className="text-sm opacity-70">
                {tasks.length} task{tasks.length === 1 ? '' : 's'} hidden by
                the current search or filters.
              </p>
            </div>
          </div>
        )
      ) : (
        <div
          ref={parentRef}
          className="min-h-0 flex-1 overflow-y-auto rounded-box border border-base-300 bg-base-100"
        >
          <ul
            className="list relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const task = visible[vi.index]
              if (task === undefined) return null
              const active = now - task.lastActivityMs < ACTIVE_WINDOW_MS
              const model = shortModel(task.model)
              return (
                <li
                  key={task.taskId}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="list-row absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={selection.has(task.taskId)}
                      onChange={() => toggleSelect(task.taskId)}
                      aria-label={`Select ${task.title || task.taskId}`}
                    />
                  </div>

                  <div className="min-w-0">
                    <div
                      className="tooltip tooltip-bottom block max-w-full"
                      data-tip={task.title || task.taskId}
                    >
                      <div className="truncate text-left text-sm font-medium">
                        {task.title || '(untitled)'}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {task.spaceName !== '' && (
                        <span className="badge badge-secondary badge-sm">
                          {task.spaceName}
                        </span>
                      )}
                      {model !== '' && (
                        <span className="badge badge-ghost badge-sm">
                          {model}
                        </span>
                      )}
                      <span className="badge badge-outline badge-sm">
                        {task.source}
                      </span>
                      {task.archived && (
                        <span className="badge badge-neutral badge-sm">
                          archived
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs opacity-70">
                    {active && (
                      <span
                        className="status status-success animate-pulse"
                        aria-label="Active now"
                      />
                    )}
                    {relativeTime(task.lastActivityMs, now)}
                  </div>

                  <div className="flex items-center">
                    <RowMenu
                      task={task}
                      onExport={handleExportOne}
                      onSeed={handleSeed}
                      onSendToNotion={handleSendToNotion}
                      onOpenFolder={handleOpenFolder}
                      onCopyId={handleCopyId}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Sticky batch-selection bar */}
      {selection.size > 0 && (
        <div className="sticky bottom-0 z-10 flex items-center gap-3 rounded-box border border-base-300 bg-base-100 p-3 shadow-sm">
          <button
            type="button"
            className="btn btn-ghost btn-square btn-sm"
            aria-label="Clear selection"
            onClick={clearSelection}
          >
            <XIcon />
          </button>
          <span className="text-sm">
            {selection.size} selected
          </span>
          <button
            type="button"
            className="btn btn-primary ml-auto"
            onClick={handleExportSelected}
          >
            Export selected
          </button>
        </div>
      )}

      <ExportModal
        open={exportModal.open}
        tasks={exportModal.tasks}
        onClose={closeExportModal}
      />
    </section>
  )
}
