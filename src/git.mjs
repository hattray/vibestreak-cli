import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { dayOfEpoch } from './days.mjs'

const run = promisify(execFile)

// Where developers keep repos: the usual folder names on every OS, plus
// Xcode's ~/Developer, Visual Studio's ~/source/repos and GitHub Desktop's ~/Documents/GitHub.
export const DEFAULT_ROOTS = ['Desktop', 'Downloads', 'Documents', 'Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Developer', 'repos', 'source', 'work', 'workspace', 'git', 'GitHub'].map(
  name => join(homedir(), name),
)

const SKIP = new Set(['node_modules', '.git', 'Library', '.Trash', 'vendor', 'Pods', 'build', 'dist', '.next', 'DerivedData'])

// Folders holding a `.git` directory under the roots, `depth` levels down at
// most. A worktree's `.git` is a file: its commits are its main repo's, read there.
export async function findRepos(roots = DEFAULT_ROOTS, depth = 4) {
  const repos = new Set()
  const visit = async (dir, left) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(e => e.name === '.git' && e.isDirectory())) repos.add(dir)
    if (left === 0) return
    await Promise.all(
      entries
        .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
        .map(e => visit(join(dir, e.name), left - 1)),
    )
  }
  // One folder can have two spellings (code and Code on a case-insensitive
  // disk, or a link): each is searched once, by its identity on disk.
  const seen = new Set()
  for (const root of roots) {
    const info = await stat(root).catch(() => undefined)
    if (!info?.isDirectory() || seen.has(`${info.dev}:${info.ino}`)) continue
    seen.add(`${info.dev}:${info.ino}`)
    await visit(root, depth)
  }
  const unique = new Map()
  for (const repo of repos) {
    const info = await stat(repo).catch(() => undefined)
    if (info) unique.set(`${info.dev}:${info.ino}`, repo)
  }
  return [...unique.values()].sort()
}

// The AI agent a co-author trailer or an author address names, if any. Each
// pattern is an agent's own name or address, never a first name a human
// co-author could have (Devin and Jules are matched by their bot accounts).
const AGENTS = [
  ['claude', /claude|anthropic\.com/i],
  ['codex', /codex|openai\.com|chatgpt/i],
  ['cursor', /cursoragent|@cursor\.com|\bcursor\b/i],
  ['gemini', /gemini|google-labs-jules/i],
  ['copilot', /copilot/i],
  ['devin', /devin-ai-integration/i],
  ['aider', /\baider\b/i],
]
export const agentOf = text => AGENTS.find(([, pattern]) => pattern.test(text))?.[0]

const FIELD = '\x1f'
const RECORD = '\x1e'

// Commits the person authored or committed (by any of their addresses) since
// `since`, across every repo found, each once however many clones hold it.
// A commit leaves the machine as a keyed hash of its id (`salt` is the
// person's own, from the server, so two machines agree and nobody else can
// look the id up), its day, and the agent it was made with, if any: named in
// a co-author trailer, or for Cursor (which adds none) found among the
// commits Cursor scored as holding lines its AI wrote (`cursor`, ids).
export async function collectCommits({ emails, roots, since, salt, cursor = new Set() }) {
  const cursorShort = [...cursor].filter(h => h.length < 40)
  const byCursor = sha => cursor.has(sha) || cursorShort.some(prefix => sha.startsWith(prefix))
  const mine = new Set(emails.map(e => e.toLowerCase()))
  const commits = new Map()
  const repos = await findRepos(roots)
  for (const repo of repos) {
    let out
    try {
      ;({ stdout: out } = await run(
        'git',
        [
          '-C',
          repo,
          'log',
          '--all',
          `--since=${since}`,
          `--format=%H${FIELD}%at${FIELD}%ae${FIELD}%ce${FIELD}%(trailers:key=Co-authored-by,valueonly,separator=|)${RECORD}`,
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      ))
    } catch {
      continue
    }
    for (const record of out.split(RECORD)) {
      const [sha, at, author, committer, coAuthors = ''] = record.trim().split(FIELD)
      if (!sha || !at) continue
      const authorMine = mine.has(author.toLowerCase())
      if (!authorMine && !mine.has(committer.toLowerCase())) continue
      if (commits.has(sha)) continue
      // An agent that authored the commit itself (author noreply@anthropic.com,
      // committed by the person) counts like a co-author.
      const agent = agentOf(coAuthors) ?? (authorMine ? undefined : agentOf(author)) ?? (byCursor(sha) ? 'cursor' : undefined)
      commits.set(sha, { date: dayOfEpoch(Number(at)), agent: agent ?? null })
    }
  }
  return {
    repos: repos.length,
    commits: [...commits].map(([sha, c]) => ({ h: createHmac('sha256', salt).update(sha).digest('hex').slice(0, 20), ...c })),
  }
}

// Every author address in the repos, with how often it appears: the choices
// `vibestreak emails scan` offers, since one person often commits as several.
export async function scanEmails({ roots, since }) {
  const counts = new Map()
  for (const repo of await findRepos(roots)) {
    try {
      const { stdout } = await run('git', ['-C', repo, 'log', '--all', `--since=${since}`, '--format=%ae'], {
        maxBuffer: 64 * 1024 * 1024,
      })
      for (const email of stdout.split('\n').filter(Boolean)) counts.set(email, (counts.get(email) ?? 0) + 1)
    } catch {
      // Not a readable repo: skipped.
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

// The addresses this person commits as, by their own git config: the global
// one, and any a repo sets for itself (a work address in work repos). Other
// people's addresses in the same repos are never picked up this way.
export async function configuredEmails(roots = DEFAULT_ROOTS) {
  const local = await Promise.all(
    (await findRepos(roots)).map(repo =>
      run('git', ['-C', repo, 'config', '--local', '--get', 'user.email']).then(
        r => r.stdout.trim(),
        () => '',
      ),
    ),
  )
  return [...new Set([await globalEmail(), ...local].filter(e => e && e.includes('@')))]
}

export async function globalEmail() {
  try {
    return (await run('git', ['config', '--global', 'user.email'])).stdout.trim() || undefined
  } catch {
    return undefined
  }
}
