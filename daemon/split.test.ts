import { expect, test } from 'bun:test'

import { mayHoldMath, splitMath } from '../mod/hooks/split.ts'

const kinds = (markdown: string) => splitMath(markdown).map(part => part.kind)
const texOf = (markdown: string) =>
  splitMath(markdown).flatMap(part => (part.kind === 'math' ? [part.tex] : []))

test('dollar and bracket display blocks', () => {
  expect(kinds('Before\n\n$$x^2$$\n\nAfter')).toEqual(['text', 'math', 'text'])
  expect(texOf('\\[\n\\frac{a}{b} \\\\ c\n\\]')).toEqual(['\\frac{a}{b} \\\\ c'])
})

test('environments keep their begin and end', () => {
  const tex = '\\begin{align}a &= b \\\\ c &= d\\end{align}'
  expect(texOf(`See:\n${tex}\ndone`)).toEqual([tex])
})

test('code is never math', () => {
  expect(texOf('```sh\necho $$\n$$x$$\n```\nrun `echo $$ $$` now')).toEqual([])
  expect(texOf('~~~\n\\[x\\]\n~~~')).toEqual([])
})

test('an unclosed block stays prose, as while streaming', () => {
  expect(kinds('Start\n\n$$\\frac{a}{')).toEqual(['text'])
  expect(kinds('Start \\[ x')).toEqual(['text'])
})

test('escapes and line breaks are not openers', () => {
  expect(texOf('cost \\$$5 and a \\\\[2pt] break')).toEqual([])
  expect(texOf('$$a \\\\[2pt] b$$')).toEqual(['a \\\\[2pt] b'])
})

test('the source is kept exactly', () => {
  const parts = splitMath('A $$ x $$ B')
  expect(parts[1]).toEqual({ kind: 'math', tex: 'x', source: '$$ x $$' })
  expect(mayHoldMath('plain $5 text')).toBe(false)
})
