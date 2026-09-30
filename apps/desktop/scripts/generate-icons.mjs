/**
 * Render the app icon from icons/icon.svg (icons/icon-small.svg at 24 px and
 * below, where the master's lines would blur) into:
 * - icons/icon.ico: the Windows exe, installer and taskbar icon (BMP entries up
 *   to 64 px for every Windows shell, a PNG entry at 256 px);
 * - icons/icon.png: 1024 px, for macOS and Linux packaging;
 * - the web favicon and install icons in apps/web/public.
 *
 * Run from the repository root: node apps/desktop/scripts/generate-icons.mjs
 */
import { createRequire } from 'node:module'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(desktop, '..', 'web')
// Chromium is installed for the web browser tests; the desktop package keeps no dependency of its own on it.
const { chromium } = createRequire(join(web, 'package.json'))('playwright')

/** Sizes in the Windows icon; the shell picks the nearest one for each place it draws the icon. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
/** Up to this size the small variant is drawn. */
const SMALL_MAX = 24
/** Above this size the entry is stored as PNG. */
const BMP_MAX = 64

/**
 * Draw one SVG at one size in the browser.
 * @param {import('playwright').Page} page - A blank page.
 * @param {string} svg - The SVG source.
 * @param {number} size - Edge length in pixels.
 * @param {boolean} pixels - Whether to return straight-alpha RGBA as well.
 * @returns {Promise<{ png: Buffer, rgba?: Uint8Array }>} The PNG, and the pixels when asked.
 */
async function render(page, svg, size, pixels) {
  const drawn = await page.evaluate(async ({ source, edge, withPixels }) => {
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = edge
    canvas.height = edge
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, edge, edge)
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      rgba: withPixels ? Array.from(context.getImageData(0, 0, edge, edge).data) : undefined,
    }
  }, { source: svg, edge: size, withPixels: pixels })
  return { png: Buffer.from(drawn.png, 'base64'), ...(drawn.rgba ? { rgba: Uint8Array.from(drawn.rgba) } : {}) }
}

/**
 * A 32-bit BMP icon entry: bottom-up BGRA rows, then an all-clear AND mask so the alpha channel decides.
 * @param {Uint8Array} rgba - Straight-alpha pixels, top row first.
 * @param {number} size - Edge length in pixels.
 * @returns {Buffer} The entry bytes.
 */
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

/**
 * The ICO container around the entries, smallest first.
 * @param {{ size: number, data: Buffer }[]} entries - One image per size.
 * @returns {Buffer} The .ico file.
 */
function icoFile(entries) {
  const directory = Buffer.alloc(6 + 16 * entries.length)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  entries.forEach((entry, index) => {
    const at = 6 + 16 * index
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([directory, ...entries.map(entry => entry.data)])
}

const master = await readFile(join(desktop, 'icons', 'icon.svg'), 'utf8')
const small = await readFile(join(desktop, 'icons', 'icon-small.svg'), 'utf8')
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const entries = []
  for (const size of ICO_SIZES) {
    const drawn = await render(page, size <= SMALL_MAX ? small : master, size, size <= BMP_MAX)
    entries.push({ size, data: size <= BMP_MAX ? bmpEntry(drawn.rgba, size) : drawn.png })
  }
  await writeFile(join(desktop, 'icons', 'icon.ico'), icoFile(entries))
  await writeFile(join(desktop, 'icons', 'icon.png'), (await render(page, master, 1024, false)).png)
  await writeFile(join(web, 'public', 'icon-192.png'), (await render(page, master, 192, false)).png)
  await writeFile(join(web, 'public', 'icon-512.png'), (await render(page, master, 512, false)).png)
  // Browser tabs draw the favicon at 16 to 32 px, where the small variant stays legible.
  await copyFile(join(desktop, 'icons', 'icon-small.svg'), join(web, 'public', 'favicon.svg'))
} finally {
  await browser.close()
}
console.log(`generate-icons: wrote icon.ico (${ICO_SIZES.join(', ')} px), icon.png and the web icons`)
