/**
 * Bundle the ClaudeLift stdio MCP server to a single CJS file.
 *
 * Everything (the MCP SDK, zod, our engine wrapper) is bundled into
 * resources/mcp/server.cjs so the file can run standalone with plain
 * `node server.cjs` — no node_modules alongside it. At install time the
 * file ships to <install>/resources/mcp/server.cjs (see electron.builder.yml)
 * and resolves the sidecar at ../engine/cowork-export/cowork-export.exe.
 */
import { build } from 'esbuild'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const outfile = join(appDir, 'resources', 'mcp', 'server.cjs')

await build({
  entryPoints: [join(appDir, 'src', 'mcp', 'server.ts')],
  outfile,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  target: 'node18',
  external: [] // bundle everything, including the MCP SDK and zod
})

const bytes = statSync(outfile).size
console.log(`built ${outfile} (${(bytes / 1024).toFixed(1)} KB)`)
