// Lays out the prose between display equations when it holds inline math.
//
// A `Markdown` element is a leaf, so an image cannot sit inside one. A
// paragraph, heading or list that holds `$...$` or `\(...\)` is therefore
// drawn by the mod itself: its words and its inline images are items of a
// wrapping row. Every other block (code, tables, quotes, and any block with no
// inline math) is handed to `Markdown` untouched.

export type Style = {
  bold?: true
  italic?: true
  strike?: true
  code?: true
  href?: string
}

export type Piece =
  | { kind: 'text'; text: string; style: Style }
  | { kind: 'math'; tex: string; source: string }

/** Pieces with no whitespace between them: they wrap as one. */
export type Atom = { pieces: Piece[]; isSpaced: boolean }

export type Line = { prefix: string; isHeading: boolean; atoms: Atom[] }

export type Block =
  | { kind: 'native'; text: string }
  /** `source` is the block's markdown, drawn when none of its math typesets. */
  | { kind: 'flow'; lines: Line[]; source: string }

const WORD = /[A-Za-z0-9]/
const WORD_OR_UNDERSCORE = /[A-Za-z0-9_]/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LONGEST_INLINE = 1000

/** Where the inline math that opens at `open` (a `$`) closes, or -1. */
function closingDollar(text: string, open: number): number {
  const first = text[open + 1]
  if (first === undefined || first === '$' || /\s/.test(first)) return -1
  // `US$5` is money, not math.
  if (open > 0 && WORD.test(text[open - 1]!)) return -1

  for (let at = open + 1; at < text.length && at - open <= LONGEST_INLINE; at += 1) {
    const char = text[at]
    if (char === '\\') {
      at += 1
      continue
    }
    if (char === '\n' && text[at + 1] === '\n') return -1
    if (char !== '$') continue
    // A closer has no space before it and no word after it: `$5 and $10`,
    // `$HOME/$USER` and `$5-$10` are all left alone.
    const after = text[at + 1]
    if (/\s/.test(text[at - 1]!) || (after !== undefined && WORD_OR_UNDERSCORE.test(after))) {
      return -1
    }

    return at
  }

  return -1
}

export function tokenize(text: string): Atom[] {
  const atoms: Atom[] = []
  let pieces: Piece[] = []
  const style: Style = {}

  const endAtom = (isSpaced: boolean): void => {
    if (pieces.length > 0) atoms.push({ pieces, isSpaced })
    else if (isSpaced && atoms.length > 0) atoms[atoms.length - 1]!.isSpaced = true
    pieces = []
  }
  const addText = (chars: string, extra?: Style): void => {
    const merged = { ...style, ...extra }
    const last = pieces.at(-1)
    if (last?.kind === 'text' && sameStyle(last.style, merged)) last.text += chars
    else pieces.push({ kind: 'text', text: chars, style: merged })
  }
  const toggle = (name: 'bold' | 'italic' | 'strike'): void => {
    if (style[name]) delete style[name]
    else style[name] = true
  }

  let at = 0
  while (at < text.length) {
    const char = text[at]!
    const next = text[at + 1]

    if (/\s/.test(char)) {
      endAtom(true)
      at += 1
      continue
    }

    if (char === '\\') {
      if (next === '(') {
        const end = text.indexOf('\\)', at + 2)
        if (end !== -1 && end - at <= LONGEST_INLINE) {
          pieces.push({ kind: 'math', tex: text.slice(at + 2, end).trim(), source: text.slice(at, end + 2) })
          at = end + 2
          continue
        }
      }
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        addText(next)
        at += 2
        continue
      }
      addText(char)
      at += 1
      continue
    }

    if (char === '$') {
      const end = closingDollar(text, at)
      if (end !== -1) {
        pieces.push({ kind: 'math', tex: text.slice(at + 1, end).trim(), source: text.slice(at, end + 1) })
        at = end + 1
        continue
      }
      addText(char)
      at += 1
      continue
    }

    if (char === '`') {
      let run = 1
      while (text[at + run] === '`') run += 1
      const end = text.indexOf('`'.repeat(run), at + run)
      if (end !== -1) {
        // A code span keeps its spaces, so it is one piece that does not wrap.
        addText(text.slice(at + run, end).replace(/\n/g, ' '), { code: true })
        at = end + run
        continue
      }
      addText(text.slice(at, at + run))
      at += run
      continue
    }

    if ((char === '*' || char === '_') && next === char) {
      if (style.bold || text.indexOf(char + char, at + 2) !== -1) {
        toggle('bold')
        at += 2
        continue
      }
    }
    if (char === '~' && next === '~') {
      if (style.strike || text.indexOf('~~', at + 2) !== -1) {
        toggle('strike')
        at += 2
        continue
      }
    }
    if (char === '*' || char === '_') {
      const before = text[at - 1]
      const isOpener =
        !style.italic &&
        next !== undefined &&
        !/\s/.test(next) &&
        text.indexOf(char, at + 1) !== -1 &&
        (char === '*' || before === undefined || !WORD.test(before))
      const isCloser =
        style.italic === true &&
        before !== undefined &&
        !/\s/.test(before) &&
        (char === '*' || next === undefined || !WORD.test(next))
      if (isOpener || isCloser) {
        toggle('italic')
        at += 1
        continue
      }
    }

    if (char === '[') {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(at, at + 2100))
      if (link !== null) {
        const words = link[1]!.split(/\s+/)
        words.forEach((word, index) => {
          addText(word, { href: link[2]! })
          if (index < words.length - 1) endAtom(true)
        })
        at += link[0].length
        continue
      }
    }

    addText(char)
    at += 1
  }
  endAtom(false)

  return atoms
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.href === b.href
  )
}

