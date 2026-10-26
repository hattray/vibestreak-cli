import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { collectClaude } from '../src/claude.mjs'
import { collectCodex } from '../src/codex.mjs'
import { agentOf, collectCommits } from '../src/git.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'vibestreak-'))
const at = iso => new Date(iso).toISOString()
const local = iso => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('Claude Code: copied rows count once, a request’s tokens count once', async () => {
  const root = temp()
  mkdirSync(join(root, 'p'))
  const t = at('2026-10-24T15:00:00Z')
  const usage = '"usage":{"input_tokens":5,"cache_creation_input_tokens":7,"cache_read_input_tokens":100,"output_tokens":9}'
  const rows = [
    `{"type":"user","sessionId":"s1","message":{"role":"user","content":"hi"},"uuid":"11111111-1111-1111-1111-111111111111","timestamp":"${t}"}`,
    `{"type":"assistant","sessionId":"s1","message":{"model":"claude-opus-5-5","content":[{"type":"tool_use"}],${usage}},"requestId":"r1","uuid":"22222222-2222-2222-2222-222222222222","timestamp":"${t}"}`,
    `{"type":"assistant","sessionId":"s1","message":{"model":"claude-opus-5-5","content":[{"type":"text"}],${usage}},"requestId":"r1","uuid":"33333333-3333-3333-3333-333333333333","timestamp":"${t}"}`,
  ]
  writeFileSync(join(root, 'p', 'a.jsonl'), rows.join('\n') + '\n')
  // A resumed session copies the same rows into a second file.
  writeFileSync(join(root, 'p', 'b.jsonl'), rows.join('\n') + '\n')
  const [day] = await collectClaude({ root })
  assert.equal(day.date, local(t))
  assert.equal(day.messages, 3)
  assert.equal(day.toolCalls, 1)
  assert.equal(day.sessions, 1)
  assert.deepEqual([day.input, day.output, day.cacheRead, day.cacheWrite], [5, 9, 100, 7])
  assert.deepEqual(day.models, ['claude-opus-5-5'])
})

test('Codex: tokens are the growth of the running total, cached input split out', async () => {
  const root = temp()
  mkdirSync(join(root, 'sessions', '2026'), { recursive: true })
  const t = at('2026-10-24T15:00:00Z')
  const total = (input, cached, output) =>
    JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
  const rows = [
    JSON.stringify({ timestamp: t, type: 'session_meta', payload: { id: 'x1' } }),
    JSON.stringify({ timestamp: t, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'user_message' } }),
    JSON.stringify({ timestamp: t, type: 'response_item', payload: { type: 'function_call' } }),
    total(100, 40, 10),
    total(100, 40, 10),
    total(250, 140, 30),
    JSON.stringify({ timestamp: t, type: 'session_meta', payload: { id: 'x1' } }),
    JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'agent_message' } }),
  ]
  writeFileSync(join(root, 'sessions', '2026', 'r.jsonl'), rows.join('\n'))
  const [day] = await collectCodex({ root })
  assert.equal(day.messages, 2)
  assert.equal(day.toolCalls, 1)
  assert.deepEqual([day.input, day.cacheRead, day.output], [110, 140, 30])
  assert.deepEqual(day.models, ['gpt-5.5'])
})

test('agents are named by their own addresses, never a human first name', () => {
  assert.equal(agentOf('Claude Opus 5.5 <noreply@anthropic.com>'), 'claude')
  assert.equal(agentOf('Codex <codex@openai.com>'), 'codex')
  assert.equal(agentOf('Cursor Agent <cursoragent@cursor.com>'), 'cursor')
  assert.equal(agentOf('Devin Smith <devin@example.com>'), undefined)
  assert.equal(agentOf('Jules Verne <jules@example.com>'), undefined)
})

test('commits: only the person’s, once across clones, with their agent', async () => {
  const root = temp()
  const repo = join(root, 'a')
  // An empty global config, so the machine's own git settings can't change the result.
  const globalConfig = join(root, 'gitconfig')
  writeFileSync(globalConfig, '')
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } })
  mkdirSync(repo)
  git('init', '-q')
  git('-c', 'user.email=me@x.dev', '-c', 'user.name=Me', 'commit', '-q', '--allow-empty', '-m', 'one\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
  git('-c', 'user.email=me@x.dev', '-c', 'user.name=Me', 'commit', '-q', '--allow-empty', '-m', 'two')
  git('-c', 'user.email=them@x.dev', '-c', 'user.name=Them', 'commit', '-q', '--allow-empty', '-m', 'theirs')
  execFileSync('git', ['clone', '-q', repo, join(root, 'b')])
  const { commits, repos } = await collectCommits({ emails: ['ME@x.dev'], roots: [root], since: '2000-01-01', salt: 's' })
  assert.equal(repos, 2)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits.map(c => c.agent).sort(), ['claude', null].sort())
  assert.ok(commits.every(c => /^[0-9a-f]{20}$/.test(c.h)))

  // A commit Cursor scored as holding AI lines counts as shipped with Cursor.
  const plain = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H', 'HEAD~1']).toString().trim()
  const withCursor = await collectCommits({ emails: ['me@x.dev'], roots: [root], since: '2000-01-01', salt: 's', cursor: new Set([plain.slice(0, 12)]) })
  assert.deepEqual(withCursor.commits.map(c => c.agent).sort(), ['claude', 'cursor'])
})
