// GitHub API client for Ploomy.
// Wraps Octokit to provide typed operations for monitoring Issues,
// managing comments, creating branches, and pushing files via Contents API.
// Uses gh CLI auth token or GH_TOKEN for authentication.
// Limitations: Rate limiting is handled by Octokit built-in throttling.
//   Contents API file operations are limited to files under 100MB.

import { execFile } from "child_process";
import { Octokit } from "octokit";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { GitHubIssue, IssueComment } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token,
    });
  }

  // ============================================================
  // Factory: Create client using gh CLI auth token or GH_TOKEN
  // ============================================================

  static async createFromGhCli(): Promise<GitHubClient> {
    const envToken = process.env.GH_TOKEN;
    if (envToken && envToken.trim()) {
      const trimmedToken = envToken.trim();
      validateGitHubToken(trimmedToken);
      logger.info(
        "GitHub client authenticated via GH_TOKEN environment variable."
      );
      return new GitHubClient(trimmedToken);
    }

    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"]);
      const token = stdout.trim();
      if (!token) {
        throw new Error("gh auth token returned empty string.");
      }
      logger.info("GitHub client authenticated via gh CLI.");
      return new GitHubClient(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to get GitHub token. Set GH_TOKEN environment variable or run 'gh auth login'. Error: ${message}`
      );
    }
  }

  // ============================================================
  // Organization / User repo listing
  // ============================================================

  async listOwnerRepos(
    owner: string
  ): Promise<Array<{ owner: string; name: string }>> {
    logger.debug("Listing repos for owner.", { owner });

    const repos: Array<{ owner: string; name: string }> = [];

    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForOrg,
        { org: owner, per_page: 100, type: "all" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for org "${owner}".`);
      return repos;
    } catch (orgError) {
      logger.debug(
        `Failed to list repos as org "${owner}", trying as user...`,
        {
          error:
            orgError instanceof Error ? orgError.message : String(orgError),
        }
      );
    }

    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForUser,
        { username: owner, per_page: 100, type: "owner" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for user "${owner}".`);
    } catch (userError) {
      logger.error(
        `Failed to list repos for "${owner}" as both org and user.`,
        {
          error:
            userError instanceof Error ? userError.message : String(userError),
        }
      );
    }

    return repos;
  }

  // ============================================================
  // Issues: List labeled Issues
  // ============================================================

  async listLabeledIssues(
    owner: string,
    repo: string,
    label: string
  ): Promise<GitHubIssue[]> {
    logger.debug("Fetching labeled Issues.", { owner, repo, label });

    const issues: GitHubIssue[] = [];

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.issues.listForRepo,
      {
        owner,
        repo,
        labels: label,
        state: "open",
        per_page: 100,
      }
    )) {
      for (const issue of response.data) {
        // Skip pull requests (Issues API includes PRs)
        if (issue.pull_request) continue;

        issues.push({
          owner,
          repo,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          author: issue.user?.login ?? "unknown",
          labels: issue.labels
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter((name) => name.length > 0),
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
        });
      }
    }

    if (issues.length > 0) {
      logger.debug(
        `Found ${issues.length} labeled Issue(s) in ${owner}/${repo}.`,
        { label }
      );
    }

    return issues;
  }

  // ============================================================
  // Issue Comments
  // ============================================================

  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    since?: string
  ): Promise<IssueComment[]> {
    logger.debug("Fetching Issue comments.", {
      owner,
      repo,
      issueNumber,
      since: since ?? "(all)",
    });

    const comments: IssueComment[] = [];

    const params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page: number;
      since?: string;
    } = {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    };
    if (since) {
      params.since = since;
    }

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.issues.listComments,
      params
    )) {
      for (const comment of response.data) {
        comments.push({
          id: comment.id,
          body: comment.body ?? "",
          author: comment.user?.login ?? "unknown",
          createdAt: comment.created_at,
          htmlUrl: comment.html_url,
        });
      }
    }

    return comments;
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<number> {
    logger.debug("Creating Issue comment.", { owner, repo, issueNumber });

    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });

    return data.id;
  }

  // ============================================================
  // Branch operations (Git Refs API)
  // ============================================================

  async getDefaultBranchSha(owner: string, repo: string): Promise<string> {
    const { data: repoData } = await this.octokit.rest.repos.get({
      owner,
      repo,
    });
    const defaultBranch = repoData.default_branch;

    const { data: refData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });

    return refData.object.sha;
  }

  async getBranchSha(
    owner: string,
    repo: string,
    branch: string
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branchName: string,
    fromSha: string
  ): Promise<void> {
    logger.debug("Creating branch.", { owner, repo, branchName, fromSha });

    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    });

    logger.info(`Branch "${branchName}" created in ${owner}/${repo}.`);
  }

  // ============================================================
  // File operations (Contents API)
  // ============================================================

  async createOrUpdateFileOnBranch(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string
  ): Promise<string> {
    logger.debug("Creating/updating file on branch.", {
      owner,
      repo,
      branch,
      filePath,
    });

    let existingSha: string | undefined;
    try {
      const { data: existing } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(existing) && existing.type === "file") {
        existingSha = existing.sha;
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const encodedContent = Buffer.from(content, "utf-8").toString("base64");

    const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: commitMessage,
      content: encodedContent,
      branch,
      sha: existingSha,
    });

    const commitSha = data.commit.sha ?? "unknown";
    logger.info(`File "${filePath}" committed on branch "${branch}".`, {
      commitSha,
    });

    return commitSha;
  }
}

// ============================================================
// Utilities
// ============================================================

function validateGitHubToken(token: string): void {
  const validPrefixes = [
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
  ];
  const hasValidPrefix = validPrefixes.some((prefix) =>
    token.startsWith(prefix)
  );
  if (!hasValidPrefix) {
    logger.warn(
      `GH_TOKEN does not match known GitHub token prefixes (${validPrefixes.join(", ")}). Proceeding anyway — Octokit will validate the token via the API.`
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: number }).status === 404
  ) {
    return true;
  }
  return false;
}
