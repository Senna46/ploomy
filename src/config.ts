// Configuration loader for Ploomy.
// Reads PLANNER_* environment variables (with dotenv support) and validates
// required settings. Provides sensible defaults for optional values.
// Limitations: Only supports environment variable configuration,
//   no config file support.

import { config as dotenvConfig } from "dotenv";
import { homedir } from "os";
import { join } from "path";

import type { Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(): Config {
  dotenvConfig();

  const githubOrgs = parseCommaSeparated(process.env.PLANNER_GITHUB_ORGS);
  const githubRepos = parseCommaSeparated(process.env.PLANNER_GITHUB_REPOS);

  if (githubOrgs.length === 0 && githubRepos.length === 0) {
    throw new Error(
      "Configuration error: At least one of PLANNER_GITHUB_ORGS or PLANNER_GITHUB_REPOS must be set."
    );
  }

  const issueLabel = process.env.PLANNER_ISSUE_LABEL?.trim() || "plan-request";
  const pollInterval = parsePositiveInt(process.env.PLANNER_POLL_INTERVAL, 120);
  const claudeModel = process.env.PLANNER_CLAUDE_MODEL?.trim() || null;
  const codexModel =
    process.env.PLANNER_CODEX_MODEL?.trim() || "gpt-5.3-codex";

  const defaultWorkDir = join(homedir(), ".ploomy", "repos");
  const workDir = process.env.PLANNER_WORK_DIR?.trim() || defaultWorkDir;

  const defaultDbPath = join(homedir(), ".ploomy", "state.db");
  const dbPath = process.env.PLANNER_DB_PATH?.trim() || defaultDbPath;

  const defaultPlansDir = join(homedir(), ".ploomy", "plans");
  const plansDir = process.env.PLANNER_PLANS_DIR?.trim() || defaultPlansDir;

  const logLevel = parseLogLevel(process.env.PLANNER_LOG_LEVEL);

  return {
    githubOrgs,
    githubRepos,
    issueLabel,
    pollInterval,
    claudeModel,
    codexModel,
    workDir,
    dbPath,
    plansDir,
    logLevel,
  };
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Configuration error: Expected a positive integer but got "${value}".`
    );
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Configuration error: Invalid log level "${value}". Valid levels: ${VALID_LOG_LEVELS.join(", ")}`
    );
  }
  return level;
}
