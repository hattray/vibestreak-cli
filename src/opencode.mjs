import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayKey, emptyDay } from './days.mjs'
import { walk } from './files.mjs'
import { query } from './sqlite.mjs'

export const OPENCODE_DIR = () =>
  process.env.OPENCODE_DATA_DIR?.trim() || join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'opencode')

// OpenCode keeps its history in SQLite (opencode.db, and opencode-<channel>.db
// for other release channels): a `message` row per message, its JSON holding
// the role, model, time and tokens (`input` without the cache, `cache.read`,
// `cache.write`, `output` and `reasoning`), and `part` rows of which `tool`
// ones are tool calls. Older releases wrote the same JSON as files under
// storage/message/<session>/ and storage/part/<message>/. A message held by
// both counts once.
export async function collectOpenCode({ dir = OPENCODE_DIR(), since } = {}) {
  const days = new Map()
  const seen = new Set()
  const add = (id, session, m, tools) => {
    if (seen.has(id)) return
    seen.add(id)
    const t = Number(m?.time?.created)
    if (!Number.isFinite(t) || t <= 0) return
    const date = dayKey(new Date(t))
    if (since && date < since) return
    if (!days.has(date)) days.set(date, { ...emptyDay(date, 'opencode'), models: new Set(), ids: new Set() })
    const d = days.get(date)
    d.ids.add(session)
    if (m.role === 'user' || m.role === 'assistant') d.messages++
    d.toolCalls += tools
    const k = m.tokens ?? {}
    d.input += Number(k.input) || 0
    d.output += (Number(k.output) || 0) + (Number(k.reasoning) || 0)
    d.cacheRead += Number(k.cache?.read) || 0
    d.cacheWrite += Number(k.cache?.write) || 0
    const model = m.modelID ?? m.model?.id ?? m.model?.modelID
    if (typeof model === 'string' && model) d.models.add(model)
  }

  const databases = (await readdir(dir).catch(() => [])).filter(n => n === 'opencode.db' || /^opencode-.+\.db$/.test(n))
  for (const name of databases) {
    const path = join(dir, name)
    let rows = await query(
      path,
      `SELECT m.id, m.session_id AS session, m.data,
              (SELECT COUNT(*) FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'tool') AS tools
         FROM message m`,
    )
    if (!rows.length) rows = await query(path, 'SELECT id, session_id AS session, data, 0 AS tools FROM message')
    for (const r of rows) {
      let m
      try {
        m = JSON.parse(r.data)
      } catch {
        continue
      }
      add(r.id, r.session, m, Number(r.tools) || 0)
    }
  }

  const storage = join(dir, 'storage')
  const toolsOf = async messageId => {
    let n = 0
    for await (const path of walk(join(storage, 'part', messageId), '.json')) {
      try {
        if (JSON.parse(await readFile(path, 'utf8')).type === 'tool') n++
      } catch {
        // Unreadable part: not counted.
      }
    }
    return n
  }
  for await (const path of walk(join(storage, 'message'), '.json', since)) {
    let m
    try {
      m = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    const id = m.id ?? path.split(/[/\\]/).pop().replace(/\.json$/, '')
    if (seen.has(id)) continue
    add(id, m.sessionID ?? path, m, await toolsOf(id))
  }

  return [...days.values()]
    .map(({ ids, models, ...d }) => ({ ...d, sessions: ids.size, models: [...models].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
