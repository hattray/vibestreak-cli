import assert from 'node:assert/strict'
import { test } from 'node:test'

import { becomeOwnMachine } from '../src/config.mjs'
import { hardwareFrom, hardwareId } from '../src/hardware.mjs'

test('hardware ids are read from each OS’s own output', () => {
  const ioreg = '+-o J314sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "1A2B3C4D-0000-1111-2222-333344445555"\n'
  assert.equal(hardwareFrom('darwin', ioreg), '1A2B3C4D-0000-1111-2222-333344445555')
  const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    9f8e7d6c-1111-2222-3333-444455556666\r\n'
  assert.equal(hardwareFrom('win32', reg), '9f8e7d6c-1111-2222-3333-444455556666')
  assert.equal(hardwareFrom('linux', '0123456789abcdef0123456789abcdef\n'), '0123456789abcdef0123456789abcdef')
  assert.equal(hardwareFrom('linux', ''), undefined)
  assert.equal(hardwareFrom('darwin', 'nothing here'), undefined)
})

test('this computer’s hardware id is sent only as a short hash', async () => {
  const id = await hardwareId()
  if (id !== undefined) assert.match(id, /^[0-9a-f]{32}$/)
})

test('a copied config takes its own machine id and resumes from its last sync', () => {
  const config = { machineId: 'copied-0001', machineName: 'Old-Mac', lastSync: '2026-11-01T15:17:08.000Z' }
  const since = becomeOwnMachine(config, new Date('2026-11-05T12:00:00'))
  assert.notEqual(config.machineId, 'copied-0001')
  assert.match(config.machineId, /^[\w-]{8,64}$/)
  const last = new Date('2026-11-01T15:17:08.000Z')
  assert.equal(since, `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`)
  assert.equal(becomeOwnMachine({}, new Date(2026, 10, 5, 12)), '2026-11-05', 'never synced: from today')
})
