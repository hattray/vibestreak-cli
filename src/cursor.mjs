import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import { dayKey, emptyDay } from './days.mjs'
import { query } from './sqlite.mjs'

const appData = () =>
  platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : platform() === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))

export const CURSOR_STATE = () => join(appData(), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
export const CURSOR_TRACKING = () => join(homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db')

const toDate = value => {
  const t = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(t) && t > 0 ? dayKey(new Date(t)) : undefined
}

// Cursor keeps its agent and chat history in its editor database: one
// `bubbleId:<conversation>:<message>` row per message (type 1 is the person's,
// 2 the model's), with the tokens the model call used and any tool it ran.
// Accepted AI edits (agent and Tab) are rows of its AI code-tracking
// database; they count as tool calls, the work the AI did in the files.
export async function collectCursor({ state = CURSOR_STATE(), tracking = CURSOR_TRACKING(), since } = {}) {
  const days = new Map()
  const day = date => {
    if (!days.has(date)) days.set(date, { ...emptyDay(date, 'cursor'), models: new Set(), ids: new Set() })
    return days.get(date)
  }

  const bubbles = await query(
    state,
    `SELECT substr(key, 10, instr(substr(key, 10), ':') - 1) AS conversation,
            json_extract(value, '$.createdAt') AS createdAt,
            json_extract(value, '$.type') AS type,
            json_extract(value, '$.tokenCount.inputTokens') AS input,
            json_extract(value, '$.tokenCount.outputTokens') AS output,
            json_extract(value, '$.toolFormerData.name') AS tool,
            json_extract(value, '$.modelInfo.modelName') AS model
       FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND json_valid(value)`,
  )
  for (const b of bubbles) {
    const date = toDate(b.createdAt)
    if (!date || (since && date < since)) continue
    const d = day(date)
    if (b.type === 1 || b.type === 2) d.messages++
    if (b.tool) d.toolCalls++
    d.input += Number(b.input) || 0
    d.output += Number(b.output) || 0
    if (b.model && b.model !== 'default') d.models.add(b.model)
    d.ids.add(b.conversation)
  }

  const edits = await query(tracking, 'SELECT createdAt, model FROM ai_code_hashes')
  for (const e of edits) {
    const date = toDate(e.createdAt)
    if (!date || (since && date < since)) continue
    const d = day(date)
    d.toolCalls++
    if (e.model && e.model !== 'default') d.models.add(e.model)
  }

  return [...days.values()]
    .map(({ ids, models, ...d }) => ({ ...d, sessions: ids.size, models: [...models].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// Commits Cursor scored as containing lines its AI wrote (agent or Tab):
// Cursor adds no co-author trailer, so this is how its shipped work is known.
export async function cursorCommits({ tracking = CURSOR_TRACKING() } = {}) {
  const rows = await query(
    tracking,
    'SELECT DISTINCT commitHash FROM scored_commits WHERE COALESCE(composerLinesAdded, 0) + COALESCE(tabLinesAdded, 0) > 0',
  )
  return new Set(rows.map(r => String(r.commitHash).toLowerCase()).filter(h => /^[0-9a-f]{7,40}$/.test(h)))
}
