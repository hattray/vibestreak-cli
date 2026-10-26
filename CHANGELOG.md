# Changelog

Any version runs with `npx vibestreak@<version>`; `npx vibestreak@latest autosync on`
moves the background sync to the newest one.

## 0.3.3 (2026-10-25)

- `vibestreak board all` shows consistency as the share of days active since
  each person's first (over at least 90 days), as the website does, with a
  line saying how it's counted.

## 0.3.2 (2026-10-25)

- Linking says up front that your profile is public (and how to hide it), and
  that linking means agreeing to the Terms and Privacy policy.
- If the server ever stops accepting this version, the background sync shows
  a notification (once a day) with the command that updates it, instead of
  failing quietly while your streak runs out.

## 0.3.1 (2026-10-25)

- `vibestreak --version` (or `-v`), and the version in `help` and `status`.
- Says when a newer version is out: after `vibestreak`, `sync` and in `status`.
- Sends its version with each sync. Settings shows each machine's version, and
  the server can turn away versions too old to count correctly, with the
  command that updates them.

## 0.3.0 (2026-10-25)

- First run: plain `npx vibestreak` signs in through the browser (no token to
  copy), syncs, and offers background sync and the evening nudge.
- `vibestreak setup [--token <t>]`: all of that with the defaults and no
  questions; commit addresses come from git config.
- `vibestreak login` signs in through the browser; `--token` still works.
- `vibestreak pause [1h|3d|tomorrow]` and `resume`: the background syncs and
  nudge skip their runs for up to 7 days, and nothing is lost.

## 0.2.0 (2026-10-25)

- `vibestreak` shows a dashboard: streak, level, a 12-week heatmap and your rank.
- `vibestreak me`, `profile <handle>`, `board`, `today` in the terminal.
- Syncs after the first one send only the last 7 days: about 3 seconds.

## 0.1.2 (2026-10-25)

- `vibestreak nudge at <time>`: when the evening streak check runs (17:00 to
  23:30; 20:30 by default).

## 0.1.1 (2026-10-25)

- `vibestreak status`; plain `vibestreak nudge` shows the nudge's status.
- The evening job runs `nudge run` (older schedules keep working).

## 0.1.0 (2026-10-25)

- First release: reads Claude Code, Codex, Cursor, Copilot (CLI and VS Code),
  Gemini CLI, Antigravity and OpenCode history and git; syncs daily totals.
- Background sync on macOS (launchd), Linux (systemd or cron) and Windows
  (Task Scheduler), with the evening streak nudge.
