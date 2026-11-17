import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import { inlineMathOf, layoutBlocks, type Atom, type Block, type Line, type Piece } from './flow'
import { splitMath } from './split'

type Picture = { png: string; columns: number; rows: number }
type Outcome = Picture | { error: string }
type Cell = [width: number, height: number]
type Wanted = { tex: string; display: boolean }

/** One stretch of a reply, top to bottom, as it will be drawn. */
type Segment =
  | { kind: 'native'; text: string }
  | { kind: 'display'; tex: string; picture: Picture }
  | { kind: 'flow'; lines: Line[] }

const SAMPLE = String.raw`Inline math flows with the words: for $a \neq 0$ the roots of $ax^2 + bx + c = 0$ are given below, and the sum $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$ stays on its line. Money such as $5 and $10 is left alone. A long paragraph has to wrap between words and never inside an equation, so this sentence keeps going past the pane's right edge with $e^{i\pi} + 1 = 0$, then $\int_0^1 x^2\,dx = \tfrac{1}{3}$, then $\lim_{n \to \infty} \left(1 + \tfrac{1}{n}\right)^n = e$, and a last few plain words to finish the line.

$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

- **Energy:** $E = mc^2$, with $c$ the speed of light.
- *Complexity:* sorting takes $\mathcal{O}(n \log n)$ comparisons.

A matrix inverse:

\[
\begin{pmatrix} a & b \\ c & d \end{pmatrix}^{-1} = \frac{1}{ad-bc}\begin{pmatrix} d & -b \\ -c & a \end{pmatrix}
\]

One that does not parse stays as source:

$$\frac{a}{b$$`

const FALLBACK_CELL: Cell = [8, 17]
const KEPT = 800

// Module variables start over on a reload; everything here can be rebuilt.
let socket: string | undefined
let cell: Cell | undefined
let isOn = true
let isInlineOn = true
let fg = '#e6e6e6'
let scale = 1
let baselineShift = 0
let measuredFor = ''
let lastError = ''
const pictures = new Map<string, Outcome>()

function keyOf(tex: string, display: boolean, maxColumns: number): string {
  return `${display ? 'd' : 'i'}|${cell?.join('x')}|${fg}|${scale}|${baselineShift}|${maxColumns}|${tex}`
}

function pictureOf(tex: string, display: boolean, maxColumns: number): Picture | undefined {
  const outcome = pictures.get(keyOf(tex, display, maxColumns))

  return outcome !== undefined && 'png' in outcome ? outcome : undefined
}

function remember(key: string, outcome: Outcome): void {
  pictures.set(key, outcome)
  if (pictures.size > KEPT) {
    const oldest = pictures.keys().next().value
    if (oldest !== undefined) pictures.delete(oldest)
  }
}

/** Starts the renderer as a child of this session and waits for its socket. */
async function runDaemon($: EngineInterface): Promise<void> {
  const script = `${$.plugin.root}/../daemon/eqd.ts`
  let seen = ''
  try {
    const child = $.process.spawn({ argv: ['bun', script] })
    for await (const { stream, text } of child) {
      if (stream !== 'stdout' || socket !== undefined) continue
      seen += text
      const ready = /^EQD_READY (.+)$/m.exec(seen)
      if (ready !== null) {
        socket = (JSON.parse(ready[1]!) as { socket: string }).socket
        $.ui.invalidate('ui.render')
      }
    }
    lastError = 'the renderer exited'
  } catch (err) {
    lastError = `the renderer did not start: ${err instanceof Error ? err.message : String(err)}`
  }
  socket = undefined
}

/** Asks Rex for this pane's cell size in pixels. */
async function measureCell($: EngineInterface): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['sh', '-c', 'rex block call -s "$REX_SESSION" -b "$REX_BLOCK" size'],
      { timeoutMs: 5000 },
    )
    const size = exitCode === 0 ? (JSON.parse(stdout) as Record<string, unknown>) : {}
    const width = Number(size.cell_width_px)
    const height = Number(size.cell_height_px)
    const measured: Cell = width >= 1 && height >= 1 ? [width, height] : FALLBACK_CELL
    if (cell?.[0] !== measured[0] || cell?.[1] !== measured[1]) {
      cell = measured
      $.ui.invalidate('ui.render')
    }
  } catch {
    cell ??= FALLBACK_CELL
  }
}

