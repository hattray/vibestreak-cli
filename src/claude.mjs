import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayOfIso, emptyDay } from './days.mjs'
import { lines, walk } from './files.mjs'

// Claude Code keeps every session as JSONL under ~/.claude/projects (subagents
// included). Lines are matched with regular expressions rather than parsed:
// a heavy user has gigabytes of transcripts, and the fields needed sit at the
// top level of each row.
//
// - A message is a user or assistant row; a row copied into another file (a
//   fork, a resume) keeps its uuid and is counted once.
// - One API request is written as several assistant rows repeating its usage,
//   so tokens count once per requestId, on the day of its first row, each
//   field at its largest.
const ROLE = /"type":"(user|assistant)"/
const TIMESTAMP = /"timestamp":"([^"]+)"/
const UUID = /"uuid":"([0-9a-f-]{36})"/
const SESSION = /"sessionId":"([^"]+)"/
const REQUEST = /"requestId":"([^"]+)"/
const MODEL = /"model":"((?:claude|gpt|gemini)[^"]*)"/
const TOOL_USE = /"type":"tool_use"/g
const USAGE = {
  input: /"input_tokens":(\d+)/,
  output: /"output_tokens":(\d+)/,
  cacheRead: /"cache_read_input_tokens":(\d+)/,
  cacheWrite: /"cache_creation_input_tokens":(\d+)/,
}

export async function collectClaude({ root = join(homedir(), '.claude', 'projects'), since } = {}) {
  const days = new Map()
  const seen = new Set()
  const sessions = new Map()
  const requests = new Map()
  const day = date => {
    if (!days.has(date)) days.set(date, { ...emptyDay(date, 'claude'), models: new Set() })
    return days.get(date)
  }

  for await (const path of walk(root, '.jsonl', since)) {
    for await (const line of lines(path)) {
      const role = ROLE.exec(line)?.[1]
      if (!role) continue
      const date = dayOfIso(TIMESTAMP.exec(line)?.[1] ?? '')
      if (!date || (since && date < since)) continue
      const uuid = UUID.exec(line)?.[1]
      if (uuid) {
        if (seen.has(uuid)) continue
        seen.add(uuid)
      }
      const counts = day(date)
      counts.messages++
      counts.toolCalls += line.match(TOOL_USE)?.length ?? 0
      const session = SESSION.exec(line)?.[1]
      if (session) {
        if (!sessions.has(date)) sessions.set(date, new Set())
        sessions.get(date).add(session)
      }
      if (role !== 'assistant') continue
      const model = MODEL.exec(line)?.[1]
      if (model && model !== '<synthetic>') counts.models.add(model)
      const request = REQUEST.exec(line)?.[1]
      if (!request) continue
      const usage = requests.get(request) ?? { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      for (const [field, pattern] of Object.entries(USAGE)) {
        const value = Number(pattern.exec(line)?.[1] ?? 0)
        if (value > usage[field]) usage[field] = value
      }
      requests.set(request, usage)
    }
  }

  for (const { date, ...usage } of requests.values()) {
    const counts = day(date)
    for (const field of Object.keys(USAGE)) counts[field] += usage[field]
  }
  for (const [date, ids] of sessions) day(date).sessions = ids.size

  return [...days.values()]
    .map(d => ({ ...d, models: [...d.models].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
