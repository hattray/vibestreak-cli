#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { autosyncStatus, clock, installAutosync, nextRun, removeAutosync, SYNC_TIMES } from '../src/autosync.mjs'
import { NUDGE_DEFAULT, notify, nudgeAction, nudgeText, nudgeTimeOf, parseNudgeTime, shouldNudge } from '../src/nudge.mjs'
import { collect, sinceDate, summarize, syncSince } from '../src/collect.mjs'
import { CONFIG_PATH, loadConfig, saveConfig } from '../src/config.mjs'
import { configuredEmails, DEFAULT_ROOTS, globalEmail, scanEmails } from '../src/git.mjs'
import { deviceLogin } from '../src/login.mjs'
import { parsePause, pausedUntil, untilText } from '../src/pause.mjs'
import { updateCommand, updateNotice, VERSION } from '../src/version.mjs'
import { boardView, dashboardView, profileView, todayView } from '../src/views.mjs'

const BRAND = process.env.VIBESTREAK_BRAND ?? 'vibestreak'
const DEFAULT_SERVER = process.env.VIBESTREAK_SERVER ?? 'https://vibestreak.dev'

const HELP = `${BRAND} ${VERSION} — share your AI coding heatmap: what you shipped, and how steadily.

  ${BRAND}                           your streak, heatmap and rank at a glance
                                     (the first time: sets this machine up)
  ${BRAND} me                        your profile: streak, heatmap, totals
  ${BRAND} profile <handle>          someone else's public profile
  ${BRAND} board [today|7d|30d|90d|all] [consistency|shipped|streak|tokens] [tool]
                                     the leaderboard (--from/--to for your own dates)
  ${BRAND} today                     who is coding with AI today; streaks at risk

  ${BRAND} collect [--json]          preview what would be sent (nothing leaves the machine)
  ${BRAND} setup [--token <t>]       link, sync and turn on autosync and the nudge
                                     with the defaults, asking nothing
  ${BRAND} login                     link this machine in the browser
                                     (or --token <t> from your settings page)
  ${BRAND} sync [--quiet]            collect and upload daily totals
  ${BRAND} emails [scan|add <e>|remove <e>]
                                     the addresses you commit as (all of your accounts)
  ${BRAND} roots [add <dir>|remove <dir>]
                                     where to look for git repos
  ${BRAND} status                    profile, last sync, streak, autosync and nudge
  ${BRAND} autosync [on|off]         sync in the background through the day
  ${BRAND} nudge [on|off|test]       an evening notification when your streak is
                                     about to end (on with autosync); alone, its status
  ${BRAND} nudge at 21:45            when it checks (17:00 to 23:30; default 20:30)
  ${BRAND} pause [1h|3d|tomorrow]    pause background syncs and the nudge (up to 7
                                     days; default until tomorrow 06:00)
  ${BRAND} resume                    end a pause now
  ${BRAND} whoami                    the profile this machine syncs to
  ${BRAND} --version                 this CLI's version

Reads: Claude Code, Codex, Cursor, Copilot (CLI and VS Code), Gemini CLI,
Antigravity and OpenCode history, and git.
Sent: per day and tool, message, tool-call, session and token counts and model
names; per commit you authored, a keyed hash, its day and the AI agent named in
its co-author trailer. Never prompts, code, file paths, repo names or messages.
Config: ${CONFIG_PATH}
All commands, with examples: ${DEFAULT_SERVER}/cli`

const fmt = n => n.toLocaleString('en-US')

