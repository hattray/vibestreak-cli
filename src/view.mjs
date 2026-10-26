import { dayKey } from './days.mjs'

// Drawing in the terminal: the site's blue heatmap in coloured squares, its
// orange for work shipped with AI, plain characters where colour is off.

const BLUES = ['#0d3a63', '#1a5fa3', '#2f81f7', '#79c0ff']
const EMPTY = '#2a323d'
const SHIP = '#f2994a'
const MUTED = '#8b949e'

// How much colour the terminal takes: none (NO_COLOR, piped output, a dumb
// terminal), 256 colours, or full colour (COLORTERM says so; Windows Terminal).
export function colorLevel(stream = process.stdout, env = process.env) {
  if ('NO_COLOR' in env) return 0
  if (env.FORCE_COLOR === '0') return 0
  if (env.FORCE_COLOR) return env.FORCE_COLOR === '1' ? 2 : 3
  if (!stream.isTTY || env.TERM === 'dumb') return 0
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '') || env.WT_SESSION) return 3
  return 2
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const to256 = ([r, g, b]) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)

export function painter(level = colorLevel()) {
  const fg = hex => (level === 3 ? `\x1b[38;2;${rgb(hex).join(';')}m` : level === 2 ? `\x1b[38;5;${to256(rgb(hex))}m` : '')
  const wrap = (open, text) => (level ? `${open}${text}\x1b[0m` : text)
  return {
    level,
    color: (hex, text) => wrap(fg(hex), text),
    bold: text => wrap('\x1b[1m', text),
    dim: text => wrap(fg(MUTED), text),
    ship: text => wrap(fg(SHIP), text),
  }
}

// One day's cell: a coloured square by shade (with an orange dot after it
// when something shipped with AI), or plain characters without colour.
const PLAIN = ['░', '▒', '▓', '█']
export function cell(p, shade, shipped) {
  if (shade === null) return '  '
  const mark = shipped ? (p.level ? p.ship('•') : '*') : ' '
  if (p.level === 0) return (shade < 0 ? '·' : PLAIN[shade]) + mark
  return p.color(shade < 0 ? EMPTY : BLUES[shade], '■') + mark
}

const value = d => (d ? (d.messages ?? 0) + (d.aiCommits ?? 0) * 20 : 0)
const active = d => !!d && ((d.messages ?? 0) > 0 || (d.aiCommits ?? 0) > 0)

// Shades by quartile of the person's own active days, as on the site.
export function shader(days, from, to) {
  const sorted = Object.entries(days)
    .filter(([date, d]) => date >= from && date <= to && active(d))
    .map(([, d]) => value(d))
    .sort((a, b) => a - b)
  const at = q => sorted[Math.floor(q * (sorted.length - 1))] ?? 0
  const cuts = [at(0.25), at(0.5), at(0.75)]
  return d => (!active(d) ? -1 : value(d) <= cuts[0] ? 0 : value(d) <= cuts[1] ? 1 : value(d) <= cuts[2] ? 2 : 3)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n))
}
const weekday = key => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

// The heatmap: Sunday-first columns from the first active day (or as many
// weeks as fit), month names above, Mon/Wed/Fri down the side.
export function heatmap(p, days, today, { columns = 80, first } = {}) {
  const maxWeeks = Math.max(4, Math.floor((columns - 5) / 2))
  const earliest = addDays(today, -(maxWeeks * 7 - 1) - weekday(today))
  const from = first && first > earliest ? first : earliest
  const start = addDays(from, -weekday(from))
  const weeks = []
  for (let day = start; day <= today; day = addDays(day, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)))
  const shade = shader(days, from, today)
  // A month's name sits over its first week. When it would collide with the
  // previous name, the previous one (a month shown for a week at most) gives way.
  const labels = []
  let lastMonth = -1
  weeks.forEach((week, w) => {
    const shown = week.find(d => d >= from) ?? week[0]
    const month = Number(shown.slice(5, 7)) - 1
    if (month !== lastMonth && w <= weeks.length - 2) {
      const previous = labels.at(-1)
      if (previous && w - previous.w < 2) labels.pop()
      labels.push({ w, name: MONTHS[month] })
    }
    lastMonth = month
  })
  let header = '     '
  for (const { w, name } of labels) if (header.length <= 5 + w * 2) header = header.padEnd(5 + w * 2) + name
  const rows = ['', 'Mon', '', 'Wed', '', 'Fri', ''].map((label, d) => {
    const cells = weeks.map(week => {
      const date = week[d]
      if (date < from || date > today) return '  '
      const day = days[date]
      return cell(p, shade(day), (day?.aiCommits ?? 0) > 0)
    })
    return `${p.dim(label.padEnd(4))} ${cells.join('')}`
  })
  const legend = `     ${p.dim('less')} ${[-1, 0, 1, 2, 3].map(s => cell(p, s, false)).join('')}${p.dim('more')}   ${p.level ? p.ship('•') : '*'} ${p.dim('shipped with AI')}`
  return [p.dim(header), ...rows, legend].join('\n')
}

// The last four weeks in one line, from a board row's 12-week strip.
export function recent(p, strip, length = 28) {
  return strip
    .flat()
    .filter(s => s !== -2)
    .slice(-length)
    .map(s => cell(p, s, false).trimEnd() || ' ')
    .join('')
}

export const compact = n =>
  n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString('en-US')

export const TOOL_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
}

// Pads text that may hold colour codes to a visible width.
export const visible = text => text.replace(/\x1b\[[0-9;]*m/g, '')
export const pad = (text, width, right = false) => {
  const gap = ' '.repeat(Math.max(0, width - [...visible(text)].length))
  return right ? gap + text : text + gap
}
