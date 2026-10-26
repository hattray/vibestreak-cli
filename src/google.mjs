import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayKey, dayOfIso, emptyDay } from './days.mjs'
import { walk } from './files.mjs'
import { at, fields, query } from './sqlite.mjs'

const GEMINI = () => join(homedir(), '.gemini')

const dayMap = tool => {
  const days = new Map()
  const day = date => {
    if (!days.has(date)) days.set(date, { ...emptyDay(date, tool), models: new Set(), ids: new Set() })
    return days.get(date)
  }
  const list = () =>
    [...days.values()]
      .map(({ ids, models, ...d }) => ({ ...d, sessions: ids.size, models: [...models].sort() }))
      .filter(d => d.messages > 0 || d.toolCalls > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
  return { day, list }
}

// Gemini CLI records each chat as JSON under ~/.gemini/tmp/<project>/chats:
// messages of type `user` and `gemini`, a Gemini message carrying its model,
// tool calls and tokens (`input` includes the cached part, split out here).
export async function collectGeminiCli({ root = join(GEMINI(), 'tmp'), since } = {}) {
  const { day, list } = dayMap('gemini')
  for await (const path of walk(root, '.json', since)) {
    if (!/[/\\]chats[/\\]/.test(path)) continue
    let chat
    try {
      chat = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    for (const m of Array.isArray(chat?.messages) ? chat.messages : []) {
      const date = dayOfIso(m.timestamp ?? '')
      if (!date || (since && date < since)) continue
      if (m.type !== 'user' && m.type !== 'gemini') continue
      const d = day(date)
      d.messages++
      d.ids.add(chat.sessionId ?? path)
      d.toolCalls += Array.isArray(m.toolCalls) ? m.toolCalls.length : 0
      if (m.model) d.models.add(m.model)
      const t = m.tokens ?? {}
      const cached = Number(t.cached) || 0
      d.cacheRead += cached
      d.input += Math.max(0, (Number(t.input) || 0) - cached)
      d.output += (Number(t.output) || 0) + (Number(t.thoughts) || 0)
    }
  }
  return list()
}

// Antigravity (Google's agent IDE) keeps each conversation as SQLite under
// ~/.gemini/antigravity/conversations, its rows protobuf with no published
// schema. Read from what the files hold:
// - a step's time is field 1 of its metadata (seconds); step type 14 is the
//   person's message, 15 the model's reply, and the agent's actions (view,
//   edit, run, search…) are the other types but a few bookkeeping ones;
// - each model call (gen_metadata) holds its model name (field 1.19) and
//   usage (field 1.4: 1 = input, 2 = cached input, 3 = output). Token counts
//   from this undocumented format are a best effort.
const USER = 14
const MODEL = 15
const BOOKKEEPING = new Set([23, 98, 101])

const seconds = buffer => {
  const s = at(buffer, [1])
  return typeof s === 'number' && s > 1.5e9 && s < 4e9 ? s : undefined
}

export async function collectAntigravity({ root = join(GEMINI(), 'antigravity', 'conversations'), since } = {}) {
  const { day, list } = dayMap('antigravity')
  for await (const path of walk(root, '.db', since)) {
    const id = path
    const steps = await query(path, 'SELECT step_type AS type, hex(metadata) AS meta FROM steps')
    let lastDate
    for (const s of steps) {
      const meta = s.meta ? Buffer.from(s.meta, 'hex') : undefined
      const t = meta ? seconds(fields(meta).get(1)?.[0]) : undefined
      const date = t ? dayKey(new Date(t * 1000)) : lastDate
      if (!date) continue
      lastDate = date
      if (since && date < since) continue
      const d = day(date)
      d.ids.add(id)
      if (s.type === USER || s.type === MODEL) d.messages++
      else if (!BOOKKEEPING.has(s.type)) d.toolCalls++
    }
    const calls = await query(path, 'SELECT hex(data) AS data FROM gen_metadata')
    for (const c of calls) {
      const call = at(Buffer.from(c.data, 'hex'), [1])
      if (!Buffer.isBuffer(call)) continue
      const when = at(call, [9, 4])
      const t = Buffer.isBuffer(when) ? seconds(when) : undefined
      const date = t ? dayKey(new Date(t * 1000)) : lastDate
      if (!date || (since && date < since)) continue
      const d = day(date)
      const usage = at(call, [4])
      if (Buffer.isBuffer(usage)) {
        const u = fields(usage)
        const n = k => (typeof u.get(k)?.[0] === 'number' ? u.get(k)[0] : 0)
        d.input += n(1)
        d.cacheRead += n(2)
        d.output += n(3)
      }
      const model = at(call, [19])
      if (Buffer.isBuffer(model) && model.length < 80) d.models.add(model.toString('utf8'))
    }
  }
  return list()
}