async function api(config, path, init = {}) {
  if (!config.server || !config.token) throw new Error(`Not linked yet: run \`${BRAND} login\`.`)
  const response = await fetch(new URL(path, config.server), {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'x-vibestreak-cli': VERSION, 'user-agent': `${BRAND}/${VERSION}`, ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error ?? `${response.status} ${response.statusText}`), { status: response.status })
  return body
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      token: { type: 'string' },
      server: { type: 'string' },
      since: { type: 'string' },
      full: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string' },
      // Set by the background jobs, so a pause skips them and nothing else.
      scheduled: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  const [command = 'dashboard', ...rest] = positionals
  const config = await loadConfig()
  const log = (...args) => values.quiet || console.log(...args)

  if (command === 'help' || values.help) return console.log(HELP)
  if (command === 'version' || values.version) return console.log(VERSION)
  const columns = process.stdout.columns || 100
  const server = config.server ?? DEFAULT_SERVER

  if (command === 'dashboard') {
    // Plain `vibestreak`: the dashboard once linked; before that, setup (or,
    // with no one at the keyboard, how to start).
    if (!config.token) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return console.log(`${HELP}\n\nGet started: ${server.replace(/\/$/, '')}/cli`)
      return setup(config, values, { ask: !values.yes })
    }
    const me = await api(config, '/api/v1/me')
    await dashboardView({ server, token: config.token, handle: me.handle, columns })
    return notice(config, me.cli)
  }
  if (command === 'me') {
    const me = await api(config, '/api/v1/me')
    return profileView({ server, token: config.token, handle: me.handle, columns })
  }
  if (command === 'profile') {
    if (!rest[0]) throw new Error(`Whose? \`${BRAND} profile <handle>\` (yours: \`${BRAND} me\`).`)
    return profileView({ server, token: config.token, handle: rest[0].replace(/^@/, ''), columns })
  }
  if (command === 'board') {
    const you = config.token ? (await api(config, '/api/v1/me').catch(() => null))?.handle : undefined
    return boardView({ server, words: rest, values, you, columns })
  }
  if (command === 'today') return todayView({ server })

  if (command === 'emails') {
    const [action, email] = rest
    if (!config.emails.length) {
      const first = await globalEmail()
      if (first) config.emails = [first]
    }
    if (action === 'add' && email) config.emails = [...new Set([...config.emails, email])]
    if (action === 'remove' && email) config.emails = config.emails.filter(e => e !== email)
    if (action === 'scan') {
      console.log('Author addresses in your repos (last 400 days); add each one that is you:\n')
      for (const [address, count] of await scanEmails({ roots: config.roots ?? DEFAULT_ROOTS, since: sinceDate() })) {
        console.log(`  ${config.emails.includes(address) ? '✓' : ' '} ${String(count).padStart(6)}  ${address}`)
      }
      console.log(`\n  ${BRAND} emails add <address>`)
    }
    await saveConfig(config)
    if (action !== 'scan') console.log(config.emails.length ? config.emails.join('\n') : 'No addresses yet.')
    return
  }

  if (command === 'roots') {
    const [action, dir] = rest
    const roots = config.roots ?? DEFAULT_ROOTS
    if (action === 'add' && dir) config.roots = [...new Set([...roots, dir])]
    if (action === 'remove' && dir) config.roots = roots.filter(r => r !== dir)
    await saveConfig(config)
    return console.log((config.roots ?? DEFAULT_ROOTS).join('\n'))
  }

  if (command === 'login') return login(config, values)
  if (command === 'setup') return setup(config, values, { ask: false })

  if (command === 'pause') {
    const until = parsePause(rest[0])
    config.pausedUntil = until.toISOString()
    await saveConfig(config)
    await refreshJobs(config)
    return console.log(
      `Paused until ${untilText(until)}: no background syncs or streak nudge until then.` +
        ` The first sync after it uploads everything you did meanwhile. \`${BRAND} resume\` ends it sooner.`,
    )
  }
  if (command === 'resume') {
    const was = pausedUntil(config)
    delete config.pausedUntil
    await saveConfig(config)
    await refreshJobs(config)
    return console.log(was ? `Resumed: background syncs${config.nudge === false ? '' : ' and the nudge'} run again from the next scheduled time.` : 'Not paused.')
  }

  if (command === 'whoami') {
    const me = await api(config, '/api/v1/me')
    return console.log(`${me.handle} · ${me.profileUrl}\nGitHub: ${me.github.join(', ')}\nMachine: ${config.machineName}`)
  }

  if (command === 'collect' || command === 'sync') {
    const until = values.scheduled && pausedUntil(config)
    if (until) return console.log(`${new Date().toISOString()} paused until ${until.toISOString()}; skipped`)
    return sync(config, values, log, command === 'sync').catch(error => (values.scheduled ? tooOldNotice(config, error) : Promise.reject(error)))
  }

  if (command === 'status') return status(config)

  if (command === 'nudge') {
    const bin = fileURLToPath(import.meta.url)
    const action = nudgeAction(rest, values)
    if (action === 'status') return nudgeStatus(config)
    if (action === 'at') {
      const time = parseNudgeTime(rest[1])
      config.nudgeTime = clock(time)
      if (rest[1].trim().toLowerCase() === 'default') delete config.nudgeTime
      await saveConfig(config)
      const scheduled = await autosyncStatus()
      if (scheduled.on && config.nudge !== false) await installAutosync(bin, { nudge: true, nudgeTime: time })
      const note = config.nudge === false ? ` It's off: \`${BRAND} nudge on\` turns it on.` : !scheduled.on ? ` It runs once autosync is on: \`${BRAND} autosync on\`.` : ''
      return console.log(`Streak check at ${clock(time)}${clock(time) === clock(NUDGE_DEFAULT) ? ' (the default)' : ''}.${note}`)
    }
    if (action === 'on' || action === 'off') {
      config.nudge = action === 'on'
      await saveConfig(config)
      if (config.autosync) await installAutosync(bin, { nudge: config.nudge, nudgeTime: nudgeTimeOf(config) })
      return console.log(`Streak nudge ${config.nudge ? `on: ${clock(nudgeTimeOf(config))} each evening when your streak is at risk` : 'off'}.`)
    }
    if (action === 'test') {
      const { streak } = await api(config, '/api/v1/me')
      await notify(nudgeText({ ...streak, current: Math.max(1, streak.current) }))
      return console.log(`Sent a test notification (your streak: ${streak.current} days; ${streak.activeToday ? 'active today' : 'not active yet today'}).`)
    }
    // `nudge run`, the evening job: sync, then nudge if the streak would end at midnight.
    const until = pausedUntil(config)
    if (until) return console.log(`${new Date().toISOString()} paused until ${until.toISOString()}; skipped`)
    const result = await sync(config, values, log, true).catch(error => tooOldNotice(config, error))
    if (shouldNudge(result.streak, config)) {
      await notify(nudgeText(result.streak))
      config.lastNudge = result.streak.today
      await saveConfig(config)
      console.log(`${new Date().toISOString()} nudged: ${result.streak.current}-day streak at risk`)
    }
    return
  }

  if (command === 'autosync') {
    if (rest[0] === 'off') {
      config.autosync = false
      await saveConfig(config)
      return console.log(await removeAutosync())
    }
    const result = await installAutosync(fileURLToPath(import.meta.url), { nudge: config.nudge !== false, nudgeTime: nudgeTimeOf(config) })
    config.autosync = result.installed
    await saveConfig(config)
    return console.log(
      result.installed
        ? `Syncing at ${result.times.join(', ')} via ${result.using}${result.nudgeAt ? `; streak check at ${result.nudgeAt}` : ''}. Log: ${result.log}`
        : result.hint,
    )
  }

  console.log(HELP)
  process.exitCode = 1
}

