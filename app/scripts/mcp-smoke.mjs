/**
 * End-to-end smoke test for the ClaudeLift MCP server against the REAL
 * engine sidecar.
 *
 * Spawns `node resources/mcp/server.cjs`, performs the MCP initialize
 * handshake, calls tools/list, then tools/call claudelift_list_tasks
 * (source: cowork), reading newline-delimited JSON-RPC frames from stdout.
 * Asserts all 6 tools are present and that at least one task is returned.
 *
 * Exit 0 on success, 1 on any failure. Prints tool names + task count.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const serverPath = join(appDir, 'resources', 'mcp', 'server.cjs')

const EXPECTED_TOOLS = [
  'claudelift_list_tasks',
  'claudelift_get_transcript',
  'claudelift_seed_prompt',
  'claudelift_list_bundles',
  'claudelift_export_task',
  'claudelift_import_bundle'
]

const child = spawn(process.execPath, [serverPath], {
  cwd: appDir,
  stdio: ['pipe', 'pipe', 'pipe']
})

let stderrBuf = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk
  process.stderr.write(`[server] ${chunk}`)
})

// --- newline-delimited JSON-RPC plumbing -----------------------------------

const pending = new Map() // id -> { resolve, reject }
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line.length === 0) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // not a protocol frame
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for response to ${method} (id ${id})`))
      }
    }, 130_000).unref()
    child.stdin.write(frame)
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function die(message) {
  console.error(`\nSMOKE TEST FAILED: ${message}`)
  child.kill()
  process.exit(1)
}

// --- the exchange ----------------------------------------------------------

try {
  const initRes = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claudelift-mcp-smoke', version: '0.0.0' }
  })
  if (initRes.error) die(`initialize returned an error: ${JSON.stringify(initRes.error)}`)
  const serverName = initRes.result?.serverInfo?.name ?? '(unknown)'
  console.log(`\ninitialize OK — server: ${serverName}, protocol: ${initRes.result?.protocolVersion}`)

  notify('notifications/initialized', {})

  const listRes = await request('tools/list', {})
  if (listRes.error) die(`tools/list returned an error: ${JSON.stringify(listRes.error)}`)
  const tools = listRes.result?.tools ?? []
  const toolNames = tools.map((t) => t.name).sort()
  console.log(`\ntools/list returned ${tools.length} tools:`)
  for (const name of toolNames) console.log(`  - ${name}`)

  const missing = EXPECTED_TOOLS.filter((name) => !toolNames.includes(name))
  if (missing.length > 0) die(`missing expected tools: ${missing.join(', ')}`)
  if (tools.length !== EXPECTED_TOOLS.length) {
    die(`expected exactly ${EXPECTED_TOOLS.length} tools, got ${tools.length}`)
  }

  const callRes = await request('tools/call', {
    name: 'claudelift_list_tasks',
    arguments: { source: 'cowork', response_format: 'json' }
  })
  if (callRes.error) die(`tools/call returned an error: ${JSON.stringify(callRes.error)}`)
  if (callRes.result?.isError) {
    const text = callRes.result?.content?.[0]?.text ?? '(no text)'
    die(`claudelift_list_tasks returned isError: ${text}`)
  }
  const text = callRes.result?.content?.[0]?.text ?? '[]'
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    die(`claudelift_list_tasks did not return JSON; got: ${text.slice(0, 200)}`)
  }
  if (!Array.isArray(parsed)) die('claudelift_list_tasks JSON was not an array')
  console.log(`\nclaudelift_list_tasks (source cowork) returned ${parsed.length} tasks`)
  if (parsed.length === 0) die('expected > 0 tasks, got 0')
  console.log(`  sample: ${JSON.stringify(parsed[0])}`)

  console.log('\nSMOKE TEST PASSED')
  console.log(`  tools: ${tools.length} (${EXPECTED_TOOLS.length} expected)`)
  console.log(`  tasks: ${parsed.length}`)
  child.kill()
  process.exit(0)
} catch (err) {
  die(err instanceof Error ? err.message : String(err))
}
