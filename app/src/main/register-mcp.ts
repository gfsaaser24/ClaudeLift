/**
 * ipcMain.handle registrations for the mcp:* channels: mcp:info,
 * mcp:installToClaudeDesktop, mcp:revealServer.
 *
 * ClaudeLift ships a local Model Context Protocol server (server.cjs). These
 * handlers resolve its canonical launch config and wire it into Claude
 * Desktop's config file so Claude Desktop / Claude Code / Cursor can drive
 * ClaudeLift's export tools.
 *
 * Path resolution mirrors EngineService.exePath — packaged: the file lands
 * at `<resources>/mcp/server.cjs` (see electron.builder.yml's
 * `resources/mcp → mcp` extraResources mapping); dev: `resources/mcp/server.cjs`
 * relative to the built main bundle (`out/main` → `../../resources`). The
 * launch `command` is the app's own binary (ClaudeLift.exe when packaged),
 * run as plain node via `ELECTRON_RUN_AS_NODE=1`.
 *
 * ERROR CONVENTION — identical to register-tasks.ts (its `toIpcError` is
 * module-private, so the tiny serializer is mirrored here): handlers throw
 * a plain Error whose MESSAGE is the JSON document
 * `{"kind": "none"|"validation"|"aborted"|"crash", "message": string, "stderr": string}`.
 *
 * Guard: the write paths (the config file and its `.bak-claudelift` sibling)
 * are always the resolved Claude Desktop config path — never an
 * attacker-supplied or renderer-supplied path.
 */
import { app } from 'electron'
import type { IpcMain, Shell } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INVOKE_CHANNELS, type McpInfo, type McpInstallResult } from '../shared/ipc'

interface IpcErrorShape {
  kind: 'none' | 'validation' | 'aborted' | 'crash'
  message: string
  stderr: string
}

/** Serialize any thrown value into the plain-Error-with-JSON-message shape. */
function toIpcError(err: unknown): Error {
  const shape: IpcErrorShape = {
    kind: 'crash',
    message: err instanceof Error ? err.message : String(err),
    stderr: ''
  }
  return new Error(JSON.stringify(shape))
}

const CONFIG_NOT_FOUND =
  'Claude Desktop config not found — is Claude Desktop installed?'

/** Bundled server.cjs, packaged-vs-dev, mirroring EngineService.exePath. */
function resolveServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'server.cjs')
    : join(__dirname, '../../resources/mcp/server.cjs')
}

/** The app's own binary, run as node via ELECTRON_RUN_AS_NODE. */
function resolveCommand(): string {
  return process.execPath
}

/** Canonical MCP config object for the claudelift server. */
function buildConfig(command: string, serverPath: string): {
  mcpServers: {
    claudelift: { command: string; args: string[]; env: { ELECTRON_RUN_AS_NODE: string } }
  }
} {
  return {
    mcpServers: {
      claudelift: {
        command,
        args: [serverPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }
}

/**
 * Resolve the Claude Desktop config path, or null when not installed.
 * Tries the plain Win32 install (`%APPDATA%\Claude\…`) first, then the
 * Microsoft Store / packaged install
 * (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\…`). Returns
 * the first path that actually exists on disk.
 */
function resolveClaudeDesktopConfigPath(): string | null {
  const appData = process.env.APPDATA ?? ''
  if (appData !== '') {
    const primary = join(appData, 'Claude', 'claude_desktop_config.json')
    if (existsSync(primary)) return primary
  }

  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData !== '') {
    const packagesDir = join(localAppData, 'Packages')
    try {
      const packages = readdirSync(packagesDir).filter((name) => /^Claude_/i.test(name))
      for (const pkg of packages) {
        const candidate = join(
          packagesDir,
          pkg,
          'LocalCache',
          'Roaming',
          'Claude',
          'claude_desktop_config.json'
        )
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* Packages dir missing — fall through to null */
    }
  }

  return null
}

/** True when `configPath` parses and already has `mcpServers.claudelift`. */
function isInstalledInClaudeDesktop(configPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return false
    const servers = (parsed as { mcpServers?: unknown }).mcpServers
    if (servers === null || typeof servers !== 'object') return false
    return (servers as Record<string, unknown>).claudelift !== undefined
  } catch {
    return false
  }
}

export interface RegisterMcpOptions {
  ipcMain: IpcMain
  shell: Shell
}

export function registerMcpHandlers(options: RegisterMcpOptions): void {
  const { ipcMain, shell } = options

  ipcMain.handle(INVOKE_CHANNELS.mcpInfo, () => {
    try {
      const command = resolveCommand()
      const serverPath = resolveServerPath()
      const configJson = JSON.stringify(buildConfig(command, serverPath), null, 2)
      const claudeDesktopConfigPath = resolveClaudeDesktopConfigPath()
      const info: McpInfo = {
        command,
        serverPath,
        configJson,
        claudeDesktopConfigPath,
        installedInClaudeDesktop:
          claudeDesktopConfigPath !== null &&
          isInstalledInClaudeDesktop(claudeDesktopConfigPath),
        serverExists: existsSync(serverPath)
      }
      return info
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.mcpInstallToClaudeDesktop, () => {
    try {
      const command = resolveCommand()
      const serverPath = resolveServerPath()
      const configPath = resolveClaudeDesktopConfigPath()
      if (configPath === null) {
        const result: McpInstallResult = { ok: false, reason: CONFIG_NOT_FOUND }
        return result
      }

      // Back up the existing config verbatim before touching it.
      const original = readFileSync(configPath, 'utf8')
      writeFileSync(`${configPath}.bak-claudelift`, original, 'utf8')

      // Parse (tolerating a corrupt/empty file), ensure mcpServers, set our
      // entry, write back with 2-space indent.
      let root: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(original)
        root = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      } catch {
        root = {}
      }
      const existing = root.mcpServers
      const mcpServers =
        existing !== null && typeof existing === 'object'
          ? (existing as Record<string, unknown>)
          : {}
      mcpServers.claudelift = {
        command,
        args: [serverPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
      root.mcpServers = mcpServers
      writeFileSync(configPath, JSON.stringify(root, null, 2), 'utf8')

      const result: McpInstallResult = { ok: true, path: configPath }
      return result
    } catch (err) {
      throw toIpcError(err)
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.mcpRevealServer, () => {
    try {
      const serverPath = resolveServerPath()
      if (!existsSync(serverPath)) return false
      shell.showItemInFolder(serverPath)
      return true
    } catch (err) {
      throw toIpcError(err)
    }
  })
}
