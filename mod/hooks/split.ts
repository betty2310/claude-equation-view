// Splits a reply's markdown into prose and display equations.
//
// This runs on the raw markdown, before any markdown parser: a parser unescapes
// `\[`, `\,` and `\\`, and after that the TeX cannot be recovered.

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; source: string }

const ENVIRONMENTS = ['equation', 'align', 'gather', 'multline', 'alignat', 'eqnarray', 'flalign']
const BEGIN = new RegExp(String.raw`\\begin\{((?:${ENVIRONMENTS.join('|')})\*?)\}`, 'y')
const LONGEST = 8000

/** A cheap test that skips the split for the usual reply, which has no math. */
export function mayHoldMath(markdown: string): boolean {
  return markdown.includes('$$') || markdown.includes('\\[') || markdown.includes('\\begin{')
}

export function splitMath(markdown: string): Part[] {
  const parts: Part[] = []
  let textStart = 0
  let at = 0
  let isLineStart = true

  const pushMath = (from: number, to: number, tex: string): void => {
    const before = markdown.slice(textStart, from)
    if (before.trim() !== '') parts.push({ kind: 'text', text: before.replace(/\s+$/, '') })
    parts.push({ kind: 'math', tex: tex.trim(), source: markdown.slice(from, to) })
    textStart = to
    at = to
  }

  while (at < markdown.length) {
    const char = markdown[at]

    // A fenced code block: skip to its closing fence, or to the end.
    if (isLineStart) {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(markdown.slice(at, at + 16))
      if (fence !== null) {
        const mark = fence[1]![0]!
        const close = new RegExp(`^ {0,3}${mark}{${fence[1]!.length},}[ \\t]*$`, 'm')
        const bodyStart = markdown.indexOf('\n', at)
        if (bodyStart === -1) break
        const found = close.exec(markdown.slice(bodyStart + 1))
        if (found === null) break
        at = bodyStart + 1 + found.index + found[0].length
        isLineStart = false
        continue
      }
    }

    if (char === '\n') {
      isLineStart = true
      at += 1
      continue
    }
    if (char !== ' ' && char !== '\t') isLineStart = false

    // Inline code: skip to the matching run of backticks.
    if (char === '`') {
      let run = 1
      while (markdown[at + run] === '`') run += 1
      const end = markdown.indexOf('`'.repeat(run), at + run)
      at = end === -1 ? at + run : end + run
      continue
    }

    if (char === '\\') {
      const next = markdown[at + 1]
      if (next === '[') {
        const end = markdown.indexOf('\\]', at + 2)
        if (end !== -1 && end - at <= LONGEST && markdown[end - 1] !== '\\') {
          pushMath(at, end + 2, markdown.slice(at + 2, end))
          continue
        }
      }
      if (next === 'b') {
        BEGIN.lastIndex = at
        const begin = BEGIN.exec(markdown)
        if (begin !== null) {
          const closer = `\\end{${begin[1]}}`
          const end = markdown.indexOf(closer, at + begin[0].length)
          if (end !== -1 && end - at <= LONGEST) {
            const to = end + closer.length
            pushMath(at, to, markdown.slice(at, to))
            continue
          }
        }
      }
      // An escaped character, `\$` included, is never an opener. A backslash
      // that ends a line leaves the newline to be seen as one.
      at += next === '\n' ? 1 : 2
      continue
    }

    if (char === '$' && markdown[at + 1] === '$') {
      const end = markdown.indexOf('$$', at + 2)
      const inner = end === -1 ? '' : markdown.slice(at + 2, end)
      if (end !== -1 && end - at <= LONGEST && inner.trim() !== '') {
        pushMath(at, end + 2, inner)
        continue
      }
      at += 2
      continue
    }

    at += 1
  }

  const rest = markdown.slice(textStart)
  if (rest.trim() !== '') {
    parts.push({ kind: 'text', text: parts.length === 0 ? rest : rest.replace(/^\s*\n/, '') })
  }

  return parts
}
