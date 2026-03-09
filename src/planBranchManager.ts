// Branch and file manager for Ploomy.
// Creates dedicated branches in target repositories and pushes plan.md
// files using the GitHub Contents API (no local git clone required).
// Limitations: Contents API has a 100MB file size limit.
//   Branch names use the format ploomy/issue-{number}.

import { GitHubClient } from "./githubClient.js";
import { logger } from "./logger.js";

export class PlanBranchManager {
  private github: GitHubClient;

  constructor(github: GitHubClient) {
    this.github = github;
  }

  // ============================================================
  // Ensure branch exists, create if needed
  // ============================================================

  async ensureBranch(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<string> {
    const branchName = formatBranchName(issueNumber);

    const existingSha = await this.github.getBranchSha(
      owner,
      repo,
      branchName
    );

    if (existingSha) {
      logger.debug(`Branch "${branchName}" already exists.`, {
        owner,
        repo,
        sha: existingSha,
      });
      return branchName;
    }

    const defaultSha = await this.github.getDefaultBranchSha(owner, repo);
    await this.github.createBranch(owner, repo, branchName, defaultSha);

    return branchName;
  }

  // ============================================================
  // Push plan.md to branch
  // ============================================================

  async pushPlanFile(
    owner: string,
    repo: string,
    issueNumber: number,
    planContent: string,
    isDraft: boolean
  ): Promise<{ branchName: string; fileUrl: string; commitSha: string }> {
    const branchName = await this.ensureBranch(owner, repo, issueNumber);
    const filePath = formatPlanFilePath(issueNumber);
    const commitMessage = isDraft
      ? `Add draft plan for issue #${issueNumber}`
      : `Finalize plan for issue #${issueNumber}`;

    const commitSha = await this.github.createOrUpdateFileOnBranch(
      owner,
      repo,
      branchName,
      filePath,
      planContent,
      commitMessage
    );

    const fileUrl = formatPlanFileUrl(owner, repo, branchName, filePath);

    logger.info(
      `Pushed plan.md to ${owner}/${repo} branch "${branchName}".`,
      { filePath, commitSha, isDraft }
    );

    return { branchName, fileUrl, commitSha };
  }
}

// ============================================================
// Format helpers
// ============================================================

function formatBranchName(issueNumber: number): string {
  return `ploomy/issue-${issueNumber}`;
}

function formatPlanFilePath(issueNumber: number): string {
  return `.plans/${issueNumber}.plan.md`;
}

function formatPlanFileUrl(
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): string {
  return `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;
}
