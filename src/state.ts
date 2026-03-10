// SQLite-based state management for Ploomy.
// Tracks Issue tasks with their plan state, file paths, and comment IDs
// to prevent duplicate processing and enable conversation resumption.
// Limitations: Single-process only; no concurrent access support.

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

import { logger } from "./logger.js";
import type { IssueTask, PlanState } from "./types.js";

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();

    logger.debug("State store initialized.", { dbPath });
  }

  // ============================================================
  // Schema initialization
  // ============================================================

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_tasks (
        issue_id                        TEXT PRIMARY KEY,
        repo                            TEXT NOT NULL,
        issue_number                    INTEGER NOT NULL,
        state                           TEXT NOT NULL,
        issue_author                    TEXT NOT NULL,
        draft_plan_path                 TEXT,
        final_plan_path                 TEXT,
        plan_branch                     TEXT,
        plan_file_url                   TEXT,
        last_bot_comment_id             INTEGER,
        last_processed_human_comment_id INTEGER,
        review_output_path              TEXT,
        error_message                   TEXT,
        retry_count                     INTEGER NOT NULL DEFAULT 0,
        created_at                      TEXT NOT NULL,
        updated_at                      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issue_tasks_state
        ON issue_tasks (state);

      CREATE INDEX IF NOT EXISTS idx_issue_tasks_repo
        ON issue_tasks (repo);
    `);

    // Migration: add retry_count column to existing databases
    try {
      this.db.exec("ALTER TABLE issue_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists
    }
  }

  // ============================================================
  // Task retrieval
  // ============================================================

  getTask(issueId: string): IssueTask | null {
    const row = this.db
      .prepare("SELECT * FROM issue_tasks WHERE issue_id = ?")
      .get(issueId) as IssueTaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  // ============================================================
  // Task creation
  // ============================================================

  createTask(
    issueId: string,
    repo: string,
    issueNumber: number,
    issueAuthor: string
  ): IssueTask {
    const now = new Date().toISOString();
    const state: PlanState = "PENDING";

    this.db
      .prepare(
        `INSERT OR IGNORE INTO issue_tasks
         (issue_id, repo, issue_number, state, issue_author, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(issueId, repo, issueNumber, state, issueAuthor, now, now);

    logger.debug("Created issue task.", { issueId, repo, issueNumber, state });

    return this.getTask(issueId)!;
  }

  // ============================================================
  // State transitions
  // ============================================================

  updateState(issueId: string, newState: PlanState): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE issue_tasks SET state = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(newState, now, issueId);

    logger.debug("Updated task state.", { issueId, newState });
  }

  updateStateWithError(
    issueId: string,
    newState: PlanState,
    errorMessage: string
  ): void {
    const now = new Date().toISOString();

    if (newState === "FAILED") {
      this.db
        .prepare(
          "UPDATE issue_tasks SET state = ?, error_message = ?, retry_count = retry_count + 1, updated_at = ? WHERE issue_id = ?"
        )
        .run(newState, errorMessage, now, issueId);
    } else {
      this.db
        .prepare(
          "UPDATE issue_tasks SET state = ?, error_message = ?, updated_at = ? WHERE issue_id = ?"
        )
        .run(newState, errorMessage, now, issueId);
    }

    logger.debug("Updated task state with error.", {
      issueId,
      newState,
      errorMessage,
    });
  }

  clearErrorMessage(issueId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET error_message = NULL, updated_at = ? WHERE issue_id = ?"
      )
      .run(now, issueId);
  }

  // ============================================================
  // Field updates
  // ============================================================

  updateDraftPlanPath(issueId: string, draftPlanPath: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET draft_plan_path = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(draftPlanPath, now, issueId);
  }

  updateFinalPlanPath(issueId: string, finalPlanPath: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET final_plan_path = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(finalPlanPath, now, issueId);
  }

  updatePlanBranch(
    issueId: string,
    planBranch: string,
    planFileUrl: string
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET plan_branch = ?, plan_file_url = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(planBranch, planFileUrl, now, issueId);
  }

  updateLastBotCommentId(issueId: string, commentId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET last_bot_comment_id = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(commentId, now, issueId);
  }

  updateLastProcessedHumanCommentId(
    issueId: string,
    commentId: number
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET last_processed_human_comment_id = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(commentId, now, issueId);
  }

  updateReviewOutputPath(issueId: string, reviewOutputPath: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE issue_tasks SET review_output_path = ?, updated_at = ? WHERE issue_id = ?"
      )
      .run(reviewOutputPath, now, issueId);
  }

  // ============================================================
  // Cleanup
  // ============================================================

  close(): void {
    this.db.close();
    logger.debug("State store closed.");
  }
}

// ============================================================
// Row mapping
// ============================================================

interface IssueTaskRow {
  issue_id: string;
  repo: string;
  issue_number: number;
  state: string;
  issue_author: string;
  draft_plan_path: string | null;
  final_plan_path: string | null;
  plan_branch: string | null;
  plan_file_url: string | null;
  last_bot_comment_id: number | null;
  last_processed_human_comment_id: number | null;
  review_output_path: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: IssueTaskRow): IssueTask {
  return {
    issueId: row.issue_id,
    repo: row.repo,
    issueNumber: row.issue_number,
    state: row.state as PlanState,
    issueAuthor: row.issue_author,
    draftPlanPath: row.draft_plan_path,
    finalPlanPath: row.final_plan_path,
    planBranch: row.plan_branch,
    planFileUrl: row.plan_file_url,
    lastBotCommentId: row.last_bot_comment_id,
    lastProcessedHumanCommentId: row.last_processed_human_comment_id,
    reviewOutputPath: row.review_output_path,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
