import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

// An SQLite URI opening the file immutable: read without locks, journals or
// shared memory, so another app's live database is never touched. Windows
// paths become /C:/…; characters URIs give meaning to are escaped.
export const immutableUri = (path, windows = process.platform === 'win32') =>
  `file:${windows ? '/' : ''}${path.replace(/\\/g, '/').replace(/[%?#]/g, c => encodeURIComponent(c))}?immutable=1`

// Node's own SQLite (node:sqlite, Node 22.13+), loaded once. Its
// experimental-feature warning is not this CLI's to print.
let DatabaseSync
async function nodeSqlite() {
  if (DatabaseSync !== undefined) return DatabaseSync
  const emit = process.emitWarning
  process.emitWarning = (warning, ...rest) => (/SQLite/.test(String(warning?.message ?? warning)) ? undefined : emit.call(process, warning, ...rest))
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    DatabaseSync = null
  } finally {
    process.emitWarning = emit
  }
  return DatabaseSync
}

// Rows of a query against an app's own SQLite file, opened read-only and
// immutable. Node's built-in SQLite where it has one (every OS, nothing to
// install), else the system `sqlite3`; with neither, or an unreadable file,
// no rows: that tool is skipped, never the sync.
export async function query(path, sql) {
  if (!existsSync(path)) return []
  const Db = await nodeSqlite()
  if (Db) {
    let db
    try {
      db = new Db(immutableUri(path), { readOnly: true })
      return db.prepare(sql).all()
    } catch {
      return []
    } finally {
      db?.close()
    }
  }
  try {
    const { stdout } = await run('sqlite3', ['-readonly', '-json', immutableUri(path, false), sql], { maxBuffer: 512 * 1024 * 1024 })
    return stdout.trim() ? JSON.parse(stdout) : []
  } catch {
    return []
  }
}

// --- Protobuf, enough to read numbers and strings out of an unknown message.

const varint = (b, i) => {
  let value = 0
  let scale = 1
  for (;;) {
    const byte = b[i++]
    if (byte === undefined) throw new RangeError('truncated')
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return [value, i]
    scale *= 128
  }
}

// A message's fields by number: varints as numbers, length-delimited fields
// as Buffers (a nested message is parsed by calling this again).
export function fields(buffer) {
  const out = new Map()
  let i = 0
  try {
    while (i < buffer.length) {
      const [key, next] = varint(buffer, i)
      i = next
      const number = Math.floor(key / 8)
      const wire = key % 8
      let value
      if (wire === 0) [value, i] = varint(buffer, i)
      else if (wire === 1) (value = buffer.subarray(i, i + 8)), (i += 8)
      else if (wire === 5) (value = buffer.subarray(i, i + 4)), (i += 4)
      else if (wire === 2) {
        const [length, start] = varint(buffer, i)
        value = buffer.subarray(start, start + length)
        i = start + length
      } else break
      if (!out.has(number)) out.set(number, [])
      out.get(number).push(value)
    }
  } catch {
    // A truncated tail: what was read so far stands.
  }
  return out
}

// The field at a path of numbers (`[1, 4]` is field 4 of field 1), first value each step.
export function at(buffer, path) {
  let value = buffer
  for (const number of path) {
    if (!Buffer.isBuffer(value)) return undefined
    value = fields(value).get(number)?.[0]
  }
  return value
}
