import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { CONFIG_PATH } from './config.mjs'
import { NUDGE_DEFAULT } from './nudge.mjs'

const run = promisify(execFile)

// Syncs through the day keep the Today board current; the evening run also
// checks whether the streak is about to end (`vibestreak nudge`).
export const SYNC_TIMES = [
  [9, 17],
  [13, 17],
  [17, 17],
]
export { NUDGE_DEFAULT as NUDGE_TIME }

export const clock = ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const configDir = () => dirname(CONFIG_PATH)
const logPath = () => join(configDir(), 'sync.log')

// The jobs to schedule: a sync at each sync time, and the evening nudge at
// the person's chosen time.
export const jobs = (nudge, nudgeTime = NUDGE_DEFAULT) => [
  { name: 'sync', args: ['sync', '--quiet', '--scheduled'], times: SYNC_TIMES },
  ...(nudge ? [{ name: 'nudge', args: ['nudge', 'run', '--quiet', '--scheduled'], times: [nudgeTime] }] : []),
]

// A CLI run through npx lives in npm's cache, which can be cleared; a
// scheduled job needs a copy that stays put, so autosync keeps one in the
// config folder (refreshed by every `autosync on`).
export async function stableBin(bin) {
  if (!/[/\\](_npx|npm-cache)[/\\]/.test(bin)) return bin
  const pkg = dirname(dirname(bin))
  const home = join(configDir(), 'cli')
  await rm(home, { recursive: true, force: true })
  await cp(pkg, home, { recursive: true, filter: src => !/[/\\](node_modules|test)([/\\]|$)/.test(src.slice(pkg.length)) })
  return join(home, 'bin', 'vibestreak.mjs')
}

// --- macOS: launchd agents ------------------------------------------------

const LAUNCHD = { sync: 'dev.vibestreak.sync', nudge: 'dev.vibestreak.nudge' }
const agents = () => join(homedir(), 'Library', 'LaunchAgents')

export function launchdPlist(label, node, bin, args, times, log) {
  const intervals = times.map(([h, m]) => `<dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${bin}</string>${args.map(a => `<string>${a}</string>`).join('')}</array>
  <key>StartCalendarInterval</key>
  <array>${intervals}</array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
}

const launchd = {
  async install(node, bin, nudge, nudgeTime) {
    await mkdir(agents(), { recursive: true })
    for (const job of jobs(true, nudgeTime)) {
      const plist = join(agents(), `${LAUNCHD[job.name]}.plist`)
      await run('launchctl', ['unload', plist]).catch(() => {})
      if (job.name === 'nudge' && !nudge) {
        await rm(plist, { force: true })
        continue
      }
      await writeFile(plist, launchdPlist(LAUNCHD[job.name], node, bin, job.args, job.times, logPath()))
      await run('launchctl', ['load', plist])
    }
    return 'launchd'
  },
  async status() {
    const has = name => existsSync(join(agents(), `${LAUNCHD[name]}.plist`))
    return { on: has('sync'), using: 'launchd', nudge: has('nudge') }
  },
  async remove() {
    for (const label of Object.values(LAUNCHD)) {
      const plist = join(agents(), `${label}.plist`)
      await run('launchctl', ['unload', plist]).catch(() => {})
      await rm(plist, { force: true })
    }
  },
}

// --- Linux: systemd user timers, else crontab -------------------------------

const units = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
// systemd's own quoting: backslash-escaped quotes and backslashes, and $ and %
// (its variables and specifiers) doubled.
const quoteArg = a => `"${a.replace(/(["\\])/g, '\\$1').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`

export function systemdUnits(node, bin, job, log) {
  const calendar = job.times.map(t => `OnCalendar=*-*-* ${clock(t)}:00`).join('\n')
  return {
    service: `[Unit]
Description=vibestreak ${job.name}

[Service]
Type=oneshot
ExecStart=${[node, bin, ...job.args].map(quoteArg).join(' ')}
StandardOutput=append:${log}
StandardError=append:${log}
`,
    // Persistent: a run missed while the machine slept happens when it wakes.
    timer: `[Unit]
Description=vibestreak ${job.name} schedule

[Timer]
${calendar}
Persistent=true

[Install]
WantedBy=timers.target
`,
  }
}

const CRON_BEGIN = '# vibestreak:begin'
const CRON_END = '# vibestreak:end'
const shellQuote = a => `'${a.replace(/'/g, `'\\''`)}'`

export function cronBlock(node, bin, nudge, log, nudgeTime) {
  const lines = jobs(nudge, nudgeTime).flatMap(job =>
    job.times.map(([h, m]) => `${m} ${h} * * * ${[node, bin, ...job.args].map(shellQuote).join(' ')} >> ${shellQuote(log)} 2>&1`),
  )
  return [CRON_BEGIN, ...lines, CRON_END].join('\n')
}

