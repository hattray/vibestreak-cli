import assert from 'node:assert/strict'
import { test } from 'node:test'

import { boardQuery } from '../src/views.mjs'
import { cell, colorLevel, heatmap, pad, painter, recent, visible } from '../src/view.mjs'

test('colour follows the terminal: off for pipes and NO_COLOR, full when asked', () => {
  assert.equal(colorLevel({ isTTY: false }, {}), 0)
  assert.equal(colorLevel({ isTTY: true }, { NO_COLOR: '' }), 0)
  assert.equal(colorLevel({ isTTY: true }, { COLORTERM: 'truecolor' }), 3)
  assert.equal(colorLevel({ isTTY: true }, { WT_SESSION: 'x' }), 3)
  assert.equal(colorLevel({ isTTY: true }, { TERM: 'xterm-256color' }), 2)
  assert.equal(colorLevel({ isTTY: false }, { FORCE_COLOR: '3' }), 3)
})

test('cells: shades, shipped days marked, plain characters without colour', () => {
  const plain = painter(0)
  assert.deepEqual([-1, 0, 1, 2, 3].map(s => cell(plain, s, false)), ['· ', '░ ', '▒ ', '▓ ', '█ '])
  assert.equal(cell(plain, 3, true), '█*')
  assert.equal(visible(cell(painter(3), 2, true)), '■•')
})

test('the heatmap starts on the first active day and labels months that fit', () => {
  const days = { '2026-10-20': { messages: 5 }, '2026-10-21': { messages: 50, aiCommits: 2 }, '2026-10-24': { messages: 9 } }
  const lines = heatmap(painter(0), days, '2026-10-25', { columns: 60, first: '2026-10-20' }).split('\n')
  assert.equal(lines.length, 9)
  assert.match(lines[0], /Oct/)
  assert.match(lines.join('\n'), /█\*/)
  // Sunday the 19th, before the first active day, is blank; today (the 25th, nothing yet) is inactive.
  assert.equal(lines[1].slice(5, 7), '  ')
  assert.equal(lines[1].slice(7, 9), '· ')
})

test('a board row shows its last four weeks in one line', () => {
  const strip = [[-2, -2, 0, 1, -1, 2, 3], ...Array.from({ length: 4 }, () => [3, 3, 3, 3, 3, 3, 3]), [0, -2, -2, -2, -2, -2, -2]]
  const line = recent(painter(0), strip)
  assert.equal([...line].length, 28)
  assert.ok(line.endsWith('░'))
})

test('board words: periods, rankings and tools in any order', () => {
  assert.equal(boardQuery(['7d', 'shipped', 'claude'], {}).toString(), 'period=7d&metric=shipped&tool=claude')
  assert.equal(boardQuery([], { from: '2026-07-01', to: '2026-07-31' }).toString(), 'from=2026-07-01&to=2026-07-31')
  assert.throws(() => boardQuery(['weekly'], {}), /not a period/)
  assert.throws(() => boardQuery([], { from: '2026-07-01' }), /both --from and --to/)
})

test('padding ignores colour codes', () => {
  assert.equal(visible(pad(painter(3).bold('ab'), 5)), 'ab   ')
})
