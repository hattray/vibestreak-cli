import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { collectCursor, cursorCommits } from '../src/cursor.mjs'
import { collectAntigravity, collectGeminiCli } from '../src/google.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'vibestreak-'))
import { DatabaseSync } from 'node:sqlite'

// Fixture databases, written with Node's own SQLite so the tests need nothing installed.
const sqlite = (path, sql) => {
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
}
const T = Date.parse('2026-10-24T15:00:00Z')
const local = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A tiny protobuf writer, enough to build Antigravity-shaped rows.
const varint = n => {
  const out = []
  while (n >= 128) out.push((n % 128) | 128), (n = Math.floor(n / 128))
  out.push(n)
  return Buffer.from(out)
}
const num = (field, n) => Buffer.concat([varint(field * 8), varint(n)])
const msg = (field, ...parts) => {
  const body = Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p) : p)))
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body])
}
const hex = b => `X'${b.toString('hex')}'`

test('Cursor: messages, tools and tokens from bubbles; accepted edits count as tool calls', async () => {
  const dir = temp()
  const state = join(dir, 'state.vscdb')
  const tracking = join(dir, 'ai.db')
  const bubble = (conversation, id, value) => `INSERT INTO cursorDiskKV VALUES ('bubbleId:${conversation}:${id}', '${JSON.stringify(value)}');`
  sqlite(
    state,
    `CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
     ${bubble('c1', 'b1', { type: 1, createdAt: new Date(T).toISOString() })}
     ${bubble('c1', 'b2', { type: 2, createdAt: new Date(T).toISOString(), tokenCount: { inputTokens: 100, outputTokens: 20 }, toolFormerData: { name: 'edit_file' }, modelInfo: { modelName: 'claude-sonnet-5' } })}
     ${bubble('c2', 'b3', { type: 2, createdAt: T, tokenCount: { inputTokens: 5, outputTokens: 1 } })}`,
  )
  sqlite(
    tracking,
    `CREATE TABLE ai_code_hashes (hash TEXT, source TEXT, model TEXT, createdAt INTEGER);
     INSERT INTO ai_code_hashes VALUES ('h1', 'tab', 'default', ${T}), ('h2', 'composer', 'gpt-5.5', ${T});
     CREATE TABLE scored_commits (commitHash TEXT, branchName TEXT, scoredAt INTEGER, composerLinesAdded INTEGER, tabLinesAdded INTEGER);
     INSERT INTO scored_commits VALUES ('ABCDEF1234567', 'main', 1, 10, 0), ('fedcba7654321', 'main', 1, 0, 0);`,
  )
  const [day] = await collectCursor({ state, tracking })
  assert.equal(day.date, local(T))
  assert.deepEqual([day.messages, day.toolCalls, day.sessions, day.input, day.output], [3, 3, 2, 105, 21])
  assert.deepEqual(day.models, ['claude-sonnet-5', 'gpt-5.5'])
  assert.deepEqual([...(await cursorCommits({ tracking }))], ['abcdef1234567'])
})

test('Gemini CLI: user and Gemini messages, tools, and tokens with the cached part split out', async () => {
  const root = temp()
  mkdirSync(join(root, 'proj', 'chats'), { recursive: true })
  const at = new Date(T).toISOString()
  writeFileSync(
    join(root, 'proj', 'chats', 'session-1.json'),
    JSON.stringify({
      sessionId: 's1',
      messages: [
        { type: 'user', timestamp: at, content: 'hi' },
        { type: 'gemini', timestamp: at, model: 'gemini-3-pro', toolCalls: [{}, {}], tokens: { input: 1000, cached: 600, output: 50, thoughts: 10 } },
        { type: 'info', timestamp: at },
      ],
    }),
  )
  writeFileSync(join(root, 'proj', 'logs.json'), '[]')
  const [day] = await collectGeminiCli({ root })
  assert.deepEqual([day.messages, day.toolCalls, day.sessions, day.input, day.cacheRead, day.output], [2, 2, 1, 400, 600, 60])
  assert.deepEqual(day.models, ['gemini-3-pro'])
})

test('Antigravity: step times and types, and each model call’s tokens', async () => {
  const root = temp()
  const path = join(root, 'c1.db')
  const seconds = Math.floor(T / 1000)
  const meta = msg(1, num(1, seconds), num(2, 0))
  const call = msg(1, msg(4, num(1, 100), num(2, 900), num(3, 40)), msg(9, msg(4, num(1, seconds))), msg(19, 'gemini-3.6-flash'))
  sqlite(
    path,
    `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
     INSERT INTO steps VALUES (1, 14, ${hex(meta)}), (2, 15, ${hex(meta)}), (3, 21, ${hex(meta)}), (4, 101, ${hex(meta)});
     CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
     INSERT INTO gen_metadata VALUES (1, ${hex(call)});`,
  )
  const [day] = await collectAntigravity({ root })
  assert.equal(day.date, local(T))
  assert.deepEqual([day.messages, day.toolCalls, day.sessions, day.input, day.cacheRead, day.output], [2, 1, 1, 100, 900, 40])
  assert.deepEqual(day.models, ['gemini-3.6-flash'])
})
