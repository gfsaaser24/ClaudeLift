/**
 * ClaudeLift stdio MCP server.
 *
 * A standalone Model Context Protocol server (bundled to server.cjs) that
 * exposes the cowork-export sidecar to MCP clients: list tasks, render a
 * transcript, build a continuation seed prompt, list export bundles, and run
 * a real export. It talks to the sidecar through `./engine` (no electron).
 *
 * CRITICAL: the JSON-RPC protocol owns stdout — anything written there that
 * is not a protocol frame corrupts the stream. All logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  exportTask,
  getTranscript,
  listTasks,
  makeSeed,
  scanBundles,
  type BundleSummary
} from './engine'
import type { CoworkTask } from '../shared/ipc'

/** Cap on transcript/seed text returned to the client (chars). */
const CHARACTER_LIMIT = 25_000

/** Default export destination when the caller does not pass one. */
function defaultOutputDir(): string {
  return join(homedir(), 'Documents', 'CoworkExports')
}

type TextResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] }
}

function fail(message: string): TextResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Truncate oversized text at CHARACTER_LIMIT with an explanatory footer. */
function clamp(text: string, label: string): string {
  if (text.length <= CHARACTER_LIMIT) return text
  const shown = text.slice(0, CHARACTER_LIMIT)
  return (
    `${shown}\n\n` +
    `[... ${label} truncated: showing the first ${CHARACTER_LIMIT} of ${text.length} characters. ` +
    'Export the task to a bundle to read the full content. ...]'
  )
}

/**
 * Format-aware truncation. Appending a prose footer to a JSON payload (or
 * cutting it mid-structure) yields invalid JSON, so for `format='json'` we
 * return a valid JSON truncation envelope instead.
 */
function clampForFormat(text: string, format: 'md' | 'json', label: string): string {
  if (text.length <= CHARACTER_LIMIT) return text
  if (format === 'json') {
    return JSON.stringify(
      {
        truncated: true,
        total_chars: text.length,
        limit: CHARACTER_LIMIT,
        note:
          `The ${label} exceeds the ${CHARACTER_LIMIT}-character inline limit. ` +
          'Request format:"md" for a truncated readable view, or use claudelift_export_task ' +
          'to write the full structured JSON to a bundle.'
      },
      null,
      2
    )
  }
  return clamp(text, label)
}

/** ms epoch → "YYYY-MM-DD HH:MM" (UTC), for readable "last activity". */
function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// projections (markdown + json shapes)
// ---------------------------------------------------------------------------

function projectTask(task: CoworkTask): Record<string, unknown> {
  return {
    task_id: task.taskId,
    title: task.title,
    model: task.model,
    space_name: task.spaceName,
    last_activity: formatWhen(task.lastActivityMs),
    has_transcript: task.hasTranscript,
    archived: task.archived
  }
}

function tasksMarkdown(tasks: CoworkTask[], source: string): string {
  if (tasks.length === 0) return `No ${source} tasks found.`
  const lines = tasks.map((task) => {
    const shortId = task.taskId.slice(0, 8)
    const tags: string[] = []
    if (task.hasTranscript) tags.push('transcript')
    if (task.archived) tags.push('archived')
    const suffix = tags.length > 0 ? ` · ${tags.join(', ')}` : ''
    const space = task.spaceName ? ` · ${task.spaceName}` : ''
    return `- **${task.title || '(untitled)'}** (${shortId}) · ${task.model}${space} · ${formatWhen(
      task.lastActivityMs
    )}${suffix}`
  })
  return `# Tasks (source: ${source}) — ${tasks.length} found\n\n${lines.join('\n')}`
}

function projectBundle(bundle: BundleSummary): Record<string, unknown> {
  return {
    dir: bundle.dir,
    task_id: bundle.taskId,
    title: bundle.title,
    exported_at: bundle.exportedAt,
    size_bytes: bundle.sizeBytes,
    formats: bundle.formats
  }
}

