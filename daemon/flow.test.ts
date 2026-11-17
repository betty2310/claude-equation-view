import { expect, test } from 'bun:test'

import { inlineMathOf, layoutBlocks, tokenize } from '../mod/hooks/flow.ts'

const mathIn = (text: string) =>
  tokenize(text).flatMap(atom => atom.pieces.flatMap(piece => (piece.kind === 'math' ? [piece.tex] : [])))

test('inline math in both spellings', () => {
  expect(mathIn('for $a \\neq 0$ and \\(x^2\\) here')).toEqual(['a \\neq 0', 'x^2'])
  expect(mathIn('the set $\\{x : x > 0\\}$.')).toEqual(['\\{x : x > 0\\}'])
})

test('money, shell variables and code are not math', () => {
  expect(mathIn('costs $5 and $10 today')).toEqual([])
  expect(mathIn('between $5-$10, or US$5')).toEqual([])
  expect(mathIn('set $HOME/$USER and $PATH')).toEqual([])
  expect(mathIn('run `echo $x and $y` now')).toEqual([])
  expect(mathIn('escaped \\$x$ stays')).toEqual([])
  expect(mathIn('unclosed $x^2 while streaming')).toEqual([])
})

test('math sticks to the punctuation around it', () => {
  const atoms = tokenize('so ($x$), then')
  expect(atoms.map(atom => atom.pieces.length)).toEqual([1, 3, 1])
  expect(atoms[1]!.isSpaced).toBe(true)
  expect(atoms.at(-1)!.isSpaced).toBe(false)
})

test('emphasis and code spans carry their style', () => {
  const pieces = tokenize('**Energy:** *fast* `a b` plain').flatMap(atom => atom.pieces)
  expect(pieces).toEqual([
    { kind: 'text', text: 'Energy:', style: { bold: true } },
    { kind: 'text', text: 'fast', style: { italic: true } },
    { kind: 'text', text: 'a b', style: { code: true } },
    { kind: 'text', text: 'plain', style: {} },
  ])
  expect(tokenize('a * b and snake_case_name').flatMap(atom => atom.pieces).every(p => p.kind === 'text' && !p.style.italic)).toBe(true)
})

test('only blocks with inline math leave Markdown', () => {
  const blocks = layoutBlocks(
    ['Plain paragraph.', '', 'With $x$ math', 'on two lines.', '', '| a | $b$ |', '|---|---|', '', '```', '$x$', '```'].join('\n'),
  )
  expect(blocks.map(block => block.kind)).toEqual(['native', 'flow', 'native'])
  expect(inlineMathOf(blocks)).toEqual(['x'])
  expect(blocks[2]).toEqual({ kind: 'native', text: '| a | $b$ |\n|---|---|\n\n```\n$x$\n```' })
})

test('a list keeps its markers and joins continuation lines', () => {
  const [block] = layoutBlocks('- first $a$\n  continues\n2. second $b$')
  expect(block!.kind).toBe('flow')
  if (block!.kind !== 'flow') return
  expect(block.lines.map(line => line.prefix)).toEqual(['- ', '2. '])
  expect(block.lines[0]!.atoms.at(-1)!.pieces[0]).toEqual({ kind: 'text', text: 'continues', style: {} })
})

test('a heading with math is a bold flow line', () => {
  const [block] = layoutBlocks('## The case $n = 2$')
  expect(block!.kind === 'flow' && block.lines[0]!.isHeading).toBe(true)
})