function holdsMath(atoms: Atom[]): boolean {
  return atoms.some(atom => atom.pieces.some(piece => piece.kind === 'math'))
}

/** A cheap test before any tokenizing. */
export function mayHoldInlineMath(text: string): boolean {
  return text.includes('$') || text.includes('\\(')
}

export function layoutBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const native = (text: string): void => {
    const last = blocks.at(-1)
    if (last?.kind === 'native') last.text += `\n\n${text}`
    else blocks.push({ kind: 'native', text })
  }
  /** Draws the lines as a flow when any holds inline math, else leaves them. */
  const settle = (source: string[], lines: Array<{ prefix: string; isHeading: boolean; text: string }>): void => {
    const raw = source.join('\n')
    if (!mayHoldInlineMath(raw)) return native(raw)
    const laid = lines.map(line => ({
      prefix: line.prefix,
      isHeading: line.isHeading,
      atoms: tokenize(line.text),
    }))
    if (!laid.some(line => holdsMath(line.atoms))) return native(raw)
    blocks.push({ kind: 'flow', lines: laid, source: raw })
  }

  const lines = markdown.split('\n')
  let at = 0
  while (at < lines.length) {
    const line = lines[at]!
    if (line.trim() === '') {
      at += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`)
      let end = at + 1
      while (end < lines.length && !close.test(lines[end]!)) end += 1
      native(lines.slice(at, end + 1).join('\n'))
      at = end + 1
      continue
    }

    // Tables and quotes are the terminal's own to draw.
    const kept = /^\s*(\||>)/.exec(line)?.[1]
    if (kept !== undefined) {
      let end = at
      while (end < lines.length && lines[end]!.trimStart().startsWith(kept)) end += 1
      native(lines.slice(at, end).join('\n'))
      at = end
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      settle([line], [{ prefix: '', isHeading: true, text: heading[2]! }])
      at += 1
      continue
    }

    if (LIST_ITEM.test(line)) {
      const items: Array<{ prefix: string; isHeading: boolean; text: string }> = []
      let end = at
      while (end < lines.length && lines[end]!.trim() !== '' && !FENCE.test(lines[end]!)) {
        const item = LIST_ITEM.exec(lines[end]!)
        if (item !== null) {
          const marker = /^\d/.test(item[2]!) ? item[2]! : '-'
          items.push({ prefix: `${item[1]!.replace(/\t/g, '  ')}${marker} `, isHeading: false, text: item[3]! })
        } else {
          items[items.length - 1]!.text += ` ${lines[end]!.trim()}`
        }
        end += 1
      }
      settle(lines.slice(at, end), items)
      at = end
      continue
    }

    let end = at
    while (
      end < lines.length &&
      lines[end]!.trim() !== '' &&
      (end === at ||
        !(FENCE.test(lines[end]!) || HEADING.test(lines[end]!) || LIST_ITEM.test(lines[end]!) || /^\s*(\||>)/.test(lines[end]!)))
    ) {
      end += 1
    }
    const paragraph = lines.slice(at, end)
    settle(paragraph, [{ prefix: '', isHeading: false, text: paragraph.map(one => one.trim()).join(' ') }])
    at = end
  }

  return blocks
}

/** The TeX of every inline equation in the blocks, for one typesetting call. */
export function inlineMathOf(blocks: Block[]): string[] {
  const all: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'flow') continue
    for (const line of block.lines) {
      for (const atom of line.atoms) {
        for (const piece of atom.pieces) if (piece.kind === 'math') all.push(piece.tex)
      }
    }
  }

  return all
}
