// Local calendar days: every count is filed under the day it happened on in
// the machine's own timezone, the way the person remembers their week.

const pad = n => String(n).padStart(2, '0')

export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const dayOfIso = iso => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : dayKey(new Date(t))
}

export const dayOfEpoch = seconds => dayKey(new Date(seconds * 1000))

export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// One tool's activity on one day; the shape the server stores.
export const emptyDay = (date, tool) => ({
  date,
  tool,
  messages: 0,
  toolCalls: 0,
  sessions: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  models: [],
})
