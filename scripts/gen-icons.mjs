/**
 * gen-icons.mjs — renders the ClaudeLift icon (inline SVG: rounded-rect
 * #E2571D background, inset white border, bold white upward-out "export"
 * arrow) to multi-size .ico files:
 *
 *   app/resources/icons/app.ico   256/48/32/24/20/16
 *   app/resources/icons/tray.ico  32/24/20/16
 *
 * Run via `npm run gen:icons` inside app/. sharp and png-to-ico are
 * devDependencies of app/, so they are resolved from app/node_modules
 * explicitly (this script lives at repo-root scripts/).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptsDir)
const appDir = join(repoRoot, 'app')
const iconsDir = join(appDir, 'resources', 'icons')

const requireFromApp = createRequire(join(appDir, 'package.json'))
const sharp = requireFromApp('sharp')
// png-to-ico@3 is ESM-only; require(esm) hands back the module namespace.
const pngToIcoModule = requireFromApp('png-to-ico')
const pngToIco = pngToIcoModule.default ?? pngToIcoModule

// Flat rounded-rect in the theme primary (oklch(64% .222 41.116) ≈ #E2571D)
// with a bold white arrow lifting up off a base line — the ClaudeLift mark,
// matching the renderer nav wordmark and the splash screen.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="60" fill="#E2571D"/>
  <g fill="none" stroke="#FFFFFF" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
    <path d="M84 196 H172"/>
    <path d="M128 176 V84"/>
    <path d="M88 124 L128 84 L168 124"/>
  </g>
</svg>`

const APP_SIZES = [256, 48, 32, 24, 20, 16]
const TRAY_SIZES = [32, 24, 20, 16]

/** Rasterize the SVG at `size`×`size` (density-scaled so strokes stay crisp). */
function renderPng(size) {
  const density = Math.max(72, Math.ceil((72 * size) / 256))
  return sharp(Buffer.from(SVG), { density }).resize(size, size).png().toBuffer()
}

/** ICONDIR image count lives at byte offset 4 (uint16le). */
function icoEntryCount(path) {
  return readFileSync(path).readUInt16LE(4)
}

const pngBySize = new Map()
for (const size of new Set([...APP_SIZES, ...TRAY_SIZES])) {
  pngBySize.set(size, await renderPng(size))
}

mkdirSync(iconsDir, { recursive: true })

for (const { file, sizes } of [
  { file: 'app.ico', sizes: APP_SIZES },
  { file: 'tray.ico', sizes: TRAY_SIZES }
]) {
  const ico = await pngToIco(sizes.map((size) => pngBySize.get(size)))
  const outPath = join(iconsDir, file)
  writeFileSync(outPath, ico)
  console.log(`${outPath}  ${ico.length} bytes, ${icoEntryCount(outPath)} images (${sizes.join('/')})`)
}
