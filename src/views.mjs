import { compact, heatmap, pad, painter, recent, TOOL_NAMES } from './view.mjs'

// The read-only commands: your profile and others', the board, today, and
// the dashboard plain `vibestreak` shows. Each fetches the public API (with
// the machine's token where it has one, so a hidden profile's owner still
// sees it) and draws for the terminal's width.

const fmt = n => Number(n ?? 0).toLocaleString('en-US')
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`
const toolList = tools => (tools ?? []).map(t => TOOL_NAMES[t] ?? t).join(', ')

const PERIODS = ['today', '7d', '30d', '90d', 'all']
const METRICS = ['consistency', 'shipped', 'streak', 'tokens']
const TOOLS = Object.keys(TOOL_NAMES)

async function getJson(server, path, token) {
  const response = await fetch(new URL(path, server), { headers: token ? { authorization: `Bearer ${token}` } : {} })
  const body = await response.json().catch(() => ({}))
  if (response.status === 404) throw new Error('No such public profile.')
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  return body
}

function streakLine(p, profile) {
  const s = profile.summary.streak
  const today = profile.activeToday ? p.color('#3fb950', '✓ active today') : s.current > 0 ? p.ship('streak ends at midnight') : p.dim('no live streak')
  const level = profile.level ? `${p.color('#2f81f7', '◆')} ${profile.level}` : ''
  const next = profile.next ? p.dim(` · ${plural(profile.next.remaining, 'day')} to ${profile.next.name}`) : ''
  return `${p.bold(`${fmt(s.current)}-day streak`)} ${p.dim(`(best ${fmt(s.longest)})`)}  ${today}  ${level}${next}`
}

// `vibestreak me` and `vibestreak profile <handle>`.
export async function profileView({ server, token, handle, columns }) {
  const p = painter()
  const profile = await getJson(server, `/api/v1/users/${encodeURIComponent(handle)}.json`, token)
  const s = profile.summary
  const out = [
    `${p.bold(`@${profile.handle}`)}  ${p.dim(toolList(profile.tools))}`,
    streakLine(p, profile),
    '',
    heatmap(p, profile.days, profile.today, { columns, first: s.first }),
    '',
    `${p.bold(fmt(s.activeDays))} active days${s.first ? p.dim(` since ${s.first}`) : ''}   ${p.ship(fmt(s.aiCommits))} commits shipped with AI ${p.dim(`on ${fmt(s.shippedDays)} days`)}`,
    `${fmt(s.messages)} messages · ${fmt(s.toolCalls)} tool calls · ${compact(s.input + s.output + s.cacheRead + s.cacheWrite)} tokens${s.busiest ? p.dim(`   busiest day ${s.busiest.date}, ${fmt(s.busiest.messages)} messages`) : ''}`,
    p.dim(profile.profileUrl),
  ]
  console.log(out.join('\n'))
}

// Board options from words or flags: `board 7d shipped claude`, `--from … --to …`.
export function boardQuery(words, values) {
  const params = new URLSearchParams()
  for (const word of words.map(w => w.toLowerCase())) {
    if (PERIODS.includes(word)) params.set('period', word)
    else if (METRICS.includes(word)) params.set('metric', word)
    else if (TOOLS.includes(word)) params.set('tool', word)
    else throw new Error(`"${word}" is not a period (${PERIODS.join(', ')}), a ranking (${METRICS.join(', ')}) or a tool (${TOOLS.join(', ')}).`)
  }
  if (values.from || values.to) {
    if (!values.from || !values.to) throw new Error('A custom range needs both --from and --to (YYYY-MM-DD).')
    params.set('from', values.from)
    params.set('to', values.to)
    params.delete('period')
  }
  return params
}

const METRIC_LABEL = { consistency: 'active days', shipped: 'commits shipped with AI', streak: 'current streak', tokens: 'tokens' }

// `vibestreak board`: the top ten, a four-week strip per person, and your
// own row pinned below when you rank lower.
export async function boardView({ server, words, values, you, columns }) {
  const p = painter()
  const params = boardQuery(words, values)
  params.set('limit', String(values.limit ?? 10))
  if (you) params.set('you', you)
  const b = await getJson(server, `/api/v1/board?${params}`)
  const period = b.range ? `${b.range.from} → ${b.range.to}` : { today: 'today', all: 'all time' }[b.period] ?? `last ${b.period}`
  const rated = b.rows.some(r => r.rate != null)
  console.log(`${p.bold('Leaderboard')} ${p.dim(`· ${rated ? 'share of days active' : METRIC_LABEL[b.metric]} · ${period}${b.tool ? ` · ${TOOL_NAMES[b.tool]}` : ''} · ${plural(b.total, 'developer')}`)}`)
  if (!b.rows.length) return console.log(p.dim('Nobody here yet for these days.'))
  const wide = columns >= 96
  const handleWidth = Math.min(22, Math.max(8, ...b.rows.map(r => r.handle.length + 1)))
  const header = [pad('#', 4), pad('developer', handleWidth + 1), wide ? pad('last 4 weeks', 29) : '', pad(rated ? 'active%' : 'active', 7, true), pad('streak', 8, true), pad('shipped', 9, true), pad('tokens', 8, true)].join(' ')
  console.log(p.dim(header))
  const line = r => {
    const me = you && r.handle.toLowerCase() === you.toLowerCase()
    const name = pad(`@${r.handle}`, handleWidth + 1)
    return [
      pad(String(r.rank), 4),
      me ? p.bold(name) : name,
      wide ? pad(recent(p, r.strip), 29) : '',
      // All-time consistency ranks the share of days active, which the server sends as `rate`.
      pad(r.rate == null ? fmt(r.activeDays) : `${Math.round(r.rate * 100)}%`, 7, true),
      pad(`${fmt(r.streak)}d`, 8, true),
      pad(p.ship(fmt(r.aiCommits)), 9, true),
      pad(compact(r.tokens), 8, true),
    ].join(' ') + (me ? p.dim('  ← you') : '')
  }
  for (const r of b.rows) console.log(line(r))
  if (b.you && b.you.rank > b.rows.length) console.log(`${p.dim('  …')}\n${line(b.you)}`)
  if (rated) {
    const mine = b.you ?? b.rows.find(r => you && r.handle.toLowerCase() === you.toLowerCase())
    console.log(p.dim(`\nAll time ranks the share of days each person was active since their first, counted over at least 90 days${mine ? ` (yours: ${fmt(mine.activeDays)} of ${fmt(mine.days)})` : ''}.`))
  }
  console.log(p.dim(`\nMore: vibestreak board [today|7d|30d|90d|all] [consistency|shipped|streak|tokens] [tool]   ·   ${new URL('/', server)}`))
}

// `vibestreak today`: who is coding with AI today, and whose streak ends at midnight.
export async function todayView({ server }) {
  const p = painter()
  const t = await getJson(server, '/api/v1/today')
  console.log(`${p.color('#3fb950', '●')} ${p.bold(plural(t.active.length, 'developer'))} coding with AI today ${p.dim(`(of ${fmt(t.developers)})`)}`)
  for (const r of t.active.slice(0, 15)) console.log(`  @${pad(r.handle, 22)} ${pad(`${fmt(r.streak)}d`, 6, true)}  ${p.dim(toolList(r.tools))}`)
  if (t.atRisk.length) {
    console.log(`\n${p.ship(`${plural(t.atRisk.length, 'streak')} at risk`)} ${p.dim('· ends at their midnight')}`)
    for (const r of t.atRisk.slice(0, 10)) console.log(`  @${pad(r.handle, 22)} ${pad(p.ship(`${fmt(r.streak)}d`), 6, true)}`)
  }
}

// Plain `vibestreak`: your streak, the last twelve weeks, your rank, and
// what to run next.
export async function dashboardView({ server, token, handle, columns }) {
  const p = painter()
  const [profile, b] = await Promise.all([
    getJson(server, `/api/v1/users/${encodeURIComponent(handle)}.json`, token),
    getJson(server, `/api/v1/board?limit=0&you=${encodeURIComponent(handle)}`).catch(() => null),
  ])
  const rank = b?.you ? `#${b.you.rank} of ${fmt(b.total)} ${p.dim('· 30 days, consistency')}` : p.dim('not on the public board')
  console.log(`${p.bold(`@${profile.handle}`)}  ${rank}`)
  console.log(streakLine(p, profile))
  console.log('')
  console.log(heatmap(p, profile.days, profile.today, { columns: Math.min(columns, 31), first: profile.summary.first }))
  console.log('')
  console.log(p.dim('vibestreak me · board · today · status · help'))
}
