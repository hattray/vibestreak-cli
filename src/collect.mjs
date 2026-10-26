import { collectClaude } from './claude.mjs'
import { collectCodex } from './codex.mjs'
import { collectCopilot } from './copilot.mjs'
import { collectCursor, cursorCommits } from './cursor.mjs'
import { dayKey, timezone } from './days.mjs'
import { collectCommits, DEFAULT_ROOTS } from './git.mjs'
import { collectAntigravity, collectGeminiCli } from './google.mjs'
import { collectOpenCode } from './opencode.mjs'

export const PAYLOAD_VERSION = 1

// How far back a sync reaches: a machine's first sync sends a year and a
// bit (the most a heatmap shows); after that the server takes only the last
// week from it (its history lock), so later syncs send just that.
export const FULL_DAYS = 400
export const RECENT_DAYS = 7
export const sinceDate = (days = FULL_DAYS) => dayKey(new Date(Date.now() - days * 864e5))

// Where this machine's next sync starts: a full history the first time (or
// on --full, or after linking to another server), the last week after that.
export function syncSince(config, { full = false, since } = {}) {
  if (since) return since
  return full || !config.lastSync || config.lastSyncServer !== config.server ? sinceDate(FULL_DAYS) : sinceDate(RECENT_DAYS)
}

// Everything one machine sends: per-day totals per tool, and its commits as
// keyed hashes. No prompt, code, path, repo name or commit message is read
// into it.
export async function collect({ config, salt, since = sinceDate() }) {
  const cursor = await cursorCommits()
  const [claude, codex, cursorDays, gemini, antigravity, copilot, opencode, git] = await Promise.all([
    collectClaude({ since }),
    collectCodex({ since }),
    collectCursor({ since }),
    collectGeminiCli({ since }),
    collectAntigravity({ since }),
    collectCopilot({ since }),
    collectOpenCode({ since }),
    collectCommits({ emails: config.emails, roots: config.roots ?? DEFAULT_ROOTS, since, salt, cursor }),
  ])
  return {
    version: PAYLOAD_VERSION,
    machine: { id: config.machineId, name: config.machineName },
    timezone: timezone(),
    since,
    days: [...claude, ...codex, ...cursorDays, ...gemini, ...antigravity, ...copilot, ...opencode],
    commits: git.commits,
    repos: git.repos,
  }
}

export function summarize(payload) {
  const tools = {}
  for (const d of payload.days) {
    const t = (tools[d.tool] ??= { days: 0, messages: 0, toolCalls: 0, tokens: 0 })
    t.days++
    t.messages += d.messages
    t.toolCalls += d.toolCalls
    t.tokens += d.input + d.output + d.cacheRead + d.cacheWrite
  }
  const activeDays = new Set(payload.days.map(d => d.date)).size
  const aiCommits = payload.commits.filter(c => c.agent).length
  return { activeDays, tools, commits: payload.commits.length, aiCommits, repos: payload.repos }
}
