import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FULL_DAYS, RECENT_DAYS, sinceDate, syncSince } from '../src/collect.mjs'
import { walk } from '../src/files.mjs'

test('the first sync sends history; later ones the last week (the server keeps no more)', () => {
  assert.equal(syncSince({ server: 's' }), sinceDate(FULL_DAYS))
  assert.equal(syncSince({ server: 's', lastSync: 'x', lastSyncServer: 's' }), sinceDate(RECENT_DAYS))
  assert.equal(syncSince({ server: 's', lastSync: 'x', lastSyncServer: 's' }, { full: true }), sinceDate(FULL_DAYS))
  // Linked to another server: a first sync there.
  assert.equal(syncSince({ server: 't', lastSync: 'x', lastSyncServer: 's' }), sinceDate(FULL_DAYS))
  assert.equal(syncSince({ server: 's' }, { since: '2026-01-01' }), '2026-01-01')
})

test('files untouched since the window opened are skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibestreak-'))
  writeFileSync(join(dir, 'old.jsonl'), '')
  writeFileSync(join(dir, 'new.jsonl'), '')
  const old = new Date('2026-01-01T12:00:00')
  utimesSync(join(dir, 'old.jsonl'), old, old)
  const found = []
  for await (const path of walk(dir, '.jsonl', '2026-06-01')) found.push(path.split(/[/\\]/).pop())
  assert.deepEqual(found, ['new.jsonl'])
  const all = []
  for await (const path of walk(dir, '.jsonl')) all.push(path)
  assert.equal(all.length, 2)
})
