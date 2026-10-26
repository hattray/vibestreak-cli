import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cronBlock, jobs, launchdPlist, nextRun, SYNC_TIMES, systemdUnits, windowsScript, windowsTaskName, withCronBlock } from '../src/autosync.mjs'
import { windowsToastCommand } from '../src/nudge.mjs'
import { immutableUri } from '../src/sqlite.mjs'

test('SQLite URIs open files immutable on every OS', () => {
  assert.equal(immutableUri('/Users/a/Library/Application Support/x.db', false), 'file:/Users/a/Library/Application Support/x.db?immutable=1')
  assert.equal(immutableUri('C:\\Users\\a\\AppData\\Roaming\\Cursor\\state.vscdb', true), 'file:/C:/Users/a/AppData/Roaming/Cursor/state.vscdb?immutable=1')
  assert.equal(immutableUri('/tmp/a?b#c%d.db', false), 'file:/tmp/a%3Fb%23c%25d.db?immutable=1')
})

test('the schedule: three syncs and an evening nudge, or no nudge', () => {
  assert.deepEqual(jobs(true).map(j => [j.name, j.times.length]), [['sync', 3], ['nudge', 1]])
  assert.deepEqual(jobs(false).map(j => j.name), ['sync'])
  assert.deepEqual(jobs(true)[1].args, ['nudge', 'run', '--quiet', '--scheduled'])
  assert.deepEqual(jobs(true)[1].times, [[20, 30]])
  assert.deepEqual(jobs(true, [21, 45])[1].times, [[21, 45]])
  assert.match(cronBlock('/n', '/b', true, '/l', [22, 15]), /^15 22 \* \* \* .*'nudge' 'run'/m)
})

test('the next sync is the next time today, else tomorrow’s first', () => {
  const next = nextRun(SYNC_TIMES, new Date(2026, 9, 25, 10, 0))
  assert.deepEqual([next.day, next.at.getHours(), next.at.getMinutes()], ['today', 13, 17])
  const late = nextRun(SYNC_TIMES, new Date(2026, 9, 25, 21, 0))
  assert.deepEqual([late.day, late.at.getDate(), late.at.getHours()], ['tomorrow', 26, 9])
})

test('macOS: one launchd agent per job, every time listed', () => {
  const plist = launchdPlist('dev.vibestreak.sync', '/n', '/b.mjs', ['sync', '--quiet'], jobs(true)[0].times, '/l')
  assert.equal(plist.match(/<key>Hour<\/key>/g).length, 3)
  assert.match(plist, /<string>\/n<\/string><string>\/b\.mjs<\/string><string>sync<\/string>/)
})

test('Linux: systemd timers catch up after sleep; crontab keeps other entries', () => {
  const { service, timer } = systemdUnits('/usr/bin/node', '/home/x/my $dir 50%/v.mjs', jobs(true)[0], '/l')
  assert.match(service, /^ExecStart="\/usr\/bin\/node" "\/home\/x\/my \$\$dir 50%%\/v\.mjs" "sync" "--quiet" "--scheduled"$/m)
  assert.equal(timer.match(/^OnCalendar=/gm).length, 3)
  assert.match(timer, /Persistent=true/)
  const block = cronBlock('/n', "/it's/v.mjs", true, '/l')
  assert.equal(block.split('\n').length, 6)
  assert.match(block, /'\/it'\\''s\/v\.mjs'/)
  const replaced = withCronBlock(`0 1 * * * backup\n${cronBlock('/n', '/old', false, '/l')}\n`, block)
  assert.equal((replaced.match(/vibestreak:begin/g) ?? []).length, 1)
  assert.match(replaced, /^0 1 \* \* \* backup$/m)
  assert.doesNotMatch(replaced, /\/old/)
  assert.equal(withCronBlock(replaced, '').trim(), '0 1 * * * backup')
})

test('Windows: a task per time, each running a script that logs', () => {
  assert.equal(windowsTaskName(jobs(true)[1], [20, 30]), 'vibestreak\\nudge-2030')
  const script = windowsScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a\\100%\\v.mjs', jobs(true)[0], 'C:\\l.log')
  assert.equal(script, '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\100%%\\v.mjs" sync --quiet --scheduled >> "C:\\l.log" 2>&1\r\n')
})

test('Windows toasts carry their text as PowerShell string literals', () => {
  const [exe, args] = windowsToastCommand({ title: "It's 85 days", message: 'Keep it; $(rm -rf) stays text' })
  assert.equal(exe, 'powershell.exe')
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /CreateTextNode\('It''s 85 days'\)/)
  assert.match(script, /CreateTextNode\('Keep it; \$\(rm -rf\) stays text'\)/)
})
