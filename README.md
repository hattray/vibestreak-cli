# vibestreak

[![Test](https://github.com/hattray/vibestreak-cli/actions/workflows/test.yml/badge.svg)](https://github.com/hattray/vibestreak-cli/actions/workflows/test.yml)

Your AI coding streak, from your own machine: a heatmap of the days you coded
with AI agents and the commits you shipped with them, ranked on consistency,
not spend. Profiles and the leaderboard: https://vibestreak.kingsbridge-consultancy.com

```bash
npx vibestreak                                  # sign in through the browser, sync, offer autosync
npx vibestreak setup --token PASTE_YOUR_TOKEN   # or: everything with the defaults, no questions
npx vibestreak emails scan                      # addresses from your other accounts
npx vibestreak pause 3d                         # background syncs and the nudge off for a while
```

All commands: https://vibestreak.kingsbridge-consultancy.com/cli

## What it reads

| Tool | Where |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` |
| Cursor | its editor database and AI code-tracking database |
| GitHub Copilot | Copilot CLI's `~/.copilot/session-state`; Copilot Chat sessions in VS Code |
| Gemini CLI | `~/.gemini/tmp/*/chats` |
| Antigravity | `~/.gemini/antigravity/conversations` |
| OpenCode | `~/.local/share/opencode` |
| Commits | `git log` in the repos under your usual folders, for the addresses you list |

## What it sends

Per day and tool: message, tool-call, session and token counts, and model names.
Per commit you authored: a keyed hash of its id, its day, and the AI agent named
in its co-author trailer. Never prompts, responses, code, file paths, repo names,
commit messages or email addresses. `npx vibestreak collect --json` prints the
exact upload without sending it.

## Requirements

Node.js 22.13 or newer and git, on macOS, Linux or Windows. Background syncs use
the system's own scheduler: launchd (macOS), systemd user timers or crontab
(Linux), Task Scheduler (Windows). The evening streak check notifies through
Notification Center, `notify-send`, or a Windows toast.

## Source

This repository is the CLI that runs on your machine; it's what `npx vibestreak`
downloads from npm. The website and API it syncs to are run by Kingsbridge
Consultancy LLC. Tests, how to report a count that looks wrong, and the rule every
change follows: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).
