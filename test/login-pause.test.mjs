import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deviceLogin } from '../src/login.mjs'
import { MAX_PAUSE_DAYS, parsePause, pausedUntil, untilText } from '../src/pause.mjs'

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('browser login: polls while pending, then returns the token', async () => {
  const calls = []
  const answers = [reply(202, { pending: true }), reply(429, {}), reply(200, { token: 'vs_x', handle: 'me' })]
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push([new URL(url).pathname, body])
    if (new URL(url).pathname === '/api/v1/device') return reply(200, { code: 'BCDF-2345', secret: 's3', verifyUrl: 'https://x.test/link?code=BCDF-2345', interval: 2, expiresIn: 600 })
    return answers.shift()
  }
  const opened = []
  const lines = []
  const result = await deviceLogin({ server: 'https://x.test', machine: 'Mac', fetchImpl, sleep: async () => {}, open: async u => opened.push(u) && true, log: l => lines.push(l) })
  assert.equal(result.token, 'vs_x')
  assert.deepEqual(calls[0], ['/api/v1/device', { machine: 'Mac' }])
  assert.equal(calls.filter(([p, b]) => p === '/api/v1/device/token' && b.secret === 's3').length, 3)
  assert.deepEqual(opened, ['https://x.test/link?code=BCDF-2345'])
  assert.match(lines.join('\n'), /BCDF-2345/)
})

test('browser login: a declined or expired request stops with the reason', async () => {
  const fetchImpl = async url =>
    new URL(url).pathname === '/api/v1/device' ? reply(200, { code: 'C', secret: 's', verifyUrl: 'u', interval: 1, expiresIn: 60 }) : reply(410, { error: 'expired or was declined' })
  await assert.rejects(deviceLogin({ server: 'https://x.test', machine: 'm', fetchImpl, sleep: async () => {}, open: async () => false, log: () => {} }), /declined/)
})

test('pause: tomorrow morning by default; hours and days up to the limit', () => {
  const from = new Date(2026, 9, 25, 21, 30)
  assert.deepEqual(parsePause(undefined, from), new Date(2026, 9, 26, 6, 0))
  assert.deepEqual(parsePause('3h', from), new Date(2026, 9, 26, 0, 30))
  assert.deepEqual(parsePause('2d', from), new Date(2026, 9, 27, 21, 30))
  assert.deepEqual(parsePause(`${MAX_PAUSE_DAYS}d`, from), new Date(from.getTime() + MAX_PAUSE_DAYS * 864e5))
  assert.throws(() => parsePause('8d', from), /up to|catches up/)
  assert.throws(() => parsePause('0h', from))
  assert.throws(() => parsePause('soon', from), /how long/)
})

test('pause: lasts until its time, then is over by itself', () => {
  const config = { pausedUntil: new Date(2026, 9, 26, 6).toISOString() }
  assert.ok(pausedUntil(config, new Date(2026, 9, 25, 23)))
  assert.equal(pausedUntil(config, new Date(2026, 9, 26, 6, 1)), undefined)
  assert.equal(pausedUntil({}, new Date()), undefined)
  assert.equal(untilText(new Date(2026, 9, 26, 6), new Date(2026, 9, 25, 23)), 'tomorrow 06:00')
})

test('version: compared as numbers; a notice only when behind', async () => {
  const { compareVersions, updateNotice, VERSION } = await import('../src/version.mjs')
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.3.0', '0.3.1') < 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(updateNotice({ latest: '0.3.1' }, { current: '0.3.1' }), undefined)
  assert.equal(updateNotice({ latest: undefined }, { current: '0.3.1' }), undefined)
  assert.match(updateNotice({ latest: '0.4.0' }, { current: '0.3.1', autosync: true }), /0\.4\.0 is out.*autosync on/)
})
