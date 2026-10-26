import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Every file under `root` whose name ends in `suffix`, symbolic links not
// followed; with `since` (YYYY-MM-DD), only files changed on or after that
// day (a file untouched since can hold nothing newer).
export async function* walk(root, suffix, since) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walk(path, suffix, since)
    else if (entry.isFile() && entry.name.endsWith(suffix)) {
      if (since && (await stat(path).catch(() => undefined))?.mtime < localMidnight(since)) continue
      yield path
    }
  }
}

const localMidnight = day => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const CHUNK = 4 * 1024 * 1024
const NEWLINE = 10

// A file's lines, read only as fast as they are taken. (readline's async
// iterator reads ahead without limit, which holds a whole 500 MB transcript
// in memory while the lines wait.)
export async function* lines(path) {
  const file = await open(path, 'r')
  try {
    let rest = Buffer.alloc(0)
    const chunk = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, CHUNK, null)
      if (bytesRead === 0) break
      const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      let start = 0
      for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
        if (end > start) yield data.toString('utf8', start, end)
        start = end + 1
      }
      rest = Buffer.from(data.subarray(start))
    }
    if (rest.length) yield rest.toString('utf8')
  } finally {
    await file.close()
  }
}
