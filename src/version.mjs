import { readFileSync } from 'node:fs'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// Release versions only (x.y.z): negative when a is older than b.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

// One line when the server says a newer CLI is out; nothing otherwise. With
// autosync on, the update command also moves the background jobs to it.
export function updateNotice(cli, { brand = 'vibestreak', autosync = false, current = VERSION } = {}) {
  if (!cli?.latest || compareVersions(current, cli.latest) >= 0) return undefined
  return `${brand} ${cli.latest} is out (this is ${current}): ${updateCommand(brand, autosync)}.`
}

export const updateCommand = (brand, autosync) =>
  autosync ? `\`npx ${brand}@latest autosync on\` updates the background sync to it` : `\`npx ${brand}@latest\` runs it`
