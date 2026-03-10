// Data models and type definitions for Ploomy.
// Defines shared interfaces for configuration, Issue task tracking,
// plan state machine, and GitHub data structures.
// Limitations: PlanState enum values are stored as strings in SQLite,
//   so renaming values requires a migration.

// ============================================================
// Configuration
// ============================================================

export interface Config {
  githubOrgs: string[];
  githubRepos: string[];
  issueLabel: string;
  pollInterval: number;
  claudeModel: string | null;
  codexModel: string | null;
  workDir: string;
  dbPath: string;
  plansDir: string;
  logLevel: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// ============================================================
// Plan State Machine
// ============================================================

export type PlanState =
  | "PENDING"
  | "QUESTIONING"
  | "AWAITING_USER"
  | "DRAFTING"
  | "REVIEWING"
  | "FINALIZING"
  | "AWAITING_USER_FINAL"
  | "DONE"
  | "FAILED";

// ============================================================
// Issue Task (DB Record)
// ============================================================

export interface IssueTask {
  issueId: string;
  repo: string;
  issueNumber: number;
  state: PlanState;
  issueAuthor: string;
  draftPlanPath: string | null;
  finalPlanPath: string | null;
  planBranch: string | null;
  planFileUrl: string | null;
  lastBotCommentId: number | null;
  lastProcessedHumanCommentId: number | null;
  reviewOutputPath: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// GitHub Issue Data
// ============================================================

export interface GitHubIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  htmlUrl: string;
  createdAt: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  htmlUrl: string;
}

// ============================================================
// Conversation Context
// ============================================================

export interface ConversationContext {
  issue: GitHubIssue;
  comments: IssueComment[];
  draftPlan: string | null;
  reviewOutput: string | null;
}

// ============================================================
// Plan Generation Results
// ============================================================

export interface QuestioningResult {
  hasQuestions: boolean;
  questions: string | null;
  ready: boolean;
}

export interface DraftingResult {
  planContent: string;
}

export interface ReviewResult {
  reviewContent: string;
}

export interface FinalizingResult {
  hasQuestions: boolean;
  questions: string | null;
  planContent: string | null;
}

// ============================================================
// Actionable Issue (from monitor)
// ============================================================

export interface ActionableIssue {
  issue: GitHubIssue;
  task: IssueTask;
}
