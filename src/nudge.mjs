import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Whether tonight's check should nudge: a live streak (it ran through
// yesterday) with nothing yet today, nudges on, and not already nudged today.
export function shouldNudge(streak, config) {
  if (!streak || config.nudge === false) return false
  return streak.atRisk === true && streak.current > 0 && config.lastNudge !== streak.today
}

// What `nudge` was asked to do. Alone it shows the nudge's status; with
// --quiet and nothing else it is the scheduled check as 0.1.0 installed it
// (`nudge --quiet`), so those jobs keep working until autosync is rerun.
export function nudgeAction(rest, values) {
  if (['on', 'off', 'test', 'run', 'at'].includes(rest[0])) return rest[0]
  return values.quiet ? 'run' : 'status'
}

// When the evening check may run: late enough that the day is mostly done,
// early enough to still code before midnight (streaks count calendar days).
export const NUDGE_DEFAULT = [20, 30]
export const NUDGE_EARLIEST = [17, 0]
export const NUDGE_LATEST = [23, 30]
const minutes = ([h, m]) => h * 60 + m
const hhmm = ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

// A time as people type it: 21:45, 2145, 9:45pm, 9pm, 21, or `default`.
// Returns [hour, minute], or throws a sentence saying what to type instead.
export function parseNudgeTime(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (text === 'default') return NUDGE_DEFAULT
  const match = /^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/.exec(text)
  if (!match) throw new Error(`"${input}" is not a time: try 21:45 or 9:45pm.`)
  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (match[3]) {
    if (hour < 1 || hour > 12) throw new Error(`"${input}" is not a time: with am/pm the hour is 1 to 12.`)
    hour = (hour % 12) + (match[3] === 'pm' ? 12 : 0)
  }
  if (hour > 23 || minute > 59) throw new Error(`"${input}" is not a time of day.`)
  const time = [hour, minute]
  if (minutes(time) < minutes(NUDGE_EARLIEST) || minutes(time) > minutes(NUDGE_LATEST)) {
    // Small hours (before 5:00) mean 'late at night': the nearest is the latest allowed.
    const nearest = minutes(time) < minutes(NUDGE_EARLIEST) && hour >= 5 ? NUDGE_EARLIEST : NUDGE_LATEST
    throw new Error(
      `The nudge runs between ${hhmm(NUDGE_EARLIEST)} and ${hhmm(NUDGE_LATEST)}: late enough that your day is mostly done, early enough to still code before midnight. The nearest is ${hhmm(nearest)}.`,
    )
  }
  return time
}

// The person's chosen nudge time, or the default.
export function nudgeTimeOf(config) {
  try {
    return config.nudgeTime ? parseNudgeTime(config.nudgeTime) : NUDGE_DEFAULT
  } catch {
    return NUDGE_DEFAULT
  }
}

export function nudgeText(streak) {
  const days = streak.current === 1 ? '1-day streak' : `${streak.current}-day streak`
  const next = streak.next && streak.current + 1 >= streak.next.days ? ` Today makes it ${streak.next.name}.` : ''
  return {
    title: `Your ${days} ends at midnight`,
    message: `One AI coding session or a commit shipped with AI keeps it alive.${next}`,
  }
}

// A Windows toast through PowerShell and the system's own notification API
// (nothing to install). It is posted as PowerShell, an app Windows already
// knows, since an unregistered app's toasts are dropped. The text travels as
// PowerShell string literals inside a base64 (UTF-16) command: no quoting
// can break out of it.
export function windowsToastCommand({ title, message }) {
  const literal = s => `'${s.replace(/'/g, "''")}'`
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${literal(title)})) > $null`,
    `$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode(${literal(message)})) > $null`,
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
  ].join('; ')
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]
}

// A desktop notification by the system's own means: Notification Center on
// macOS, notify-send on Linux, a toast on Windows; else the text is printed.
export async function notify({ title, message }) {
  try {
    if (platform() === 'darwin') {
      const quote = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      await run('osascript', ['-e', `display notification ${quote(message)} with title ${quote('vibestreak')} subtitle ${quote(title)} sound name "Glass"`])
      return true
    }
    if (platform() === 'linux') {
      await run('notify-send', ['--app-name=vibestreak', title, message])
      return true
    }
    if (platform() === 'win32') {
      const [exe, args] = windowsToastCommand({ title, message })
      await run(exe, args, { windowsHide: true })
      return true
    }
  } catch {
    // No notifier available: fall through to printing.
  }
  console.log(`${title}. ${message}`)
  return false
}
