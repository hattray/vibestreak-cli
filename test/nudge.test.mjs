import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nudgeText, shouldNudge } from '../src/nudge.mjs'

const atRisk = { today: '2026-10-25', current: 85, longest: 85, activeToday: false, atRisk: true, next: { name: 'Quarter', days: 90, remaining: 5 } }

test('nudges a live streak with nothing yet today, once a day, unless turned off', () => {
  assert.equal(shouldNudge(atRisk, {}), true)
  assert.equal(shouldNudge({ ...atRisk, activeToday: true, atRisk: false }, {}), false)
  assert.equal(shouldNudge({ ...atRisk, current: 0, atRisk: false }, {}), false)
  assert.equal(shouldNudge(atRisk, { lastNudge: '2026-10-25' }), false)
  assert.equal(shouldNudge(atRisk, { lastNudge: '2026-10-24' }), true)
  assert.equal(shouldNudge(atRisk, { nudge: false }), false)
  assert.equal(shouldNudge(undefined, {}), false)
})

test('the nudge names the streak, and the level today would reach', () => {
  assert.deepEqual(nudgeText(atRisk).title, 'Your 85-day streak ends at midnight')
  assert.doesNotMatch(nudgeText(atRisk).message, /Quarter/)
  assert.match(nudgeText({ ...atRisk, current: 89 }).message, /Today makes it Quarter/)
  assert.equal(nudgeText({ ...atRisk, current: 1 }).title, 'Your 1-day streak ends at midnight')
})

test('plain `nudge` shows status; the scheduled forms run the check', async () => {
  const { nudgeAction } = await import('../src/nudge.mjs')
  assert.equal(nudgeAction([], {}), 'status')
  assert.equal(nudgeAction(['run'], { quiet: true }), 'run')
  // Jobs installed by 0.1.0 call `nudge --quiet`: still the check.
  assert.equal(nudgeAction([], { quiet: true }), 'run')
  for (const a of ['on', 'off', 'test']) assert.equal(nudgeAction([a], {}), a)
})

test('nudge times: typed as people type them, between 17:00 and 23:30', async () => {
  const { parseNudgeTime, nudgeTimeOf } = await import('../src/nudge.mjs')
  for (const [input, want] of [['21:45', [21, 45]], ['2145', [21, 45]], ['9:45pm', [21, 45]], ['9 PM', [21, 0]], ['21', [21, 0]], ['default', [20, 30]], ['17:00', [17, 0]], ['23:30', [23, 30]]]) {
    assert.deepEqual(parseNudgeTime(input), want, input)
  }
  assert.throws(() => parseNudgeTime('4pm'), /nearest is 17:00/)
  assert.throws(() => parseNudgeTime('11:45pm'), /nearest is 23:30/)
  assert.throws(() => parseNudgeTime('1am'), /nearest is 23:30/)
  assert.throws(() => parseNudgeTime('25:00'), /not a time of day/)
  assert.throws(() => parseNudgeTime('13pm'), /1 to 12/)
  assert.throws(() => parseNudgeTime(undefined), /not a time/)
  assert.deepEqual(nudgeTimeOf({}), [20, 30])
  assert.deepEqual(nudgeTimeOf({ nudgeTime: '22:15' }), [22, 15])
  assert.deepEqual(nudgeTimeOf({ nudgeTime: 'garbage' }), [20, 30])
})
