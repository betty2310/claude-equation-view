// TeX -> SVG (MathJax) -> PNG (resvg), sized to a whole number of terminal cells.
//
// Claude Code scales an Image to fill its box of cells, so the PNG's canvas is
// made exactly `columns * cellW` by `rows * cellH` pixels: the terminal then
// draws it 1:1 and the glyphs are not resampled.

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { Resvg } from '@resvg/resvg-js'

export type RenderOptions = {
  /** One terminal cell in device pixels: [width, height]. */
  cell: [number, number]
  /** Equation color, any CSS color resvg reads. */
  fg: string
  /** Math size relative to the terminal font; 1 matches it. */
  scale: number
  /** The widest box allowed, in cells; a wider equation is scaled down. */
  maxColumns: number
  /**
   * Moves inline math up (negative) or down, as a share of the cell height,
   * for a terminal font whose baseline is not where the default expects it.
   */
  baselineShift?: number
}

export type Rendered =
  | { ok: true; png: string; columns: number; rows: number; width: number; height: number }
  | { ok: false; error: string }

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

// `physics` redefines \div and friends, and `bussproofs`/`colorv2` clash with
// the defaults; the rest of AllPackages is what a chat reply may use.
const packages = AllPackages.filter(
  name => name !== 'physics' && name !== 'bussproofs' && name !== 'colorv2',
)
const document = mathjax.document('', {
  InputJax: new TeX({ packages, formatError: (_jax: unknown, err: Error) => { throw err } }),
  OutputJax: new SVG({ fontCache: 'none' }),
})

// A monospace cell is about 0.6em wide, which gives the terminal's font size
// without trusting the cell height (line spacing varies between setups).
const CELL_WIDTH_IN_EM = 0.6
// MathJax's SVG output sizes in ex with 1ex = 0.5em unless told otherwise.
const EX_IN_EM = 0.5
// Room above and below the ink, as a share of one cell's height in total.
const VERTICAL_PAD = 0.2
// Where a terminal draws its text baseline: the cell's middle, plus half the
// difference between the font's ascent and descent (0.33 to 0.36em for the
// usual monospace fonts).
const BASELINE_BELOW_MIDDLE_IN_EM = 0.35
const MAX_CELLS = 255

function typeset(tex: string, display: boolean) {
  const node = document.convert(tex, { display })
  const svg = adaptor.innerHTML(node)
  const width = Number(/\bwidth="([\d.]+)ex"/.exec(svg)?.[1])
  const height = Number(/\bheight="([\d.]+)ex"/.exec(svg)?.[1])
  // How far the ink reaches below the baseline, which inline math sits on.
  const depth = -Number(/vertical-align:\s*(-?[\d.]+)ex/.exec(svg)?.[1] ?? 0)
  const viewBox = /\bviewBox="([^"]+)"/.exec(svg)?.[1]
  const body = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'))
  if (!(width > 0) || !(height > 0) || viewBox === undefined) {
    throw new Error('MathJax returned an SVG without a size')
  }

  return { width, height, depth, viewBox, body }
}

export function render(tex: string, display: boolean, options: RenderOptions): Rendered {
  const [cellW, cellH] = options.cell
  if (!(cellW >= 1) || !(cellH >= 1)) return { ok: false, error: 'bad cell size' }

  let svg: ReturnType<typeof typeset>
  try {
    svg = typeset(tex, display)
  } catch (err) {
    // MathJax throws a TexError, which is not an Error but carries `message`.
    const message = (err as { message?: unknown } | null)?.message

    return { ok: false, error: typeof message === 'string' ? message : String(err) }
  }

  const maxColumns = Math.min(MAX_CELLS, Math.max(1, Math.floor(options.maxColumns)))
  let exPx = (cellW / CELL_WIDTH_IN_EM) * options.scale * EX_IN_EM
  let inkW = svg.width * exPx
  const widest = maxColumns * cellW
  if (inkW > widest) {
    exPx *= widest / inkW
    inkW = widest
  }
  let inkH = svg.height * exPx

  const columnsFor = (ink: number): number =>
    Math.min(maxColumns, Math.max(1, Math.ceil(ink / cellW - 1e-6)))
  let columns: number
  let rows: number
  let left: number
  let top: number
  if (display) {
    // Display math: as many rows as it needs, at the left, centered vertically.
    columns = columnsFor(inkW)
    rows = Math.min(MAX_CELLS, Math.max(1, Math.ceil((inkH + VERTICAL_PAD * cellH) / cellH - 1e-6)))
    left = 0
    top = (rows * cellH - inkH) / 2
  } else {
    // Inline math: one row, so it flows with the words, on the text's baseline.
    if (inkH > cellH) {
      const shrink = cellH / inkH
      exPx *= shrink
      inkW *= shrink
      inkH = cellH
    }
    columns = columnsFor(inkW)
    rows = 1
    left = (columns * cellW - inkW) / 2
    const baseline =
      cellH / 2 +
      BASELINE_BELOW_MIDDLE_IN_EM * (cellW / CELL_WIDTH_IN_EM) +
      (options.baselineShift ?? 0) * cellH
    const ascent = (svg.height - svg.depth) * exPx
    top = Math.min(Math.max(0, baseline - ascent), cellH - inkH)
  }
  const width = columns * cellW
  const height = rows * cellH

  const framed =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<svg x="${left.toFixed(3)}" y="${top.toFixed(3)}" width="${inkW.toFixed(3)}" height="${inkH.toFixed(3)}" ` +
    `viewBox="${svg.viewBox}" color="${escapeAttribute(options.fg)}">${svg.body}</svg></svg>`

  try {
    const image = new Resvg(framed, { font: { loadSystemFonts: false } }).render()

    return {
      ok: true,
      png: Buffer.from(image.asPng()).toString('base64'),
      columns,
      rows,
      width: image.width,
      height: image.height,
    }
  } catch (err) {
    return { ok: false, error: `rasterize: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, '')
}
