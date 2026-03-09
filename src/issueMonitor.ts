// Issue monitor for Ploomy.
// Discovers labeled Issues across configured repositories and orgs,
// detects new Issues and user replies to bot questions, and determines
// which Issues need processing based on their current state.
// Limitations: Relies on polling; does not use webhooks.

import { existsSync } from "fs";

import { GitHubClient } from "./githubClient.js";
import { findNewHumanComments } from "./issueParser.js";
import { logger } from "./logger.js";
import { StateStore } from "./state.js";
import type {
  ActionableIssue,
  Config,
  GitHubIssue,
  PlanState,
} from "./types.js";

const MAX_RETRY_COUNT = 3;

export class IssueMonitor {
  private github: GitHubClient;
  private state: StateStore;
  private config: Config;

  constructor(github: GitHubClient, state: StateStore, config: Config) {
    this.github = github;
    this.state = state;
    this.config = config;
  }

  // ============================================================
  // Main: Discover all actionable Issues
  // ============================================================

  async discoverActionableIssues(): Promise<ActionableIssue[]> {
    const repoList = await this.resolveTargetRepos();
    const actionable: ActionableIssue[] = [];

    for (const { owner, repo } of repoList) {
      try {
        const issues = await this.github.listLabeledIssues(
          owner,
          repo,
          this.config.issueLabel
        );

        for (const issue of issues) {
          const result = await this.evaluateIssue(issue);
          if (result) {
            actionable.push(result);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to scan Issues in ${owner}/${repo}.`,
          { error: message, owner, repo }
        );
      }
    }

    if (actionable.length > 0) {
      logger.info(
        `Found ${actionable.length} actionable Issue(s).`,
        {
          issues: actionable.map(
            (a) => `${a.issue.owner}/${a.issue.repo}#${a.issue.number}`
          ),
        }
      );
    }

    return actionable;
  }

  // ============================================================
  // Evaluate a single Issue against its DB state
  // ============================================================

  private async evaluateIssue(
    issue: GitHubIssue
  ): Promise<ActionableIssue | null> {
    const issueId = formatIssueId(issue.owner, issue.repo, issue.number);
    const existingTask = this.state.getTask(issueId);

    // New Issue: register as PENDING
    if (!existingTask) {
      const task = this.state.createTask(
        issueId,
        `${issue.owner}/${issue.repo}`,
        issue.number,
        issue.author
      );
      return { issue, task };
    }

    // Already completed
    if (existingTask.state === "DONE") {
      return null;
    }

    // Failed tasks: resume from the latest phase with completed artifacts
    if (existingTask.state === "FAILED") {
      if (existingTask.retryCount >= MAX_RETRY_COUNT) {
        logger.warn(
          `Issue ${issueId} exceeded max retry count (${MAX_RETRY_COUNT}). Skipping.`,
          { issueId, retryCount: existingTask.retryCount }
        );
        return null;
      }
      this.state.clearErrorMessage(issueId);

      let resumeState: PlanState;
      if (existingTask.reviewOutputPath && existsSync(existingTask.reviewOutputPath)) {
        resumeState = "FINALIZING";
      } else if (existingTask.draftPlanPath && existsSync(existingTask.draftPlanPath)) {
        resumeState = "DRAFTING";
      } else {
        resumeState = "PENDING";
      }

      this.state.updateState(issueId, resumeState);
      const updatedTask = this.state.getTask(issueId)!;
      return { issue, task: updatedTask };
    }

    // Awaiting user: check for new human comments
    if (
      existingTask.state === "AWAITING_USER" ||
      existingTask.state === "AWAITING_USER_FINAL"
    ) {
      return await this.checkForUserReply(issue, existingTask);
    }

    // Active processing states: skip (currently being handled or will be
    // picked up by the orchestrator)
    const activeStates: PlanState[] = [
      "PENDING",
      "QUESTIONING",
      "DRAFTING",
      "REVIEWING",
      "FINALIZING",
    ];
    if (activeStates.includes(existingTask.state)) {
      return { issue, task: existingTask };
    }

    return null;
  }

  // ============================================================
  // Check for user replies on AWAITING_* Issues
  // ============================================================

  private async checkForUserReply(
    issue: GitHubIssue,
    task: import("./types.js").IssueTask
  ): Promise<ActionableIssue | null> {
    const comments = await this.github.getIssueComments(
      issue.owner,
      issue.repo,
      issue.number
    );

    const thresholdId = Math.max(
      task.lastBotCommentId ?? 0,
      task.lastProcessedHumanCommentId ?? 0
    );

    const newHumanComments = findNewHumanComments(comments, thresholdId);

    if (newHumanComments.length === 0) {
      return null;
    }

    const latestHumanCommentId =
      newHumanComments[newHumanComments.length - 1].id;

    // Immediately mark as processed to prevent re-processing
    this.state.updateLastProcessedHumanCommentId(
      task.issueId,
      latestHumanCommentId
    );

    // Transition to the appropriate resume state
    const nextState: PlanState =
      task.state === "AWAITING_USER" ? "QUESTIONING" : "FINALIZING";
    this.state.updateState(task.issueId, nextState);

    const updatedTask = this.state.getTask(task.issueId)!;

    logger.info(
      `User replied on ${issue.owner}/${issue.repo}#${issue.number}. Resuming ${nextState}.`,
      {
        issueId: task.issueId,
        newCommentCount: newHumanComments.length,
        nextState,
      }
    );

    return { issue, task: updatedTask };
  }

  // ============================================================
  // Resolve target repositories from config
  // ============================================================

  private async resolveTargetRepos(): Promise<
    Array<{ owner: string; repo: string }>
  > {
    const repos: Array<{ owner: string; repo: string }> = [];
    const seen = new Set<string>();

    for (const repoSpec of this.config.githubRepos) {
      const parts = repoSpec.split("/");
      if (parts.length !== 2) {
        logger.warn(`Invalid repo format: "${repoSpec}". Expected owner/repo.`);
        continue;
      }
      const key = `${parts[0]}/${parts[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        repos.push({ owner: parts[0], repo: parts[1] });
      }
    }

    for (const org of this.config.githubOrgs) {
      try {
        const orgRepos = await this.github.listOwnerRepos(org);
        for (const { owner, name } of orgRepos) {
          const key = `${owner}/${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            repos.push({ owner, repo: name });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list repos for org "${org}".`, {
          error: message,
        });
      }
    }

    return repos;
  }
}

// ============================================================
// Utilities
// ============================================================

function formatIssueId(
  owner: string,
  repo: string,
  issueNumber: number
): string {
  return `${owner}/${repo}#${issueNumber}`;
}