// The crontab with our block replaced (or removed, given no block).
export const withCronBlock = (current, block) => {
  const kept = current.replace(new RegExp(`\\n?${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, 'g'), '\n').trim()
  return `${[kept, block].filter(Boolean).join('\n')}\n`
}

async function writeCrontab(block) {
  const current = await run('crontab', ['-l']).then(r => r.stdout, () => '')
  await new Promise((resolve, reject) => {
    const child = execFile('crontab', ['-'], error => (error ? reject(error) : resolve()))
    child.stdin.end(withCronBlock(current, block))
  })
}

const hasUserSystemd = () => run('systemctl', ['--user', 'show-environment']).then(() => true, () => false)

const linux = {
  async install(node, bin, nudge, nudgeTime) {
    if (await hasUserSystemd()) {
      await mkdir(units(), { recursive: true })
      for (const job of jobs(true, nudgeTime)) {
        const name = `vibestreak-${job.name}`
        if (job.name === 'nudge' && !nudge) {
          await run('systemctl', ['--user', 'disable', '--now', `${name}.timer`]).catch(() => {})
          await rm(join(units(), `${name}.timer`), { force: true })
          await rm(join(units(), `${name}.service`), { force: true })
          continue
        }
        const { service, timer } = systemdUnits(node, bin, job, logPath())
        await writeFile(join(units(), `${name}.service`), service)
        await writeFile(join(units(), `${name}.timer`), timer)
      }
      await run('systemctl', ['--user', 'daemon-reload'])
      for (const job of jobs(nudge)) await run('systemctl', ['--user', 'enable', '--now', `vibestreak-${job.name}.timer`])
      return 'systemd'
    }
    await writeCrontab(cronBlock(node, bin, nudge, logPath(), nudgeTime))
    return 'crontab'
  },
  async status() {
    if (existsSync(join(units(), 'vibestreak-sync.timer'))) {
      return { on: true, using: 'systemd', nudge: existsSync(join(units(), 'vibestreak-nudge.timer')) }
    }
    const cron = await run('crontab', ['-l']).then(r => r.stdout, () => '')
    const block = cron.match(new RegExp(`${CRON_BEGIN}[\\s\\S]*?${CRON_END}`))?.[0] ?? ''
    return { on: /\bsync\b/.test(block), using: 'crontab', nudge: /\bnudge\b/.test(block) }
  },
  async remove() {
    for (const name of ['vibestreak-sync', 'vibestreak-nudge']) {
      await run('systemctl', ['--user', 'disable', '--now', `${name}.timer`]).catch(() => {})
      await rm(join(units(), `${name}.timer`), { force: true })
      await rm(join(units(), `${name}.service`), { force: true })
    }
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {})
    await writeCrontab('').catch(() => {})
  },
}

// --- Windows: Task Scheduler ------------------------------------------------

// Each task runs a small .cmd in the config folder, so the command (and its
// log redirect) has no length limit and no quoting inside schtasks.
export const windowsTaskName = (job, [h, m]) => `vibestreak\\${job.name}-${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`
const cmdPath = p => p.replace(/%/g, '%%')
export const windowsScript = (node, bin, job, log) => `@echo off\r\n"${cmdPath(node)}" "${cmdPath(bin)}" ${job.args.join(' ')} >> "${cmdPath(log)}" 2>&1\r\n`

// Our tasks as Task Scheduler holds them, whatever times they were made for.
async function windowsTasks() {
  const { stdout } = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH']).catch(() => ({ stdout: '' }))
  const names = stdout.split(/\r?\n/).map(line => /^"([^"]+)"/.exec(line)?.[1]).filter(Boolean)
  return [...new Set(names.filter(n => /^\\vibestreak\\/i.test(n)).map(n => n.slice(1)))]
}

const windows = {
  async install(node, bin, nudge, nudgeTime) {
    await windows.remove()
    await mkdir(configDir(), { recursive: true })
    for (const job of jobs(nudge, nudgeTime)) {
      const script = join(configDir(), `${job.name}.cmd`)
      await writeFile(script, windowsScript(node, bin, job, logPath()))
      for (const time of job.times) {
        await run('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', clock(time), '/TN', windowsTaskName(job, time), '/TR', `"${script}"`])
      }
    }
    return 'Task Scheduler'
  },
  async status() {
    const names = await windowsTasks()
    return { on: names.some(n => /\\sync-/i.test(n)), using: 'Task Scheduler', nudge: names.some(n => /\\nudge-/i.test(n)) }
  },
  async remove() {
    for (const name of await windowsTasks()) await run('schtasks', ['/Delete', '/F', '/TN', name]).catch(() => {})
  },
}

const SCHEDULERS = { darwin: launchd, linux, win32: windows }

// Schedules the background syncs (and the evening nudge) with the system's
// own scheduler.
export async function installAutosync(bin, { nudge = true, nudgeTime = NUDGE_DEFAULT } = {}) {
  const scheduler = SCHEDULERS[platform()]
  const times = SYNC_TIMES.map(clock)
  const nudgeAt = nudge ? clock(nudgeTime) : undefined
  if (!scheduler) {
    return { installed: false, hint: `No scheduler support on ${platform()} yet. Run \`${bin} sync --quiet\` at ${times.join(', ')}${nudge ? ` and \`nudge --quiet\` at ${nudgeAt}` : ''}.` }
  }
  await mkdir(configDir(), { recursive: true })
  const using = await scheduler.install(process.execPath, await stableBin(bin), nudge, nudgeTime)
  return { installed: true, using, times, nudgeAt, log: logPath() }
}

// What the system's scheduler holds now: whether the syncs and the nudge are scheduled.
export async function autosyncStatus() {
  const scheduler = SCHEDULERS[platform()]
  return scheduler ? scheduler.status() : { on: false, using: undefined, nudge: false }
}

// The next of the given daily times after `now`: today if one is still ahead, else tomorrow's first.
export function nextRun(times, now = new Date()) {
  const today = times.map(([h, m]) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)).sort((a, b) => a - b)
  const later = today.find(t => t > now)
  if (later) return { at: later, day: 'today' }
  const [first] = today
  return { at: new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1, first.getHours(), first.getMinutes()), day: 'tomorrow' }
}

export async function removeAutosync() {
  await SCHEDULERS[platform()]?.remove()
  return { removed: true }
}