// Links this machine: in the browser by default, or with a token from the
// settings page (for machines without one).
async function login(config, values, { addresses = true } = {}) {
  config.server = values.server ?? config.server ?? DEFAULT_SERVER
  const site = config.server.replace(/\/$/, '')
  console.log(`Your profile (GitHub username, avatar, heatmap, streak) will be public on ${BRAND} and its leaderboard; you can hide it in Settings.`)
  console.log(`Linking means you agree to the Terms (${site}/terms) and Privacy policy (${site}/privacy).\n`)
  if (values.token) config.token = values.token
  else config.token = (await deviceLogin({ server: config.server, machine: config.machineName })).token
  const me = await api(config, '/api/v1/me')
  if (!config.emails.length) {
    const first = await globalEmail()
    if (first) config.emails = [first]
  }
  await saveConfig(config)
  console.log(`Linked ${config.machineName} to @${me.handle} (${me.profileUrl}).`)
  if (addresses) console.log(`Commit addresses: ${config.emails.join(', ') || 'none'}; \`${BRAND} emails scan\` finds your other accounts' addresses.`)
  return me
}

// Everything a machine needs, with the defaults: linked (in the browser, or
// with --token), the commit addresses from git config, the usual repo
// folders, a first sync, and autosync with the evening nudge. The first plain
// `npx vibestreak` asks about autosync; `setup` asks nothing.
async function setup(config, values, { ask: interactive }) {
  console.log(`${BRAND}: your AI coding heatmap and streak, from this machine's history.\n`)
  console.log('Nothing but daily counts leaves this machine: never prompts, code, file paths or repo names.')
  console.log(`(\`${BRAND} collect\` previews it all without sending anything.)\n`)
  await login(config, values, { addresses: false })
  const found = await configuredEmails(config.roots ?? DEFAULT_ROOTS)
  config.emails = [...new Set([...config.emails, ...found])]
  await saveConfig(config)
  console.log(`Counting commits by ${config.emails.join(', ') || 'no address yet'} (from git config) and your GitHub accounts' noreply addresses.`)
  console.log('\nFirst sync: reading your history (a minute for a big one)…')
  await sync(config, values, console.log, true)
  const yes = !interactive || (await ask(`\nKeep it up to date in the background (${SYNC_TIMES.map(clock).join(', ')}) and nudge you at ${clock(nudgeTimeOf(config))} when your streak is about to end? [Y/n] `))
  if (yes) {
    const result = await installAutosync(fileURLToPath(import.meta.url), { nudge: config.nudge !== false, nudgeTime: nudgeTimeOf(config) })
    config.autosync = result.installed
    await saveConfig(config)
    console.log(result.installed ? `On: syncing via ${result.using}. \`${BRAND} pause\` or \`${BRAND} autosync off\` any time.` : result.hint)
  } else console.log(`Off. \`${BRAND} sync\` updates it, or \`${BRAND} autosync on\` later.`)
  console.log(`\nDone. \`${BRAND}\` shows your streak. Commit from other addresses too? \`${BRAND} emails scan\` lists them. \`${BRAND} help\` lists everything.`)
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return !/^n/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

// The background jobs run a copy of the CLI kept in the config folder: a
// pause or resume refreshes it, so the jobs run code that knows about pauses.
async function refreshJobs(config) {
  if (config.autosync) await installAutosync(fileURLToPath(import.meta.url), { nudge: config.nudge !== false, nudgeTime: nudgeTimeOf(config) })
}

// Collects this machine's totals and, for a sync, uploads them; the server
// answers with where the streak stands (the nudge's input).
async function sync(config, values, log, isSync) {
  const me = isSync ? await api(config, '/api/v1/me') : undefined
  const emails = [...new Set([...config.emails, ...(me?.emails ?? [])])]
  if (!emails.length) {
    const first = await globalEmail()
    if (first) emails.push(first)
  }
  const started = Date.now()
  const payload = await collect({ config: { ...config, emails }, salt: me?.salt ?? config.localSalt, since: isSync ? syncSince(config, values) : values.since })
  if (values.json) return console.log(JSON.stringify(payload, null, 2))
  const s = summarize(payload)
  log(`${s.activeDays} active days since ${payload.since} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  for (const [tool, t] of Object.entries(s.tools)) {
    log(`  ${tool.padEnd(11)} ${String(t.days).padStart(4)} days  ${fmt(t.messages).padStart(10)} messages  ${fmt(t.toolCalls).padStart(9)} tool calls  ${fmt(t.tokens).padStart(16)} tokens`)
  }
  log(`  ${'commits'.padEnd(11)} ${fmt(s.commits)} by you in ${s.repos} repos, ${fmt(s.aiCommits)} with an AI co-author (${emails.join(', ') || 'no addresses'})`)
  if (!isSync) return log(`\nNothing was sent. \`${BRAND} sync\` uploads these totals.`)
  const result = await api(config, '/api/v1/upload', { method: 'POST', body: JSON.stringify(payload) })
  config.lastSync = new Date().toISOString()
  config.lastSyncServer = config.server
  config.lastSyncSummary = { days: result.days, commits: result.commits, repos: s.repos }
  if (result.underReview) console.log(`Your profile is under review and off the boards for now: see ${new URL('/settings#trust', config.server)}`)
  await saveConfig(config)
  // Always one line, quiet or not: the background sync's log is how a person sees it ran.
  const streak = result.streak ? ` · streak ${result.streak.current}d${result.streak.activeToday ? '' : ' (not yet today)'}` : ''
  console.log(`${config.lastSync} uploaded ${result.days} days, ${result.commits} commits from ${s.repos} repos${streak} → ${result.profileUrl}`)
  if (!values.quiet) notice(config, result.cli)
  return result
}

// A background run the server turned away as too old: nobody reads the log,
// and the streak would end unnoticed, so say so on screen, once a day.
async function tooOldNotice(config, error) {
  const today = new Date().toISOString().slice(0, 10)
  if (error.status === 426 && config.lastUpdateNotice !== today) {
    await notify({ title: 'Update to keep your streak', message: `This version can no longer sync. Run: npx ${BRAND}@latest autosync on` })
    config.lastUpdateNotice = today
    await saveConfig(config)
  }
  throw error
}

// Says so when a newer CLI is out (the server checks npm).
function notice(config, cli) {
  const line = updateNotice(cli, { brand: BRAND, autosync: config.autosync })
  if (line) console.log(`\n${line}`)
}

const ago = iso => {
  if (!iso) return 'never'
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`
}
const at = ({ at, day }) => `${day} ${clock([at.getHours(), at.getMinutes()])}`

// The server's view of the streak, or why it can't be had (not linked, offline).
async function serverStatus(config) {
  if (!config.server || !config.token) return { error: `not linked: run \`${BRAND} login\`` }
  try {
    return await api(config, '/api/v1/me')
  } catch (error) {
    return { error: error.message }
  }
}

