# Ploomy Daemon (launchd)

Run Ploomy as a native macOS LaunchAgent so it starts on login and restarts on failure.

## Prerequisites

- `.env` configured (copy from `.env.example` and set `PLANNER_APP_ID`, `PLANNER_PRIVATE_KEY_PATH`, etc.)
- `npm run build` completed
- `claude` and `codex` CLIs installed and on PATH (`~/.local/bin` is included by default)

## Install

From the project root:

```bash
chmod +x deploy/install-daemon.sh
./deploy/install-daemon.sh
```

The script copies the LaunchAgent plist to `~/Library/LaunchAgents/` (with paths substituted), creates `~/.ploomy/logs/`, and loads the job.

## Commands

| Action | Command |
|--------|---------|
| Check status | `launchctl list | grep ploomy` |
| Stop | `launchctl stop com.senna.ploomy` |
| Start | `launchctl start com.senna.ploomy` |
| Unload (disable) | `launchctl unload ~/Library/LaunchAgents/com.senna.ploomy.plist` |
| View stdout | `tail -f ~/.ploomy/logs/daemon.log` |
| View stderr | `tail -f ~/.ploomy/logs/daemon.err.log` |

## Update after code changes

1. `npm run build`
2. `launchctl stop com.senna.ploomy && launchctl start com.senna.ploomy`

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.senna.ploomy.plist
rm ~/Library/LaunchAgents/com.senna.ploomy.plist
```
