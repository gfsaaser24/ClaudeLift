/**
 * SettingsView (Task 15).
 *
 * Every control writes through the store's `patchSettings` immediately
 * (optimistic, no Save button); watcher/tray react live in the main
 * process. Cards: Behavior, Export defaults, Advanced (cowork-root
 * override + Diagnostics collapse), Danger zone.
 *
 * "Clear all settings" goes through the store's `clearAllSettings()`,
 * which invokes the dedicated `settings:clearAll` IPC channel — main
 * wipes ALL persisted state (settings, window state, Notion journal,
 * flags) and responds with fresh defaults, so the confirm dialog's
 * promise is kept by the main process rather than a renderer-side
 * defaults mirror.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  McpInfoSchema,
  McpInstallResultSchema,
  PickFolderResultSchema,
  TaskSourceSchema,
  type McpInfo
} from '../../shared/ipc'
import { errorText, useAppStore } from '../store'
import ConfirmDangerModal from '../components/ConfirmDangerModal'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORMAT_OPTIONS: { id: string; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'md', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
  { id: 'csv', label: 'CSV' }
]

// ---------------------------------------------------------------------------
// Inline SVG icons (lucide-style, hand-written paths)
// ---------------------------------------------------------------------------

function IconBase({ children }: { children: JSX.Element[] | JSX.Element }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <IconBase>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </IconBase>
  )
}

function RefreshIcon(): JSX.Element {
  return (
    <IconBase>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </IconBase>
  )
}

function UndoIcon(): JSX.Element {
  return (
    <IconBase>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </IconBase>
  )
}

function CopyIcon(): JSX.Element {
  return (
    <IconBase>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </IconBase>
  )
}

function ServerIcon(): JSX.Element {
  return (
    <IconBase>
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <path d="M6 6h.01M6 18h.01" />
    </IconBase>
  )
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

interface ToggleRowProps {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false
}: ToggleRowProps): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-xs opacity-60">{description}</span>
      </span>
      <input
        type="checkbox"
        className="toggle mt-1 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.currentTarget.checked)
        }}
      />
    </label>
  )
}

function DiagnosticsRow({
  label,
  value
}: {
  label: string
  value: string
}): JSX.Element {
  return (
    <>
      <span className="opacity-60">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </>
  )
}

// ---------------------------------------------------------------------------
// MCP server card
// ---------------------------------------------------------------------------

const MCP_GUIDE_URL =
  'https://github.com/gfsaaser24/ClaudeLift/blob/main/docs/MCP.md'

/** Open an external URL — main's setWindowOpenHandler routes http(s) to the browser. */
function openExternal(url: string): void {
  window.open(url, '_blank')
}