function streakLine(streak) {
  if (!streak) return 'unknown'
  const today = streak.activeToday ? 'active today' : streak.current > 0 ? 'not yet today: ends at midnight' : 'no live streak'
  const next = streak.next ? ` · ${streak.next.remaining} ${streak.next.remaining === 1 ? 'day' : 'days'} to ${streak.next.name}` : ''
  return `${streak.current} ${streak.current === 1 ? 'day' : 'days'} · ${today}${next}`
}

async function nudgeStatus(config) {
  const [scheduled, me] = await Promise.all([autosyncStatus(), serverStatus(config)])
  const on = config.nudge !== false && scheduled.nudge
  const why = config.nudge === false ? ` (\`${BRAND} nudge on\` turns it on)` : !scheduled.on ? ` (needs autosync: \`${BRAND} autosync on\`)` : ''
  const time = clock(nudgeTimeOf(config))
  console.log(`Nudge       ${on ? `on · checks at ${time}${config.nudgeTime ? '' : ' (default; `nudge at 21:45` changes it)'}` : `off${why}`}`)
  console.log(`Last nudge  ${config.lastNudge ?? 'never'}`)
  if (me.error) return console.log(`Tonight     unknown (${me.error})`)
  const s = me.streak
  const paused = pausedUntil(config)
  if (paused) console.log(`Paused      until ${untilText(paused)}`)
  const tonight = !on ? 'no check' : paused && paused > nextRun([nudgeTimeOf(config)]).at ? 'no check: paused' : s.activeToday ? 'no nudge: you were active today' : s.current > 0 ? (config.lastNudge === s.today ? 'already nudged today' : `will nudge at ${time} unless you code with AI first`) : 'no nudge: no live streak'
  console.log(`Streak      ${streakLine(s)}`)
  console.log(`Tonight     ${tonight}`)
}

