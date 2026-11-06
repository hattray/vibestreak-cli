import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Which computer this is, as a hash of the id the OS keeps for it (the id
// itself never leaves the machine). A config copied to a new computer keeps
// its machine id but not this, so the server can tell the two apart.
// Undefined when the OS won't say.
export async function hardwareId(platform = process.platform) {
  const raw = await readHardware(platform).catch(() => undefined)
  return raw ? createHash('sha256').update(`vibestreak-hw:${raw}`).digest('hex').slice(0, 32) : undefined
}

async function readHardware(platform) {
  if (platform === 'darwin') return hardwareFrom(platform, (await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])).stdout)
  if (platform === 'win32') return hardwareFrom(platform, (await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true })).stdout)
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const id = hardwareFrom(platform, await readFile(path, 'utf8').catch(() => ''))
    if (id) return id
  }
}

export function hardwareFrom(platform, text) {
  if (platform === 'darwin') return /"IOPlatformUUID" = "([^"]+)"/.exec(text)?.[1]
  if (platform === 'win32') return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(text)?.[1]
  return text.trim() || undefined
}
