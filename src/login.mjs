import { spawn } from 'node:child_process'

// Opens a page in the default browser; false when there's no way to (a
// server, a container), and the person opens the printed link themselves.
export function openBrowser(url, platform = process.platform) {
  const [command, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Browser sign-in: the server hands out a code, the person approves it on
// the site (signing in with GitHub first if need be), and the token comes back
// to the secret only this process holds. Nothing to copy or paste.
export async function deviceLogin({ server, machine, log = console.log, open = openBrowser, fetchImpl = fetch, sleep = pause }) {
  const post = (path, body) => fetchImpl(new URL(path, server), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const started = await post('/api/v1/device', { machine })
  if (!started.ok) throw new Error(`Couldn't start sign-in (${started.status}); try again, or use a token from ${new URL('/settings', server)}.`)
  const { code, secret, verifyUrl, interval = 2, expiresIn = 600 } = await started.json()
  const opened = await open(verifyUrl)
  log(`${opened ? 'Opening your browser to link this machine' : 'Open this page to link this machine'}: ${verifyUrl}`)
  log(`Check it shows ${code}, then approve. Waiting…`)
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const response = await post('/api/v1/device/token', { secret }).catch(() => null)
    if (!response || response.status === 202 || response.status === 429 || response.status >= 500) continue
    const body = await response.json().catch(() => ({}))
    if (response.ok && body.token) return body
    throw new Error(body.error ?? `Sign-in failed (${response.status}).`)
  }
  throw new Error('Sign-in timed out; run login again.')
}