function McpServerCard(): JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast)
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)

  const loadInfo = useCallback(async (): Promise<void> => {
    try {
      setInfo(McpInfoSchema.parse(await window.api.mcpInfo()))
    } catch (err) {
      pushToast('error', `MCP info unavailable: ${errorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  async function copy(text: string, okMsg: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      pushToast('success', okMsg)
    } catch {
      pushToast('error', 'Copy failed')
    }
  }

  async function install(): Promise<void> {
    setInstalling(true)
    try {
      const result = McpInstallResultSchema.parse(
        await window.api.mcpInstallToClaudeDesktop()
      )
      if (result.ok) {
        pushToast(
          'success',
          'Added to Claude Desktop — fully quit and reopen Claude for it to load'
        )
        await loadInfo()
      } else {
        pushToast('error', result.reason)
      }
    } catch (err) {
      pushToast('error', `Add to Claude Desktop failed: ${errorText(err)}`)
    } finally {
      setInstalling(false)
    }
  }

  async function reveal(): Promise<void> {
    try {
      const ok = await window.api.mcpRevealServer()
      if (!ok) {
        pushToast(
          'error',
          'Server file not found — build it first with npm run build:mcp'
        )
      }
    } catch (err) {
      pushToast('error', `Reveal failed: ${errorText(err)}`)
    }
  }

  const claudeCodeCmd =
    info === null
      ? ''
      : `claude mcp add claudelift -e ELECTRON_RUN_AS_NODE=1 -- "${info.command}" "${info.serverPath}"`

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-3">
        <h2 className="card-title flex items-center gap-2">
          <ServerIcon />
          MCP server
        </h2>

        <p className="text-sm opacity-70">
          ClaudeLift ships a local Model Context Protocol server so Claude
          Desktop, Claude Code, or Cursor can read and export your Cowork chats
          straight from the chat window. It exposes five tools: list tasks, get
          transcript, seed prompt, list bundles, and export task.{' '}
          <a
            className="link link-primary"
            href={MCP_GUIDE_URL}
            onClick={(e) => {
              e.preventDefault()
              openExternal(MCP_GUIDE_URL)
            }}
          >
            Full guide
          </a>
        </p>

        <p className="text-xs opacity-60">
          Tools appear in regular Claude Desktop chats and in Claude Code / Cursor — not
          inside Cowork agent-mode chats (Cowork runs in a remote sandbox that can't reach a
          local server).
        </p>

        {loading ? (
          <div className="skeleton h-40 w-full" />
        ) : info === null ? (
          <div role="alert" className="alert alert-soft">
            <span>Could not load MCP server details.</span>
          </div>
        ) : (
          <>
            {!info.serverExists && (
              <div role="alert" className="alert alert-warning alert-soft">
                <span>
                  The MCP server hasn&apos;t been built yet — run{' '}
                  <code className="font-mono">npm run build:mcp</code> to create{' '}
                  <code className="font-mono">server.cjs</code>.
                </span>
              </div>
            )}

            {/* Current state */}
            <div className="flex flex-wrap items-center gap-2">
              {info.installedInClaudeDesktop && (
                <span className="badge badge-success badge-sm">
                  In Claude Desktop config
                </span>
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs opacity-60"
                title={info.claudeDesktopConfigPath ?? undefined}
              >
                {info.claudeDesktopConfigPath ?? 'Claude Desktop config not found'}
              </span>
            </div>

            {/* Config block */}
            <fieldset className="fieldset">
              <legend className="fieldset-legend">MCP config</legend>
              <div className="relative">
                <button
                  type="button"
                  className="btn btn-xs absolute right-2 top-2"
                  onClick={() => {
                    void copy(info.configJson, 'Config copied')
                  }}
                >
                  <CopyIcon />
                  Copy
                </button>
                <pre className="max-h-64 overflow-auto rounded-box bg-base-200 p-4 pr-20 font-mono text-xs">
                  <code>{info.configJson}</code>
                </pre>
              </div>
              <p className="label">
                Paste into any MCP client&apos;s config to add the claudelift
                server.
              </p>
            </fieldset>

            {/* Buttons row */}
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={installing}
                onClick={() => {
                  void install()
                }}
              >
                {installing && (
                  <span className="loading loading-spinner loading-xs" />
                )}
                Add to Claude Desktop
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!info.serverExists}
                onClick={() => {
                  void reveal()
                }}
              >
                <FolderIcon />
                Reveal server file
              </button>
            </div>

            {/* Claude Code */}
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Claude Code</legend>
              <div className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-field bg-base-200 px-3 py-2 font-mono text-xs"
                  title={claudeCodeCmd}
                >
                  {claudeCodeCmd}
                </code>
                <button
                  type="button"
                  className="btn btn-sm shrink-0"
                  onClick={() => {
                    void copy(claudeCodeCmd, 'Command copied')
                  }}
                >
                  <CopyIcon />
                  Copy
                </button>
              </div>
              <p className="label">Run once to register the server with Claude Code.</p>
            </fieldset>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function SettingsView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const diagnostics = useAppStore((s) => s.diagnostics)
  const watcher = useAppStore((s) => s.watcher)
  const taskCount = useAppStore((s) => s.tasks.length)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const refreshDiagnostics = useAppStore((s) => s.refreshDiagnostics)
  const refreshTasks = useAppStore((s) => s.refreshTasks)
  const clearAllSettings = useAppStore((s) => s.clearAllSettings)
  const pushToast = useAppStore((s) => s.pushToast)

  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)

  if (settings === null) {
    return (
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div className="mt-4 flex flex-col gap-4">
          <div className="skeleton h-40 w-full" />
          <div className="skeleton h-40 w-full" />
          <div className="skeleton h-28 w-full" />
        </div>
      </section>
    )
  }

  const watcherActive = watcher?.active ?? diagnostics?.watcher.active ?? false
  const scannedRoots = diagnostics?.scannedRoots ?? []

  async function pickFolder(purpose: string): Promise<string | null> {
    try {
      return PickFolderResultSchema.parse(
        await window.api.appPickFolder({ purpose })
      )
    } catch (err) {
      pushToast('error', `Folder picker failed: ${errorText(err)}`)
      return null
    }
  }

  async function browseOutputDir(): Promise<void> {
    const dir = await pickFolder('export-output')
    if (dir !== null) await patchSettings({ outputDir: dir })
  }

  async function browseCoworkRoot(): Promise<void> {
    const dir = await pickFolder('cowork-root')
    if (dir !== null) {
      await patchSettings({ coworkRootOverride: dir })
      await refreshTasks(true)
    }
  }

  async function resetCoworkRoot(): Promise<void> {
    await patchSettings({ coworkRootOverride: null })
    await refreshTasks(true)
  }

  function toggleFormat(id: string, enabled: boolean): void {
    if (settings === null) return
    const next = enabled
      ? FORMAT_OPTIONS.map((f) => f.id).filter(
          (f) => settings.formats.includes(f) || f === id
        )
      : settings.formats.filter((f) => f !== id)
    if (next.length === 0) return // >=1 format enforced
    void patchSettings({ formats: next })
  }

  async function changeSource(value: string): Promise<void> {
    const parsed = TaskSourceSchema.safeParse(value)
    if (!parsed.success) return
    await patchSettings({ source: parsed.data })
    await refreshTasks(true)
  }

  async function handleClearAll(): Promise<void> {
    setClearing(true)
    try {
      // Store action: settings:clearAll wipes ALL persisted state in main,
      // then the store re-seeds settings/notion/log/filters from defaults.
      await clearAllSettings()
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="mx-auto w-full max-w-3xl">
      <h1 className="text-xl font-semibold">Settings</h1>

      <div className="mt-4 flex flex-col gap-4">
        {/* ------------------------------------------------ Behavior */}
        <div className="card card-border bg-base-100">
          <div className="card-body gap-4">
            <h2 className="card-title">Behavior</h2>
            <ToggleRow
              label="Minimize to tray"
              description="Minimizing hides the window to the system tray instead of the taskbar."
              checked={settings.minimizeToTray}
              onChange={(checked) => {
                void patchSettings({ minimizeToTray: checked })
              }}
            />
            <ToggleRow
              label="Close to tray"
              description="Closing the window keeps the app running in the tray."
              checked={settings.closeToTray}
              onChange={(checked) => {
                void patchSettings({ closeToTray: checked })
              }}
            />
            <ToggleRow
              label="Start minimized"
              description="Launch hidden in the tray instead of opening the window."
              checked={settings.startMinimized}
              onChange={(checked) => {
                void patchSettings({ startMinimized: checked })
              }}
            />
            <ToggleRow
              label="Live auto-refresh"
              description="Watch Cowork session files and refresh the task list automatically."
              checked={settings.watcherEnabled}
              onChange={(checked) => {
                void patchSettings({ watcherEnabled: checked })
              }}
            />
            {!settings.watcherEnabled && (
              <div role="alert" className="alert alert-soft">
                <span>
                  Live auto-refresh is off — use the Refresh button on Tasks to
                  update the list.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ------------------------------------------ Export defaults */}
        <div className="card card-border bg-base-100">
          <div className="card-body gap-2">
            <h2 className="card-title">Export defaults</h2>

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Output directory</legend>
              <div className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-field bg-base-200 px-3 py-2 font-mono text-xs"
                  title={settings.outputDir}
                >
                  {settings.outputDir}
                </code>
                <button
                  type="button"
                  className="btn btn-sm shrink-0"
                  onClick={() => {
                    void browseOutputDir()
                  }}
                >
                  <FolderIcon />
                  Browse
                </button>
              </div>
              <p className="label">Where exported bundles are written.</p>
            </fieldset>

            <div className="divider my-0" />

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Default formats</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {FORMAT_OPTIONS.map(({ id, label }) => {
                  const checked = settings.formats.includes(id)
                  return (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <input
                        type="checkbox"
                        className="toggle toggle-sm"
                        checked={checked}
                        disabled={checked && settings.formats.length === 1}
                        onChange={(e) => {
                          toggleFormat(id, e.currentTarget.checked)
                        }}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  )
                })}
              </div>
              <p className="label">
                Preselected in the export dialog. At least one format stays
                enabled.
              </p>
            </fieldset>

            <div className="divider my-0" />

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Source</legend>
              <select
                className="select w-full max-w-xs"
                value={settings.source}
                onChange={(e) => {
                  void changeSource(e.currentTarget.value)
                }}
              >
                <option value="cowork">Cowork</option>
                <option value="code">Code</option>
                <option value="both">Both</option>
              </select>
              <p className="label">
                Which task list the engine scans by default.
              </p>
            </fieldset>
          </div>
        </div>

        {/* ------------------------------------------------- Advanced */}
        <div className="card card-border bg-base-100">
          <div className="card-body gap-2">
            <h2 className="card-title">Advanced</h2>

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Cowork root override</legend>
              <div className="flex items-center gap-2">
                {settings.coworkRootOverride !== null ? (
                  <code
                    className="min-w-0 flex-1 truncate rounded-field bg-base-200 px-3 py-2 font-mono text-xs"
                    title={settings.coworkRootOverride}
                  >
                    {settings.coworkRootOverride}
                  </code>
                ) : (
                  <span className="min-w-0 flex-1 truncate rounded-field bg-base-200 px-3 py-2 text-xs italic opacity-60">
                    Auto-detected
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-sm shrink-0"
                  onClick={() => {
                    void browseCoworkRoot()
                  }}
                >
                  <FolderIcon />
                  Browse
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm shrink-0"
                  disabled={settings.coworkRootOverride === null}
                  onClick={() => {
                    void resetCoworkRoot()
                  }}
                >
                  <UndoIcon />
                  Reset to auto
                </button>
              </div>
              <p className="label">
                Point the engine at a non-standard Cowork sessions folder.
              </p>
            </fieldset>

            <div className="divider my-0" />

            <div className="collapse-arrow collapse bg-base-200">
              <input type="checkbox" />
              <div className="collapse-title font-medium">Diagnostics</div>
              <div className="collapse-content flex flex-col gap-3 text-sm">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <DiagnosticsRow
                    label="App version"
                    value={diagnostics?.appVersion ?? '—'}
                  />
                  <DiagnosticsRow
                    label="Engine version"
                    value={diagnostics?.engineVersion ?? '—'}
                  />
                  <DiagnosticsRow
                    label="Watcher"
                    value={watcherActive ? 'Active' : 'Inactive'}
                  />
                  <DiagnosticsRow label="Tasks" value={String(taskCount)} />
                </div>
                <div>
                  <span className="opacity-60">Scanned roots</span>
                  <div className="mt-1 font-mono text-xs">
                    {scannedRoots.length === 0 ? (
                      <span className="font-sans italic opacity-60">
                        None found
                      </span>
                    ) : (
                      scannedRoots.map((root) => (
                        <div key={root} className="break-all">
                          {root}
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      void refreshDiagnostics()
                    }}
                  >
                    <RefreshIcon />
                    Refresh diagnostics
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------ MCP server */}
        <McpServerCard />

        {/* ---------------------------------------------- Danger zone */}
        <div className="card card-border border-error bg-base-100">
          <div className="card-body gap-2">
            <h2 className="card-title text-error">Danger zone</h2>
            <p className="text-sm opacity-70">
              Resets every preference to its default and disconnects Notion.
              You will be asked to type <kbd className="kbd kbd-sm">RESET</kbd>{' '}
              to confirm.
            </p>
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-outline btn-error"
                disabled={clearing}
                onClick={() => {
                  setClearOpen(true)
                }}
              >
                {clearing && (
                  <span className="loading loading-spinner loading-xs" />
                )}
                Clear all settings
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDangerModal
        open={clearOpen}
        variant="error"
        title="Clear all settings"
        body="All settings, window state, Notion connection and export journal will be erased. The app will reload defaults."
        confirmLabel="Clear all settings"
        requireTypedWord="RESET"
        onConfirm={() => {
          setClearOpen(false)
          void handleClearAll()
        }}
        onCancel={() => {
          setClearOpen(false)
        }}
      />
    </section>
  )
}
