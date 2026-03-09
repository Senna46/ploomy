// Main entry point for Ploomy daemon.
// Orchestrates the polling loop: discovers labeled Issues, runs the
// state machine (questioning → drafting → reviewing → finalizing),
// and delivers final plans to target repositories.
// Limitations: Single-threaded; processes Issues sequentially
//   within each polling cycle. Graceful shutdown on SIGINT/SIGTERM.

import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";

import { loadConfig } from "./config.js";
import { ConversationManager } from "./conversationManager.js";
import { GitHubClient } from "./githubClient.js";
import { IssueMonitor } from "./issueMonitor.js";
import { logger, setLogLevel } from "./logger.js";
import { PlanBranchManager } from "./planBranchManager.js";
import { PlanFinalizer } from "./planFinalizer.js";
import { PlanGenerator } from "./planGenerator.js";
import { PlanReviewer } from "./planReviewer.js";
import { StateStore } from "./state.js";
import type {
  ActionableIssue,
  Config,
  ConversationContext,
  IssueComment,
  PlanState,
} from "./types.js";

class PloomyDaemon {
  private config: Config;
  private state: StateStore;
  private github!: GitHubClient;
  private monitor!: IssueMonitor;
  private planGenerator: PlanGenerator;
  private planReviewer: PlanReviewer;
  private planFinalizer: PlanFinalizer;
  private conversation!: ConversationManager;
  private branchManager!: PlanBranchManager;
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dbPath);
    this.planGenerator = new PlanGenerator(config);
    this.planReviewer = new PlanReviewer(config);
    this.planFinalizer = new PlanFinalizer(config);
  }

  // ============================================================
  // Initialization
  // ============================================================

  async initialize(): Promise<void> {
    logger.info("Initializing Ploomy...");
    logger.info("Configuration loaded.", {
      orgs: this.config.githubOrgs,
      repos: this.config.githubRepos,
      issueLabel: this.config.issueLabel,
      pollInterval: this.config.pollInterval,
      claudeModel: this.config.claudeModel ?? "(default)",
      codexModel: this.config.codexModel,
    });

    await this.verifyPrerequisites();

    this.github = await GitHubClient.createFromGhCli();
    this.monitor = new IssueMonitor(this.github, this.state, this.config);
    this.conversation = new ConversationManager(this.github, this.state);
    this.branchManager = new PlanBranchManager(this.github);

    mkdirSync(this.config.plansDir, { recursive: true });
    mkdirSync(this.config.workDir, { recursive: true });

    logger.info("Initialization complete. Starting daemon loop.");
  }

  // ============================================================
  // Prerequisites check (fail-fast)
  // ============================================================

  private async verifyPrerequisites(): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    // Check GitHub authentication
    const ghToken = process.env.GH_TOKEN;
    if (ghToken && ghToken.trim()) {
      logger.debug("Using GH_TOKEN environment variable for authentication.");
    } else {
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "status"]);
        logger.debug("gh CLI auth status OK.", {
          output: stdout.substring(0, 200),
        });
      } catch {
        throw new Error(
          "gh CLI is not authenticated. Set GH_TOKEN environment variable or run 'gh auth login'."
        );
      }
    }

    // Check Claude CLI
    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      logger.debug("claude CLI version.", { version: stdout.trim() });
    } catch {
      throw new Error(
        "claude CLI is not available. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }

    // Check Claude authentication
    if (
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      const homeDir = process.env.HOME ?? "/root";
      const credFile = `${homeDir}/.claude/.credentials.json`;
      if (!existsSync(credFile)) {
        logger.warn(
          "No Claude authentication detected. " +
            "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, " +
            "or ensure ~/.claude/.credentials.json exists."
        );
      }
    }

    // Check Codex CLI
    try {
      const { stdout } = await execFileAsync("codex", ["--version"]);
      logger.debug("codex CLI version.", { version: stdout.trim() });
    } catch {
      throw new Error(
        "codex CLI is not available. Install with: npm install -g @openai/codex"
      );
    }

    // Check git
    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      throw new Error("git is not available. Install git first.");
    }
  }

  // ============================================================
  // Main polling loop
  // ============================================================

  async run(): Promise<void> {
    this.registerShutdownHandlers();

    while (!this.isShuttingDown) {
      try {
        await this.pollCycle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error in polling cycle.", { error: message });
      }

      if (!this.isShuttingDown) {
        logger.info(
          `Sleeping for ${this.config.pollInterval}s before next cycle...`
        );
        await this.sleep(this.config.pollInterval * 1000);
      }
    }

    this.shutdown();
  }

  // ============================================================
  // Single polling cycle
  // ============================================================

  private async pollCycle(): Promise<void> {
    logger.info("Starting polling cycle...");

    const actionable = await this.monitor.discoverActionableIssues();

    if (actionable.length === 0) {
      logger.info("No actionable Issues found.");
      return;
    }

    for (const item of actionable) {
      if (this.isShuttingDown) break;
      await this.processIssue(item);
    }
  }

  // ============================================================
  // Process a single Issue based on its state
  // ============================================================

  private async processIssue(item: ActionableIssue): Promise<void> {
    const { issue, task } = item;
    const issueRef = `${issue.owner}/${issue.repo}#${issue.number}`;

    logger.info(`Processing ${issueRef} (state: ${task.state}).`, {
      issueId: task.issueId,
      state: task.state,
    });

    try {
      switch (task.state) {
        case "PENDING":
        case "QUESTIONING":
          await this.handleQuestioning(item);
          break;

        case "DRAFTING":
          await this.handleDrafting(item);
          break;

        case "REVIEWING":
          await this.handleReviewing(item);
          break;

        case "FINALIZING":
          await this.handleFinalizing(item);
          break;

        default:
          logger.debug(`Skipping ${issueRef} in state ${task.state}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error processing ${issueRef}.`, {
        error: message,
        issueId: task.issueId,
        state: task.state,
      });
      this.state.updateStateWithError(task.issueId, "FAILED", message);
    }
  }

  // ============================================================
  // State handlers
  // ============================================================

  private async handleQuestioning(item: ActionableIssue): Promise<void> {
    const { issue, task } = item;

    this.state.updateState(task.issueId, "QUESTIONING");

    const allComments = await this.github.getIssueComments(
      issue.owner,
      issue.repo,
      issue.number
    );

    const context: ConversationContext = {
      issue,
      comments: allComments,
      draftPlan: null,
      reviewOutput: null,
    };

    const result = await this.planGenerator.runQuestioning(context);

    if (result.hasQuestions && result.questions) {
      await this.conversation.postQuestions(
        task,
        result.questions,
        allComments,
        "AWAITING_USER"
      );
    } else {
      this.state.updateState(task.issueId, "DRAFTING");
      await this.handleDrafting(item);
    }
  }

  private async handleDrafting(item: ActionableIssue): Promise<void> {
    const { issue, task } = item;

    this.state.updateState(task.issueId, "DRAFTING");

    const allComments = await this.github.getIssueComments(
      issue.owner,
      issue.repo,
      issue.number
    );

    const context: ConversationContext = {
      issue,
      comments: allComments,
      draftPlan: null,
      reviewOutput: null,
    };

    const draftPath = join(
      this.config.plansDir,
      issue.owner,
      issue.repo,
      `${issue.number}.draft.plan.md`
    );

    const result = await this.planGenerator.runDrafting(context, draftPath);

    this.state.updateDraftPlanPath(task.issueId, draftPath);

    const summary = extractPlanSummary(result.planContent);
    await this.conversation.postDraftSummary(task, summary);

    this.state.updateState(task.issueId, "REVIEWING");
    await this.handleReviewing({
      ...item,
      task: this.state.getTask(task.issueId)!,
    });
  }

  private async handleReviewing(item: ActionableIssue): Promise<void> {
    const { issue, task } = item;

    if (!task.draftPlanPath) {
      throw new Error(
        `handleReviewing: no draftPlanPath for ${task.issueId}`
      );
    }

    const reviewPath = join(
      this.config.plansDir,
      issue.owner,
      issue.repo,
      `${issue.number}.review.txt`
    );

    const repoDir = join(this.config.workDir, issue.owner, issue.repo);

    const result = await this.planReviewer.reviewPlan(
      task.draftPlanPath,
      reviewPath,
      repoDir
    );

    this.state.updateReviewOutputPath(task.issueId, reviewPath);
    this.state.updateState(task.issueId, "FINALIZING");

    await this.handleFinalizing({
      ...item,
      task: this.state.getTask(task.issueId)!,
    });
  }

  private async handleFinalizing(item: ActionableIssue): Promise<void> {
    const { issue, task } = item;

    this.state.updateState(task.issueId, "FINALIZING");

    const allComments = await this.github.getIssueComments(
      issue.owner,
      issue.repo,
      issue.number
    );

    let draftPlan: string | null = null;
    if (task.draftPlanPath && existsSync(task.draftPlanPath)) {
      draftPlan = await readFile(task.draftPlanPath, "utf-8");
    }

    let reviewOutput: string | null = null;
    if (task.reviewOutputPath && existsSync(task.reviewOutputPath)) {
      reviewOutput = await readFile(task.reviewOutputPath, "utf-8");
    }

    const context: ConversationContext = {
      issue,
      comments: allComments,
      draftPlan,
      reviewOutput,
    };

    const finalPath = join(
      this.config.plansDir,
      issue.owner,
      issue.repo,
      `${issue.number}.plan.md`
    );

    const result = await this.planFinalizer.runFinalization(
      context,
      finalPath
    );

    if (result.hasQuestions && result.questions) {
      await this.conversation.postQuestions(
        task,
        result.questions,
        allComments,
        "AWAITING_USER_FINAL"
      );
      return;
    }

    if (!result.planContent) {
      throw new Error(
        `handleFinalizing: No plan content produced for ${task.issueId}`
      );
    }

    this.state.updateFinalPlanPath(task.issueId, finalPath);

    const { branchName, fileUrl } = await this.branchManager.pushPlanFile(
      issue.owner,
      issue.repo,
      issue.number,
      result.planContent,
      false
    );

    this.state.updatePlanBranch(task.issueId, branchName, fileUrl);

    const summary = extractPlanSummary(result.planContent);
    await this.conversation.postFinalPlan(task, summary, fileUrl, branchName);

    this.state.updateState(task.issueId, "DONE");

    logger.info(
      `Plan complete for ${issue.owner}/${issue.repo}#${issue.number}.`,
      { issueId: task.issueId, planFileUrl: fileUrl }
    );
  }

  // ============================================================
  // Shutdown
  // ============================================================

  private registerShutdownHandlers(): void {
    const handleShutdown = (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      this.isShuttingDown = true;
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private shutdown(): void {
    this.state.close();
    logger.info("Ploomy stopped.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearInterval(checkShutdown);
        resolve();
      }, ms);
      const checkShutdown = setInterval(() => {
        if (this.isShuttingDown) {
          clearTimeout(timer);
          clearInterval(checkShutdown);
          resolve();
        }
      }, 1000);
    });
  }
}