function bundlesMarkdown(bundles: BundleSummary[], dir: string): string {
  if (bundles.length === 0) return `No export bundles found in ${dir}.`
  const lines = bundles.map((bundle) => {
    const when = bundle.exportedAt ? bundle.exportedAt.slice(0, 19).replace('T', ' ') : 'unknown'
    const formats = bundle.formats.length > 0 ? bundle.formats.join(', ') : 'none'
    return `- **${bundle.title || bundle.taskId}** (${bundle.taskId.slice(0, 8)}) · ${when} · ${formatSize(
      bundle.sizeBytes
    )} · [${formats}]\n  ${bundle.dir}`
  })
  return `# Bundles in ${dir} — ${bundles.length} found\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// server + tools
// ---------------------------------------------------------------------------

const SOURCE_VALUES = ['cowork', 'code', 'both'] as const
const FORMAT_VALUES = ['markdown', 'json'] as const
const EXPORT_FORMAT_VALUES = ['html', 'md', 'json', 'csv'] as const

function buildServer(): McpServer {
  const server = new McpServer({ name: 'claudelift-mcp-server', version: '0.5.0' })

  server.registerTool(
    'claudelift_list_tasks',
    {
      title: 'List Claude Cowork tasks',
      description:
        'List Claude Cowork (and/or Claude Code) tasks discovered on this machine. Returns each ' +
        "task's id, title, model, space, last-activity time, and whether it has a transcript. Use " +
        'this to find a task_id for the other tools.',
      inputSchema: {
        source: z
          .enum(SOURCE_VALUES)
          .default('cowork')
          .describe("Which store to list: 'cowork' (default), 'code' (legacy ~/.claude), or 'both'."),
        cowork_root: z
          .string()
          .optional()
          .describe('Optional override for the Cowork sessions root directory.'),
        response_format: z
          .enum(FORMAT_VALUES)
          .default('markdown')
          .describe("'markdown' for a readable list (default) or 'json' for the raw array.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ source, cowork_root, response_format }) => {
      try {
        const tasks = await listTasks(source, cowork_root)
        if (response_format === 'json') {
          return ok(JSON.stringify(tasks.map(projectTask), null, 2))
        }
        return ok(tasksMarkdown(tasks, source))
      } catch (err) {
        return fail(`could not list tasks: ${errText(err)}`)
      }
    }
  )

  server.registerTool(
    'claudelift_get_transcript',
    {
      title: 'Get a task transcript',
      description:
        'Render a full task transcript as Markdown (default) or JSON. Pass the full task_id from ' +
        `claudelift_list_tasks. Output longer than ${CHARACTER_LIMIT} characters is truncated.`,
      inputSchema: {
        task_id: z.string().describe('Full task id (from claudelift_list_tasks).'),
        format: z
          .enum(['md', 'json'])
          .default('md')
          .describe("'md' for rendered Markdown (default) or 'json' for the structured session.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ task_id, format }) => {
      const id = task_id.trim()
      if (id.length === 0) return fail('task_id is required.')
      try {
        const text = await getTranscript(id, format)
        return ok(clampForFormat(text, format, 'transcript'))
      } catch (err) {
        return fail(`could not render transcript for "${id}": ${errText(err)}`)
      }
    }
  )

  server.registerTool(
    'claudelift_seed_prompt',
    {
      title: 'Build a continuation seed prompt',
      description:
        'Generate a paste-able Markdown "seed" prompt that hands a fresh Cowork chat the full ' +
        'context of a prior task (metadata, files, where things left off). Modes: brief, standard ' +
        `(default), full. Output longer than ${CHARACTER_LIMIT} characters is truncated.`,
      inputSchema: {
        task_id: z.string().describe('Full task id (from claudelift_list_tasks).'),
        mode: z
          .enum(['brief', 'standard', 'full'])
          .default('standard')
          .describe("How much context to pack in: 'brief', 'standard' (default), or 'full'.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ task_id, mode }) => {
      const id = task_id.trim()
      if (id.length === 0) return fail('task_id is required.')
      try {
        const text = await makeSeed(id, mode)
        return ok(clamp(text, 'seed prompt'))
      } catch (err) {
        return fail(`could not build a seed prompt for "${id}": ${errText(err)}`)
      }
    }
  )

  server.registerTool(
    'claudelift_list_bundles',
    {
      title: 'List export bundles',
      description:
        'List previously exported task bundles in a directory (defaults to ' +
        'Documents/CoworkExports). Each entry reports the task id, title, export time, size, and ' +
        'which session formats were written.',
      inputSchema: {
        output_dir: z
          .string()
          .optional()
          .describe('Directory to scan (defaults to Documents/CoworkExports).'),
        response_format: z
          .enum(FORMAT_VALUES)
          .default('markdown')
          .describe("'markdown' for a readable list (default) or 'json' for the raw array.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ output_dir, response_format }) => {
      const dir = output_dir && output_dir.length > 0 ? output_dir : defaultOutputDir()
      try {
        const bundles = await scanBundles(dir)
        if (response_format === 'json') {
          return ok(JSON.stringify(bundles.map(projectBundle), null, 2))
        }
        return ok(bundlesMarkdown(bundles, dir))
      } catch (err) {
        return fail(`could not scan bundles in "${dir}": ${errText(err)}`)
      }
    }
  )

  server.registerTool(
    'claudelift_export_task',
    {
      title: 'Export a task to a bundle',
      description:
        'Run a real export of a task into a bundle directory on disk, including uploaded and ' +
        'generated files. Writes session files in the requested formats (default: html, md, json, ' +
        'csv) plus a manifest and transcript. Returns the bundle path and a manifest summary. ' +
        'Re-exporting the same task overwrites its existing bundle at the destination.',
      inputSchema: {
        task_id: z.string().describe('Full task id (from claudelift_list_tasks).'),
        formats: z
          .array(z.enum(EXPORT_FORMAT_VALUES))
          .default([...EXPORT_FORMAT_VALUES])
          .describe('Session formats to render (default: all of html, md, json, csv).'),
        output_dir: z
          .string()
          .optional()
          .describe('Destination directory (defaults to Documents/CoworkExports).')
      },
      // destructiveHint: a re-export overwrites any existing bundle at the destination.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ task_id, formats, output_dir }) => {
      const id = task_id.trim()
      if (id.length === 0) return fail('task_id is required.')
      const dir = output_dir && output_dir.length > 0 ? output_dir : defaultOutputDir()
      const requested = formats.length > 0 ? formats : [...EXPORT_FORMAT_VALUES]
      try {
        const { bundleDir, manifest } = await exportTask(id, requested, dir)
        const summary = {
          bundle_dir: bundleDir,
          source_task_id: manifest.source_task_id ?? id,
          exported_at: manifest.exported_at ?? null,
          source_platform: manifest.source_platform ?? null,
          formats: requested
        }
        return ok(
          `Exported task ${id} to:\n${bundleDir}\n\nManifest summary:\n${JSON.stringify(summary, null, 2)}`
        )
      } catch (err) {
        return fail(`could not export "${id}": ${errText(err)}`)
      }
    }
  )

  return server
}

async function main(): Promise<void> {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr only — stdout is the JSON-RPC channel.
  console.error('claudelift-mcp-server 0.5.0 ready on stdio (5 tools registered)')
}

main().catch((err) => {
  console.error('claudelift-mcp-server fatal:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
