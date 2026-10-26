import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { collectCopilot, readChatSession } from '../src/copilot.mjs'
import { collectOpenCode } from '../src/opencode.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'vibestreak-'))
const T = Date.parse('2026-10-24T15:00:00Z')
const at = new Date(T).toISOString()

test('Copilot CLI: turns, tool calls, and shutdown tokens with the cache split out', async () => {
  const home = temp()
  mkdirSync(join(home, 'session-state', 's1'), { recursive: true })
  const events = [
    { type: 'session.start', timestamp: at },
    { type: 'user.message', timestamp: at },
    { type: 'tool.execution_start', timestamp: at },
    { type: 'tool.execution_start', timestamp: at },
    { type: 'assistant.message', timestamp: at },
    { type: 'session.shutdown', id: 'x', timestamp: at, data: { modelMetrics: { 'claude-opus-4.7-1m-internal': { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, reasoningTokens: 5 } } } } },
    { type: 'session.shutdown', id: 'x', timestamp: at, data: { modelMetrics: { 'gpt-5.4': { usage: { inputTokens: 999 } } } } },
  ]
  writeFileSync(join(home, 'session-state', 's1', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
  process.env.COPILOT_HOME = home
  try {
    const days = await collectCopilot()
    const day = days.find(d => d.sessions)
    assert.deepEqual([day.messages, day.toolCalls, day.sessions, day.input, day.cacheRead, day.cacheWrite, day.output], [2, 2, 1, 70, 10, 20, 55])
    assert.deepEqual(day.models, ['claude-opus-4.7'])
  } finally {
    delete process.env.COPILOT_HOME
  }
})

test('Copilot Chat in VS Code: a change-log session replays to its requests', async () => {
  const path = join(temp(), 's.jsonl')
  const ops = [
    { kind: 0, v: { sessionId: 'v1', requests: [] } },
    { kind: 2, k: ['requests'], v: [{ timestamp: T, modelId: 'copilot/gpt-5.5', result: { metadata: { toolCallRounds: [{ toolCalls: [{}, {}] }, { toolCalls: [{}] }] } } }] },
    { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'done' }] },
  ]
  writeFileSync(path, ops.map(o => JSON.stringify(o)).join('\n'))
  const session = await readChatSession(path)
  assert.equal(session.requests.length, 1)
  assert.deepEqual(session.requests[0].response, [{ value: 'done' }])
})

test('OpenCode: SQLite messages with tokens and tool parts, legacy files not counted twice', async () => {
  const dir = temp()
  const message = (id, role, extra = {}) => ({ id, sessionID: 's1', role, time: { created: T }, ...extra })
  const assistant = message('m2', 'assistant', { modelID: 'deepseek-v4', tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 500, write: 30 } } })
  const json = o => JSON.stringify(o).replace(/'/g, "''")
  const db = new DatabaseSync(join(dir, 'opencode.db'))
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
            INSERT INTO message VALUES ('m1', 's1', '${json(message('m1', 'user'))}', ${T}), ('m2', 's1', '${json(assistant)}', ${T});
            INSERT INTO part VALUES ('p1', 'm2', 's1', '{"type":"tool"}'), ('p2', 'm2', 's1', '{"type":"text"}');`)
  db.close()
  // The same message as a legacy file, and one only the files hold.
  mkdirSync(join(dir, 'storage', 'message', 's1'), { recursive: true })
  mkdirSync(join(dir, 'storage', 'part', 'm3'), { recursive: true })
  writeFileSync(join(dir, 'storage', 'message', 's1', 'm2.json'), JSON.stringify(assistant))
  writeFileSync(join(dir, 'storage', 'message', 's1', 'm3.json'), JSON.stringify(message('m3', 'assistant', { modelID: 'kimi-k3', tokens: { input: 1, output: 2 } })))
  writeFileSync(join(dir, 'storage', 'part', 'm3', 'p.json'), '{"type":"tool"}')
  const [day] = await collectOpenCode({ dir })
  assert.deepEqual([day.messages, day.toolCalls, day.sessions, day.input, day.output, day.cacheRead, day.cacheWrite], [3, 2, 1, 101, 52, 500, 30])
  assert.deepEqual(day.models, ['deepseek-v4', 'kimi-k3'])
})
