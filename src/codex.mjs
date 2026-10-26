import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayOfIso, emptyDay } from './days.mjs'
import { lines, walk } from './files.mjs'

// Codex CLI and the Codex app write one JSONL "rollout" per session under
// ~/.codex/sessions (and ~/.codex/archived_sessions once archived).
//
// - Tokens: each `token_count` event carries the session's running total;
//   the growth since the previous event is that call's usage. Codex reports
//   cached input inside input_tokens, so it is split out as cache reads.
// - Messages: the person's and the agent's messages (`user_message`,
//   `agent_message`); tool calls: `function_call` and `custom_tool_call`.
//   Some Codex versions log no message events at all; a session without any
//   counts its `message` items instead, leaving out the context Codex adds
//   itself (AGENTS.md, the environment) as the user's turn.
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call'])
const MESSAGES = new Set(['user_message', 'agent_message'])
const ROLES = new Set(['user', 'assistant'])
const INJECTED = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>)/
const isMessageItem = payload =>
  payload.type === 'message' && ROLES.has(payload.role) && !(payload.role === 'user' && INJECTED.test(payload.content?.[0]?.text ?? ''))

export async function collectCodex({ root = join(homedir(), '.codex'), since } = {}) {
  const days = new Map()
  const day = date => {
    if (!days.has(date)) days.set(date, { ...emptyDay(date, 'codex'), models: new Set(), ids: new Set() })
    return days.get(date)
  }
  const seenSessions = new Set()

  for (const folder of ['sessions', 'archived_sessions']) {
    for await (const path of walk(join(root, folder), '.jsonl', since)) {
      let session
      let model
      let last = { input: 0, cached: 0, output: 0 }
      // This session's messages per day: from events, and from items as a fallback.
      const events = new Map()
      const items = new Map()
      const add = (map, date) => map.set(date, (map.get(date) ?? 0) + 1)
      for await (const line of lines(path)) {
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        const payload = row.payload ?? {}
        if (row.type === 'session_meta') {
          // The file's first meta names its session (later ones repeat it, or
          // name the session a fork came from); an archived copy of a session
          // already read is skipped whole.
          if (session === undefined) {
            session = payload.id ?? path
            if (seenSessions.has(session)) break
            seenSessions.add(session)
          }
          continue
        }
        session ??= path
        if (row.type === 'turn_context' && payload.model) model = payload.model
        const date = dayOfIso(row.timestamp ?? '')
        if (!date || (since && date < since)) continue
        const counts = day(date)
        counts.ids.add(session)
        if (model) counts.models.add(model)
        if (row.type === 'response_item' && TOOL_CALLS.has(payload.type)) counts.toolCalls++
        if (row.type === 'event_msg' && MESSAGES.has(payload.type)) add(events, date)
        if (row.type === 'response_item' && isMessageItem(payload)) add(items, date)
        const total = row.type === 'event_msg' && payload.type === 'token_count' ? payload.info?.total_token_usage : undefined
        if (!total) continue
        const now = {
          input: total.input_tokens ?? 0,
          cached: total.cached_input_tokens ?? 0,
          output: total.output_tokens ?? 0,
        }
        // A total that went down belongs to a new context (a compaction): count it whole.
        const grew = now.input >= last.input && now.output >= last.output
        const delta = grew
          ? { input: now.input - last.input, cached: now.cached - last.cached, output: now.output - last.output }
          : now
        counts.cacheRead += Math.max(0, delta.cached)
        counts.input += Math.max(0, delta.input - delta.cached)
        counts.output += Math.max(0, delta.output)
        last = now
      }
      for (const [date, n] of events.size ? events : items) day(date).messages += n
    }
  }

  return [...days.values()]
    .map(({ ids, models, ...d }) => ({ ...d, sessions: ids.size, models: [...models].sort() }))
    .filter(d => d.messages > 0 || d.toolCalls > 0 || d.input > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}
