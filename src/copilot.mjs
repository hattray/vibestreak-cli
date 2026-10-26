import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import { dayKey, dayOfIso, emptyDay } from './days.mjs'
import { lines } from './files.mjs'

const dayMap = () => {
  const days = new Map()
  const day = date => {
    if (!days.has(date)) days.set(date, { ...emptyDay(date, 'copilot'), models: new Set(), ids: new Set() })
    return days.get(date)
  }
  return { days, day }
}

const toList = days =>
  [...days.values()]
    .map(({ ids, models, ...d }) => ({ ...d, sessions: ids.size, models: [...models].sort() }))
    .filter(d => d.messages > 0 || d.toolCalls > 0 || d.input > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

const isDir = async path => (await stat(path).catch(() => undefined))?.isDirectory() ?? false

// Copilot CLI writes each session to ~/.copilot/session-state/<id>/events.jsonl
// (or under $COPILOT_HOME): `user.message` and `assistant.message` per turn,
// `tool.execution_start` per tool call, and at the end `session.shutdown`
// with each model's tokens (`inputTokens` includes the cached part).
async function cli(day, since) {
  const root = join(process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'), 'session-state')
  let sessions = []
  try {
    sessions = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue
    const id = `cli:${entry.name}`
    const shutdowns = new Set()
    try {
      for await (const line of lines(join(root, entry.name, 'events.jsonl'))) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        const date = dayOfIso(event.timestamp ?? '')
        if (!date || (since && date < since)) continue
        const d = day(date)
        d.ids.add(id)
        if (event.type === 'user.message' || event.type === 'assistant.message') d.messages++
        else if (event.type === 'tool.execution_start') d.toolCalls++
        else if (event.type === 'session.shutdown') {
          const key = event.id ?? event.timestamp
          if (shutdowns.has(key)) continue
          shutdowns.add(key)
          for (const [model, metrics] of Object.entries(event.data?.modelMetrics ?? {})) {
            const u = metrics?.usage ?? {}
            const read = Number(u.cacheReadTokens) || 0
            const write = Number(u.cacheWriteTokens) || 0
            d.input += Math.max(0, (Number(u.inputTokens) || 0) - read - write)
            d.cacheRead += read
            d.cacheWrite += write
            d.output += (Number(u.outputTokens) || 0) + (Number(u.reasoningTokens) || 0)
            if (model.trim()) d.models.add(model.trim().replace(/(-1m)?(-internal)?$/, ''))
          }
        }
      }
    } catch {
      // No events.jsonl in this folder.
    }
  }
}

// Copilot Chat in VS Code keeps sessions per workspace (and for windows with
// no folder) as JSON, or in newer releases as a log of changes: a first
// snapshot (kind 0), then values set (kind 1) and items appended (kind 2) at
// a key path. Each request is one prompt and its response; its tool calls
// sit in the result's tool-call rounds. Chat records hold no token counts.
const EDITORS = ['Code', 'Code - Insiders', 'VSCodium']

const userDirs = () => {
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : platform() === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return EDITORS.map(editor => join(base, editor, 'User'))
}

export async function readChatSession(path) {
  if (path.endsWith('.json')) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return undefined
    }
  }
  let session
  for await (const line of lines(path)) {
    let op
    try {
      op = JSON.parse(line)
    } catch {
      continue
    }
    if (op.kind === 0) {
      session = op.v
      continue
    }
    if (!session || !Array.isArray(op.k) || !op.k.length) continue
    let target = session
    for (const key of op.k.slice(0, -1)) target = target?.[key]
    const last = op.k.at(-1)
    if (target == null) continue
    if (op.kind === 1) target[last] = op.v
    else if (op.kind === 2) {
      if (!Array.isArray(target[last])) target[last] = []
      target[last].push(...(Array.isArray(op.v) ? op.v : [op.v]))
    }
  }
  return session
}

async function vscode(day, since) {
  for (const user of userDirs()) {
    if (!(await isDir(user))) continue
    const folders = [join(user, 'globalStorage', 'emptyWindowChatSessions')]
    for (const ws of await readdir(join(user, 'workspaceStorage')).catch(() => [])) folders.push(join(user, 'workspaceStorage', ws, 'chatSessions'))
    for (const folder of folders) {
      for (const name of await readdir(folder).catch(() => [])) {
        if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue
        const session = await readChatSession(join(folder, name))
        for (const request of Array.isArray(session?.requests) ? session.requests : []) {
          const t = Number(request?.timestamp)
          if (!Number.isFinite(t) || t <= 0) continue
          const date = dayKey(new Date(t))
          if (since && date < since) continue
          const d = day(date)
          d.ids.add(`vscode:${session.sessionId ?? name}`)
          d.messages += request.response ? 2 : 1
          const rounds = request.result?.metadata?.toolCallRounds
          if (Array.isArray(rounds)) for (const r of rounds) d.toolCalls += Array.isArray(r?.toolCalls) ? r.toolCalls.length : 0
          const model = request.modelId ?? request.result?.details
          if (typeof model === 'string' && model.length < 80) d.models.add(model.replace(/^copilot\//, ''))
        }
      }
    }
  }
}

export async function collectCopilot({ since } = {}) {
  const { days, day } = dayMap()
  await cli(day, since)
  await vscode(day, since)
  return toList(days)
}
