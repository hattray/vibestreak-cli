import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export const CONFIG_PATH = process.env.VIBESTREAK_CONFIG ?? join(homedir(), '.config', 'vibestreak', 'config.json')

// What one machine remembers: its id (so its uploads replace each other and
// never double-count), the server and token it syncs to, the addresses its
// person commits as, and where it looks for repos.
export async function loadConfig() {
  let saved = {}
  try {
    saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    // First run.
  }
  return {
    machineId: saved.machineId ?? randomUUID(),
    machineName: saved.machineName ?? hostname().replace(/\.local$/, ''),
    // Used for commit hashes until the server hands out the person's own salt.
    localSalt: saved.localSalt ?? randomBytes(16).toString('hex'),
    emails: saved.emails ?? [],
    roots: saved.roots,
    server: saved.server,
    token: saved.token,
    ...saved,
  }
}

export async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}
