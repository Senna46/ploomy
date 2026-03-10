# AGENTS.md

Guidelines for AI agents working on this codebase.

## Repository Purpose

This is **Ploomy**, a daemon that monitors GitHub Issues and generates implementation
plans using Claude + Codex. It does NOT implement the plans itself; it only creates
plan.md files and delivers them to the target repository.

## Before Making Changes

1. Run `npm run typecheck` to verify the codebase compiles
2. Read the relevant source files before editing
3. Understand the state machine architecture (main.ts → issueMonitor → planGenerator → planReviewer → planFinalizer)

## Code Style Rules

- TypeScript with strict mode enabled
- ESM modules with `.js` import extensions
- lowerCamelCase for all identifiers (variables, functions, properties, methods)
- Every source file starts with a comment block describing purpose and limitations
- All user-facing text (logs, GitHub comments) must be in English
- Git commit messages must be in English only
- Use structured logging: `logger.info("message", { contextKey: contextValue })`
- Error handling must include detailed context (function name, relevant parameters)
- Prefer readability over efficiency

## Module Dependency Graph

  main.ts
    → config.ts
    → logger.ts
    → githubClient.ts
    → state.ts
    → issueMonitor.ts
      → issueParser.ts
      → githubClient.ts
      → state.ts
    → planGenerator.ts
    → planReviewer.ts
    → planFinalizer.ts
    → conversationManager.ts
      → githubClient.ts
    → planBranchManager.ts
      → githubClient.ts
    → types.ts (shared by all)

## Key Interfaces

- Config: All PLANNER_* settings from environment (appId, privateKey, etc.)
- IssueTask: Tracked Issue with state, plan paths, comment IDs
- PlanState: State machine enum (PENDING, QUESTIONING, AWAITING_USER, etc.)
- IssueComment: GitHub Issue comment data
- ConversationContext: Issue body + comment history for AI prompt construction

## Testing Changes

After any code change:

  npm run typecheck   # Must pass with zero errors
  npm run build       # Must produce dist/ without errors

## Environment Variables

All config uses the PLANNER_ prefix. Required:
- PLANNER_APP_ID (GitHub App ID)
- PLANNER_PRIVATE_KEY_PATH or PLANNER_PRIVATE_KEY (GitHub App private key)

Monitored repositories are auto-discovered from the App installations.

## Common Tasks

### Adding a new config option
1. Add field to Config interface in types.ts
2. Parse it in config.ts loadConfig()
3. Add to .env.example with documentation comment

### Modifying plan generation
- Edit planGenerator.ts for the Claude prompt and output parsing
- The questioning phase and drafting phase are separate functions
- Allowed tools are read-only: Read, Bash(find/grep/rg/ls/cat/tree/wc/head/tail)

### Changing Issue comment format
- Edit conversationManager.ts for comment templates
- HTML markers: <!-- PLOOMY_COMMENT --> and <!-- PLOOMY_STATE: {state} -->
