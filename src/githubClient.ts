// GitHub API client for Ploomy.
// Uses GitHub App authentication with per-installation Octokit instances.
// Manages JWT auth for app-level operations and installation access tokens
// for repo-specific API calls and git operations.
// Limitations: Rate limiting is handled by Octokit built-in throttling.
//   Contents API file operations are limited to files under 100MB.

import { App, Octokit } from "octokit";

import { logger } from "./logger.js";
import type { GitHubIssue, IssueComment } from "./types.js";

export class GitHubClient {
  private app: App;
  private appSlug: string;
  private botUserId: number;
  private installationMap: Map<string, number>;
  private octokitCache: Map<number, Octokit>;

  private constructor(app: App, appSlug: string, botUserId: number) {
    this.app = app;
    this.appSlug = appSlug;
    this.botUserId = botUserId;
    this.installationMap = new Map();
    this.octokitCache = new Map();
  }

  // ============================================================
  // Factory: Create client from GitHub App credentials
  // ============================================================

  static async createFromApp(
    appId: number,
    privateKey: string
  ): Promise<GitHubClient> {
    const app = new App({ appId, privateKey });

    const client = new GitHubClient(app, `app-${appId}`, 0);
    await client.loadInstallations();
    await client.resolveBotIdentity();
    return client;
  }

  private async resolveBotIdentity(): Promise<void> {
    const firstInstallationId = this.installationMap.values().next().value;
    if (firstInstallationId === undefined) return;

    const octokit = await this.getInstallationOctokit(firstInstallationId);

    try {
      const { data: appInfo } = await octokit.rest.apps.getAuthenticated();
      this.appSlug = appInfo?.slug ?? this.appSlug;
    } catch (error) {
      logger.warn("Failed to fetch app slug, using fallback.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const { data: botUser } = await octokit.rest.users.getByUsername({
        username: `${this.appSlug}[bot]`,
      });
      this.botUserId = botUser.id;
    } catch (error) {
      logger.warn("Failed to fetch bot user ID, commits may not show app avatar.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("Bot identity resolved.", {
      appSlug: this.appSlug,
      botUserId: this.botUserId,
    });
  }

  private async getInstallationOctokit(installationId: number): Promise<Octokit> {
    const cached = this.octokitCache.get(installationId);
    if (cached) return cached;
    const octokit = await this.app.getInstallationOctokit(installationId);
    this.octokitCache.set(installationId, octokit as Octokit);
    return octokit as Octokit;
  }

  // ============================================================
  // Installation management
  // ============================================================

  private async loadInstallations(): Promise<void> {
    this.installationMap.clear();
    this.octokitCache.clear();

    for await (const { installation } of this.app.eachInstallation.iterator()) {
      const login = installation.account?.login;
      if (login) {
        this.installationMap.set(login.toLowerCase(), installation.id);
        logger.info(
          `Found GitHub App installation for "${login}" (ID: ${installation.id}).`
        );
      }
    }

    if (this.installationMap.size === 0) {
      throw new Error(
        "No GitHub App installations found. Ensure the App is installed on at least one organization or user account."
      );
    }

    logger.info(
      `Loaded ${this.installationMap.size} GitHub App installation(s).`
    );
  }

  private getInstallationId(owner: string): number {
    const id = this.installationMap.get(owner.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `No GitHub App installation found for owner "${owner}". ` +
          "Ensure the GitHub App is installed on this account."
      );
    }
    return id;
  }

  private async getOctokitForOwner(owner: string): Promise<Octokit> {
    const installationId = this.getInstallationId(owner);
    return this.getInstallationOctokit(installationId);
  }

  // ============================================================
  // Repository auto-discovery from App installations
  // ============================================================

  async listAccessibleRepos(): Promise<
    Array<{ owner: string; name: string }>
  > {
    // Refresh installations so that accounts added after startup are
    // present in installationMap before we iterate their repositories.
    await this.loadInstallations();

    const repos: Array<{ owner: string; name: string }> = [];

    for await (const { repository } of this.app.eachRepository.iterator()) {
      repos.push({ owner: repository.owner.login, name: repository.name });
    }

    logger.info(
      `Found ${repos.length} accessible repository/repositories across all installations.`
    );
    return repos;
  }

  // ============================================================
  // Installation access token (for git clone/push operations)
  // ============================================================

  async getInstallationToken(owner: string): Promise<string> {
    const installationId = this.getInstallationId(owner);

    const { data } =
      await this.app.octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });

    return data.token;
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

    const octokit = await this.getOctokitForOwner(owner);
    const issues: GitHubIssue[] = [];

    for await (const response of octokit.paginate.iterator(
      octokit.rest.issues.listForRepo,
      {
        owner,
        repo,
        labels: label,
        state: "open",
        per_page: 100,
      }
    )) {
      for (const issue of response.data) {
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

    const octokit = await this.getOctokitForOwner(owner);
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

    for await (const response of octokit.paginate.iterator(
      octokit.rest.issues.listComments,
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

    const octokit = await this.getOctokitForOwner(owner);
    const { data } = await octokit.rest.issues.createComment({
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
    const octokit = await this.getOctokitForOwner(owner);
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo,
    });
    const defaultBranch = repoData.default_branch;

    const { data: refData } = await octokit.rest.git.getRef({
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
    const octokit = await this.getOctokitForOwner(owner);
    try {
      const { data } = await octokit.rest.git.getRef({
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

    const octokit = await this.getOctokitForOwner(owner);
    await octokit.rest.git.createRef({
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

    const octokit = await this.getOctokitForOwner(owner);
    let existingSha: string | undefined;
    try {
      const { data: existing } = await octokit.rest.repos.getContent({
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

    const botAuthor = {
      name: `${this.appSlug}[bot]`,
      email: `${this.botUserId}+${this.appSlug}[bot]@users.noreply.github.com`,
    };

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: commitMessage,
      content: encodedContent,
      branch,
      sha: existingSha,
      author: botAuthor,
      committer: botAuthor,
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
