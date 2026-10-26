// Pausing the background jobs: the scheduled syncs and the evening nudge skip
// their runs until a set time, then carry on by themselves. A pause is held
// to 7 days, the window a sync catches up afterwards (older days can't be
// changed), so nothing done during it is lost: it is uploaded on resume.
export const MAX_PAUSE_DAYS = 7
export const MORNING = 6

// `1h`…`168h`, `1d`…`7d`, or `tomorrow` (the default: until 06:00 tomorrow,
// before the first sync of the day).
export function parsePause(word = 'tomorrow', from = new Date()) {
  const w = String(word).trim().toLowerCase()
  if (w === 'tomorrow' || w === 'today') {
    const until = new Date(from)
    until.setDate(until.getDate() + 1)
    until.setHours(MORNING, 0, 0, 0)
    return until
  }
  const match = /^(\d+)\s*(h|hours?|d|days?)$/.exec(w)
  if (!match) throw new Error(`Pause for how long? \`1h\`, \`3d\` or \`tomorrow\` (up to ${MAX_PAUSE_DAYS} days).`)
  const hours = Number(match[1]) * (match[2].startsWith('d') ? 24 : 1)
  if (hours < 1 || hours > MAX_PAUSE_DAYS * 24) {
    throw new Error(`A pause lasts 1 hour to ${MAX_PAUSE_DAYS} days: a sync afterwards catches up only the last ${MAX_PAUSE_DAYS}. For longer, \`autosync off\`.`)
  }
  return new Date(from.getTime() + hours * 3600e3)
}

// The time background runs resume, while a pause lasts.
export const pausedUntil = (config, at = new Date()) => {
  const until = config.pausedUntil ? new Date(config.pausedUntil) : undefined
  return until && until > at ? until : undefined
}

export const untilText = (until, at = new Date()) => {
  const time = until.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = until.toDateString() === at.toDateString()
  const tomorrow = new Date(at)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = sameDay ? 'today' : until.toDateString() === tomorrow.toDateString() ? 'tomorrow' : until.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day} ${time}`
}
