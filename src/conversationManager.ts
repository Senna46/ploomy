// Conversation manager for Ploomy.
// Handles posting comments on GitHub Issues with proper HTML markers,
// user mentions, and state tags. Prevents duplicate posts by tracking
// the last bot comment ID.
// Limitations: Mention detection relies on comment author login field
//   which may not resolve GitHub app bots correctly.

import { GitHubClient } from "./githubClient.js";
import { collectMentionTargets } from "./issueParser.js";
import { logger } from "./logger.js";
import { StateStore } from "./state.js";
import type { IssueComment, IssueTask, PlanState } from "./types.js";

const PLOOMY_COMMENT_MARKER = "<!-- PLOOMY_COMMENT -->";

function ploomyStateMarker(state: PlanState): string {
  return `<!-- PLOOMY_STATE: ${state} -->`;
}

export class ConversationManager {
  private github: GitHubClient;
  private state: StateStore;

  constructor(github: GitHubClient, state: StateStore) {
    this.github = github;
    this.state = state;
  }

  // ============================================================
  // Post a question comment
  // ============================================================

  async postQuestions(
    task: IssueTask,
    questions: string,
    allComments: IssueComment[],
    targetState: "AWAITING_USER" | "AWAITING_USER_FINAL"
  ): Promise<void> {
    const [owner, repo] = task.repo.split("/");
    const mentions = collectMentionTargets(task.issueAuthor, allComments);
    const mentionLine = mentions.map((u) => `@${u}`).join(" ");

    const phaseLabel =
      targetState === "AWAITING_USER"
        ? "before creating the implementation plan"
        : "before finalizing the implementation plan";

    const body =
      `${PLOOMY_COMMENT_MARKER}\n` +
      `${ploomyStateMarker(targetState)}\n\n` +
      `${mentionLine}\n\n` +
      `I have some questions ${phaseLabel}:\n\n` +
      `${questions}\n\n` +
      `Please reply to this comment with your answers.`;

    const commentId = await this.github.createIssueComment(
      owner,
      repo,
      task.issueNumber,
      body
    );

    this.state.updateLastBotCommentId(task.issueId, commentId);
    this.state.updateState(task.issueId, targetState);

    logger.info(
      `Posted questions on ${task.repo}#${task.issueNumber}.`,
      { issueId: task.issueId, targetState, commentId }
    );
  }

  // ============================================================
  // Post a draft plan summary comment
  // ============================================================

  async postDraftSummary(
    task: IssueTask,
    planSummary: string
  ): Promise<void> {
    const [owner, repo] = task.repo.split("/");

    const body =
      `${PLOOMY_COMMENT_MARKER}\n` +
      `${ploomyStateMarker("REVIEWING")}\n\n` +
      `## Draft Plan Created\n\n` +
      `The draft implementation plan has been created and is now being reviewed.\n\n` +
      `${planSummary}\n\n` +
      `**Status:** Under review by Codex. Final plan will be shared shortly.`;

    const commentId = await this.github.createIssueComment(
      owner,
      repo,
      task.issueNumber,
      body
    );

    this.state.updateLastBotCommentId(task.issueId, commentId);

    logger.info(
      `Posted draft summary on ${task.repo}#${task.issueNumber}.`,
      { issueId: task.issueId, commentId }
    );
  }

  // ============================================================
  // Post the final plan comment with branch link
  // ============================================================

  async postFinalPlan(
    task: IssueTask,
    planSummary: string,
    planFileUrl: string,
    planBranch: string
  ): Promise<void> {
    const [owner, repo] = task.repo.split("/");

    const body =
      `${PLOOMY_COMMENT_MARKER}\n` +
      `${ploomyStateMarker("DONE")}\n\n` +
      `## Implementation Plan Complete\n\n` +
      `**Full plan:** [#${task.issueNumber}.plan.md](${planFileUrl})\n` +
      `**Branch:** \`${planBranch}\`\n\n` +
      `${planSummary}`;

    const commentId = await this.github.createIssueComment(
      owner,
      repo,
      task.issueNumber,
      body
    );

    this.state.updateLastBotCommentId(task.issueId, commentId);

    logger.info(
      `Posted final plan on ${task.repo}#${task.issueNumber}.`,
      { issueId: task.issueId, commentId, planFileUrl }
    );
  }
}