async function status(config) {
  const [scheduled, me] = await Promise.all([autosyncStatus(), serverStatus(config)])
  const row = (label, value) => console.log(`${label.padEnd(11)} ${value}`)
  row('Profile', me.error ? me.error : `@${me.handle} · ${me.profileUrl}`)
  if (!me.error && me.github?.length) row('GitHub', me.github.map(g => `github.com/${g}`).join(', '))
  row('Machine', config.machineName)
  const last = config.lastSyncSummary
  row('Last sync', config.lastSync ? `${ago(config.lastSync)}${last ? ` · ${last.days} days, ${last.commits} commits from ${last.repos} repos` : ''}` : `never: run \`${BRAND} sync\``)
  if (!me.error) row('Streak', streakLine(me.streak))
  row('Autosync', scheduled.on ? `on (${scheduled.using}) · next sync ${at(nextRun(SYNC_TIMES))}` : `off: \`${BRAND} autosync on\` syncs at ${SYNC_TIMES.map(clock).join(', ')}`)
  const paused = pausedUntil(config)
  if (paused) row('Paused', `until ${untilText(paused)}: background syncs and the nudge skip their runs (\`${BRAND} resume\` ends it)`)
  const nudgeOn = config.nudge !== false && scheduled.nudge
  row('Nudge', nudgeOn ? `on · checks at ${clock(nudgeTimeOf(config))} · last nudged ${config.lastNudge ?? 'never'}` : config.nudge === false ? 'off' : 'off (needs autosync)')
  const github = me.error ? 0 : (me.emails?.length ?? 0)
  row('Addresses', `${config.emails.join(', ') || 'none'}${github ? ` · +${github} from GitHub` : ''}`)
  const update = me.error ? undefined : updateNotice(me.cli, { brand: BRAND, autosync: config.autosync })
  row('Version', update ? `${VERSION} · ${me.cli.latest} is out: ${updateCommand(BRAND, config.autosync)}` : `${VERSION}${me.cli?.latest ? ' (latest)' : ''}`)
  row('Config', CONFIG_PATH)
}

main().catch(error => {
  console.error(`${BRAND}: ${error.message}`)
  process.exitCode = 1
})
