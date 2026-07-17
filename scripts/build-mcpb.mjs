/**
 * build-mcpb.mjs — pack the ClaudeLift Claude Desktop Extension (.mcpb).
 *
 * Renders mcpb/icon.png, stages the built MCP server into mcpb/server/,
 * then packs mcpb/ into dist/ClaudeLift-<version>.mcpb via @anthropic-ai/mcpb.
 * Requires `npm run build:mcp` (app/resources/mcp/server.cjs) to have run.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mcpbDir = join(root, 'mcpb')
const require = createRequire(join(root, 'app', 'package.json'))
const sharp = require('sharp')

const version = JSON.parse(readFileSync(join(mcpbDir, 'manifest.json'), 'utf8')).version

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="60" fill="#E2571D"/><g fill="none" stroke="#FFFFFF" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"><path d="M84 196 H172"/><path d="M128 176 V84"/><path d="M88 124 L128 84 L168 124"/></g></svg>`
await sharp(Buffer.from(SVG), { density: 320 }).resize(512, 512).png().toFile(join(mcpbDir, 'icon.png'))

const built = join(root, 'app', 'resources', 'mcp', 'server.cjs')
if (!existsSync(built)) throw new Error(`build the MCP server first (npm run build:mcp): ${built}`)
mkdirSync(join(mcpbDir, 'server'), { recursive: true })
copyFileSync(built, join(mcpbDir, 'server', 'server.cjs'))

mkdirSync(join(root, 'dist'), { recursive: true })
const out = join(root, 'dist', `ClaudeLift-${version}.mcpb`)
execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', mcpbDir, out], { stdio: 'inherit', shell: true })
console.log(`\npacked ${out}`)