/** Typesets every equation not yet kept, in one request. */
async function typeset($: EngineInterface, wanted: Wanted[], maxColumns: number): Promise<void> {
  const missing = new Map<string, Wanted>()
  for (const one of wanted) {
    const key = keyOf(one.tex, one.display, maxColumns)
    if (!pictures.has(key)) missing.set(key, one)
  }
  if (missing.size === 0 || socket === undefined || cell === undefined) return

  const response = await $.http.fetch('http://eqd/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [...missing.values()], cell, fg, scale, maxColumns, baselineShift }),
    socketPath: socket,
  })
  if (!response.ok) throw new Error(`eqd answered ${response.status}`)

  const results = JSON.parse(response.text) as Array<
    ({ ok: true } & Picture) | { ok: false; error: string }
  >
  ;[...missing.keys()].forEach((key, index) => {
    const result = results[index]
    if (result === undefined) return
    remember(
      key,
      result.ok
        ? { png: result.png, columns: result.columns, rows: result.rows }
        : { error: result.error },
    )
  })
}

function flowHasPicture(block: Extract<Block, { kind: 'flow' }>, maxColumns: number): boolean {
  return inlineMathOf([block]).some(tex => pictureOf(tex, false, maxColumns) !== undefined)
}

/**
 * Splits a reply into what the terminal draws itself and what the mod draws,
 * typesetting on the way. Undefined when no equation came out as a picture, so
 * the caller leaves the reply to the engine.
 */
async function compose(
  $: EngineInterface,
  markdown: string,
  maxColumns: number,
): Promise<Segment[] | undefined> {
  const parts = splitMath(markdown)
  const prose = parts.map(part =>
    part.kind === 'text' && isInlineOn ? layoutBlocks(part.text) : undefined,
  )
  const wanted: Wanted[] = []
  parts.forEach((part, index) => {
    if (part.kind === 'math') wanted.push({ tex: part.tex, display: true })
    for (const tex of inlineMathOf(prose[index] ?? [])) wanted.push({ tex, display: false })
  })
  if (wanted.length === 0) return undefined
  await typeset($, wanted, maxColumns)

  const segments: Segment[] = []
  let drawn = 0
  const native = (text: string): void => {
    const last = segments.at(-1)
    if (last?.kind === 'native') last.text += `\n\n${text}`
    else segments.push({ kind: 'native', text })
  }
  parts.forEach((part, index) => {
    if (part.kind === 'math') {
      const picture = pictureOf(part.tex, true, maxColumns)
      if (picture === undefined) return native(part.source)
      segments.push({ kind: 'display', tex: part.tex, picture })
      drawn += 1

      return
    }
    const blocks = prose[index]
    if (blocks === undefined) return native(part.text)
    for (const block of blocks) {
      if (block.kind === 'flow' && flowHasPicture(block, maxColumns)) {
        segments.push({ kind: 'flow', lines: block.lines })
        drawn += 1
      } else {
        native(block.kind === 'flow' ? block.source : block.text)
      }
    }
  })

  return drawn === 0 ? undefined : segments
}

/**
 * The tree for a reply's segments: display equations and prose with inline
 * equations as the mod lays them out, everything else as `Markdown`.
 */
