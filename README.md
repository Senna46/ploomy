# Ploomy

Ploomy is a daemon that monitors GitHub Issues and automatically generates implementation plans using multiple AI models (Claude + Codex) working in coordination.

## How It Works

1. **Issue Detection** - Monitors specified repositories for Issues with a configured label (default: `plan-request`)
2. **Questioning Phase** - Claude Opus 4.6 analyzes the Issue, explores the codebase, and asks clarifying questions via Issue comments until all ambiguities are resolved
3. **Drafting Phase** - Once questions are resolved, Claude generates a detailed implementation plan (`plan.md`)
4. **Review Phase** - Codex CLI reviews the draft plan and suggests improvements
5. **Finalization Phase** - Claude incorporates review feedback (with autonomous triage), producing the final plan
6. **Delivery** - The final `plan.md` is pushed to a branch (`ploomy/issue-{number}`) in the target repository and a summary is posted on the Issue

## Tech Stack

- **Language:** TypeScript (ES2022, Node16 modules)
- **Runtime:** Node.js >= 18
- **GitHub API:** Octokit
- **State:** SQLite (via better-sqlite3)
- **Config:** dotenv
- **Plan generation:** Claude CLI (`claude -p`) - read-only codebase exploration
- **Plan review:** Codex CLI (`codex exec`) - read-only review

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your settings

# Build
npm run build

# Run
npm start

# Or run in development mode
npm run dev
```

## Configuration

All configuration uses the `PLANNER_` prefix (not tied to the app name):

| Variable | Description | Default |
|---|---|---|
| `PLANNER_GITHUB_REPOS` | Repositories to monitor (comma-separated, `owner/repo`) | (required\*) |
| `PLANNER_GITHUB_ORGS` | Organizations to monitor (comma-separated) | (required\*) |
| `PLANNER_ISSUE_LABEL` | Label that triggers plan generation | `plan-request` |
| `PLANNER_POLL_INTERVAL` | Polling interval in seconds | `120` |
| `PLANNER_CLAUDE_MODEL` | Claude model override | (claude CLI default) |
| `PLANNER_CODEX_MODEL` | Codex model override | `gpt-5.3-codex` |
| `PLANNER_WORK_DIR` | Working directory for cloned repos | `~/.ploomy/repos` |
| `PLANNER_DB_PATH` | SQLite database path | `~/.ploomy/state.db` |
| `PLANNER_PLANS_DIR` | Local plan file storage | `~/.ploomy/plans` |
| `PLANNER_LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |
| `GH_TOKEN` | GitHub token | (falls back to `gh` CLI) |

\* At least one of `PLANNER_GITHUB_REPOS` or `PLANNER_GITHUB_ORGS` must be set.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated, or `GH_TOKEN` set
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) installed and authenticated
- [Codex CLI](https://openaicli.com/docs) (`codex`) installed and authenticated

## State Transitions

```
PENDING → QUESTIONING → AWAITING_USER (loop until resolved) → DRAFTING → REVIEWING → FINALIZING → DONE
                                                                            ↕
                                                                   AWAITING_USER_FINAL
```

Any phase can transition to `FAILED`, which retries from `PENDING` on the next cycle.

## License

MIT
