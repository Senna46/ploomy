# CLAUDE.md

Instructions for Claude Code when working on this codebase.

## Project Overview

Ploomy is a TypeScript daemon that monitors GitHub Issues for a configured label,
generates implementation plans using Claude Code (claude -p) with interactive
questioning, reviews plans using Codex CLI, and delivers the final plan to the
target repository.

## Tech Stack

- Language: TypeScript (ES2022, Node16 modules)
- Runtime: Node.js >= 18
- Package Manager: npm
- GitHub API: Octokit (via octokit package, GitHub App authentication)
- State: SQLite (via better-sqlite3)
- Config: dotenv
- Plan generation: Claude CLI (`claude -p`) with read-only tools
- Plan review: Codex CLI (`codex exec`) with read-only sandbox

## Project Structure

  src/
    main.ts                 Daemon entry point, polling loop, prerequisite checks
    config.ts               PLANNER_* environment variable loader
    types.ts                Shared interfaces (Config, IssueTask, PlanState, etc.)
    logger.ts               Structured logger with level support
    githubClient.ts         Octokit wrapper (Issues, comments, branches, file ops)
    issueMonitor.ts         Discovers labeled Issues and detects new comments
    issueParser.ts          Parses Issue body and comments
    planGenerator.ts        Runs claude -p for questioning and draft generation
    planReviewer.ts         Runs codex exec for plan review
    planFinalizer.ts        Runs claude -p for review triage and final plan
    conversationManager.ts  Manages Issue conversations (questions, mentions)
    planBranchManager.ts    Creates branches and pushes plan.md via Contents API
    state.ts                SQLite state tracking (issue_tasks table)

## Build and Run Commands

  npm install       # Install dependencies
  npm run build     # Compile TypeScript to dist/
  npm start         # Run compiled daemon
  npm run dev       # Run with tsx (development)
  npm run typecheck # Type check without emitting

## Coding Conventions

- ESM modules: all imports use .js extension (e.g. import { X } from "./foo.js")
- lowerCamelCase for variables, functions, properties, and methods
- Structured logging: logger.info("message", { key: value })
- Error messages include function context and relevant parameters
- Comments at file top describe purpose and limitations (in English)
- User-facing text (logs, Issue comments) in English
- Git commit messages in English only

## Key Patterns

- Polling daemon: main loop with configurable sleep interval, SIGINT/SIGTERM shutdown
- GitHub auth: GitHub App (JWT + installation access tokens via @octokit/auth-app)
- Repository discovery: auto-discovered from App installations (no manual repo/org list)
- State machine: Each Issue follows PENDING → QUESTIONING → DRAFTING → REVIEWING →
  FINALIZING → DONE with AWAITING_USER loops at questioning and finalizing
- Claude invocation: claude -p with read-only tools (no Edit), output parsed via markers
- Codex invocation: codex exec with --output-last-message and read-only sandbox
- Branch delivery: plan.md pushed to ploomy/issue-{number} branch via Contents API

## Important Notes

- The daemon processes Issues sequentially (single-threaded)
- Claude CLI has a 10-minute timeout, Codex CLI has a 5-minute timeout
- Git operations have a 2-minute timeout
- Plan files are pushed to the target repo on a dedicated branch, not main
- Environment variables use PLANNER_ prefix (not tied to app name)
- No dependency on gh CLI or GH_TOKEN; authentication is via GitHub App only