// ============================================================
// Plan summary extractor
// ============================================================

function extractPlanSummary(planContent: string): string {
  const lines = planContent.split("\n");
  const summaryLines: string[] = [];
  let lineCount = 0;
  const maxLines = 30;

  for (const line of lines) {
    summaryLines.push(line);
    lineCount++;
    if (lineCount >= maxLines) {
      summaryLines.push("\n... (truncated, see full plan for details)");
      break;
    }
  }

  return summaryLines.join("\n");
}

// ============================================================
// Single-instance lock
// ============================================================

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(dbPath: string): string {
  const lockPath = join(dirname(dbPath), "daemon.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existingPid = readFileSync(lockPath, "utf-8").trim();
      const pid = parseInt(existingPid, 10);

      if (!isNaN(pid) && isProcessRunning(pid)) {
        throw new Error(
          `Another daemon instance is already running (PID ${existingPid}, lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }

      try {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
      } catch {
        throw new Error(
          `Another daemon instance is already running (lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }
      return lockPath;
    }
    throw error;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup
  }
}

// ============================================================
// Entry point
// ============================================================

async function main(): Promise<void> {
  let lockPath: string | null = null;
  try {
    const config = loadConfig();
    setLogLevel(config.logLevel);

    mkdirSync(dirname(config.dbPath), { recursive: true });
    lockPath = acquireLock(config.dbPath);

    const daemon = new PloomyDaemon(config);
    await daemon.initialize();
    await daemon.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    if (lockPath) releaseLock(lockPath);
    process.exit(1);
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

main();