function draw(
  ui: Elements['terminal'],
  segments: Segment[],
  maxColumns: number,
  options: { opening?: RenderElement; bullet: string; marginTop?: number },
): RenderElement {
  const { Box, Image, Markdown, Text } = ui
  let images = 0

  const picture = (shown: Picture, alt: string) => {
    images += 1

    return (
      <Image
        key={`eq-${images}`}
        source={{ png: shown.png }}
        columns={shown.columns}
        rows={shown.rows}
        alt={alt}
      />
    )
  }

  const drawPiece = (piece: Piece, isHeading: boolean) => {
    if (piece.kind === 'math') {
      const shown = pictureOf(piece.tex, false, maxColumns)

      return shown === undefined ? <Text>{piece.source}</Text> : picture(shown, piece.source)
    }
    const { style } = piece

    return (
      <Text
        bold={style.bold === true || isHeading}
        italic={style.italic === true}
        strikethrough={style.strike === true}
        underline={style.href !== undefined}
        {...(style.code === true ? { color: 'permission' } : {})}
      >
        {piece.text}
      </Text>
    )
  }

  // An atom is the unit that wraps; the space after it rides along.
  const drawAtom = (atom: Atom, isHeading: boolean) => (
    <Box flexDirection="row" flexShrink={0}>
      {atom.pieces.map(piece => drawPiece(piece, isHeading))}
      {atom.isSpaced ? <Text> </Text> : null}
    </Box>
  )

  const drawFlow = (lines: Line[], lead: string) =>
    lines.map((line, index) => (
      <Box flexDirection="row">
        <Text>{(index === 0 ? lead : '  ') + line.prefix}</Text>
        <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>
          {line.atoms.map(atom => drawAtom(atom, line.isHeading))}
        </Box>
      </Box>
    ))

  return (
    <Box flexDirection="column" marginTop={options.opening === undefined ? (options.marginTop ?? 0) : 0}>
      {options.opening ?? null}
      {segments.map((segment, index) => {
        const isTop = options.opening === undefined && index === 0
        const lead = isTop ? options.bullet : '  '
        const marginTop = isTop ? 0 : 1
        if (segment.kind === 'flow') {
          return (
            <Box flexDirection="column" marginTop={marginTop}>
              {drawFlow(segment.lines, lead)}
            </Box>
          )
        }

        return (
          <Box flexDirection="row" marginTop={marginTop}>
            <Text>{lead}</Text>
            {segment.kind === 'native' ? (
              <Markdown text={segment.text} />
            ) : (
              picture(segment.picture, segment.tex)
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'eq',
      description:
        'Equation images: /eq on, off, inline on|off, test, status, color #rrggbb, scale 1.2, baseline -0.05',
    })
    void runDaemon($)
    void measureCell($)

    return started
  })

  on('command.run', { command: 'eq' }, async ($, e) => {
    const [verb = 'status', value = ''] = e.args.trim().split(/\s+/)
    if (verb === 'test') return { text: SAMPLE }
    if (verb === 'on' || verb === 'off') isOn = verb === 'on'
    if (verb === 'inline' && (value === 'on' || value === 'off')) isInlineOn = value === 'on'
    if (verb === 'color' && /^#[0-9a-fA-F]{3,8}$/.test(value)) fg = value
    if (verb === 'scale' && Number(value) > 0.2 && Number(value) < 5) scale = Number(value)
    if (verb === 'baseline' && Math.abs(Number(value)) <= 0.5) baselineShift = Number(value)
    if (verb === 'measure') await measureCell($)
    $.ui.invalidate('ui.render')

    return {
      text:
        `eqview is ${isOn ? 'on' : 'off'}, inline math ${isInlineOn ? 'on' : 'off'}. ` +
        `Renderer: ${socket === undefined ? `not running (${lastError || 'starting'})` : 'running'}. ` +
        `Cell: ${cell === undefined ? 'not measured' : `${cell[0]} x ${cell[1]} px`}. ` +
        `Color ${fg}, scale ${scale}, baseline ${baselineShift}, ${pictures.size} equations kept.`,
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const markdown = e.props.text
    if (!isOn || e.surface !== 'terminal') return next(e)
    if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[') && !markdown.includes('\\begin{')) {
      return next(e)
    }

    // A change of font size changes the pane's columns and rows: measure again.
    const shape = `${e.viewport?.columns}x${e.viewport?.rows}`
    if (shape !== measuredFor) {
      measuredFor = shape
      void measureCell($)
    }
    if (socket === undefined || cell === undefined) return next(e)

    const maxColumns = Math.max(20, Math.min(255, (e.viewport?.columns ?? 80) - 6))
    let segments: Segment[] | undefined
    try {
      segments = await compose($, markdown, maxColumns)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      $.ui.log(`eqview: ${lastError}`, { to: 'debug' })
    }
    if (segments === undefined) return next(e)

    // The engine draws opening prose itself, so the reply keeps its own look.
    const [first] = segments
    const opening =
      first !== undefined && first.kind === 'native'
        ? await next({ ...e, props: { ...e.props, text: first.text } })
        : undefined

    return draw($.ui.resolve(e), opening === undefined ? segments : segments.slice(1), maxColumns, {
      opening,
      bullet: e.props.isFirstOfReply ? '⏺ ' : '  ',
      // The engine sets its own block one row below what came before it.
      marginTop: 1,
    })
  })

  // `/eq test` draws its sample through the same pipeline, with no model call.
  on('ui.render', { component: 'CommandOutput', props: { command: 'eq' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || socket === undefined || cell === undefined) return next(e)
    if (!e.props.text.includes('$$')) return next(e)

    const maxColumns = Math.max(20, Math.min(255, (e.viewport?.columns ?? 80) - 6))
    try {
      const segments = await compose($, e.props.text, maxColumns)
      if (segments === undefined) return next(e)

      return draw($.ui.resolve(e), segments, maxColumns, { bullet: '  ' })
    } catch {
      return next(e)
    }
  })
}
