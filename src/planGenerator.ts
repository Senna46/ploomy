// Plan generator for Ploomy.
// Handles both the QUESTIONING phase (asking clarifying questions) and
// the DRAFTING phase (generating the implementation plan) using Claude CLI.
// Clones the target repository locally and runs claude -p with read-only
// tools so the codebase can be explored without modification.
// Limitations: Requires claude CLI with push access to nothing.
//   Output parsing depends on QUESTIONS:/READY/PLAN_CONTENT: markers.
//   10-minute timeout per claude -p invocation.

import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { logger } from "./logger.js";
import type {
  Config,
  ConversationContext,
  DraftingResult,
  QuestioningResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const ALLOWED_TOOLS = [
  "Read",
  "Bash(find *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(tree *)",
  "Bash(wc *)",
  "Bash(head *)",
  "Bash(tail *)",
].join(",");

const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_STDOUT_SIZE = 500_000;
const MAX_DOC_SIZE = 10_000;
const PROJECT_DOC_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"];

export class PlanGenerator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // QUESTIONING phase
  // ============================================================

  async runQuestioning(
    context: ConversationContext
  ): Promise<QuestioningResult> {
    const repoDir = await this.ensureRepoClone(context.issue);
    const projectDocs = await this.getProjectDocumentation(repoDir);
    const projectStructure = await this.getProjectStructure(repoDir);

    const prompt = this.buildQuestioningPrompt(
      context,
      projectDocs,
      projectStructure
    );

    const output = await this.runClaude(repoDir, prompt);
    return this.parseQuestioningOutput(output);
  }

  // ============================================================
  // DRAFTING phase
  // ============================================================

  async runDrafting(
    context: ConversationContext,
    outputPath: string
  ): Promise<DraftingResult> {
    const repoDir = await this.ensureRepoClone(context.issue);
    const projectDocs = await this.getProjectDocumentation(repoDir);
    const projectStructure = await this.getProjectStructure(repoDir);

    const prompt = this.buildDraftingPrompt(
      context,
      projectDocs,
      projectStructure
    );

    const output = await this.runClaude(repoDir, prompt);
    const result = this.parseDraftingOutput(output);

    mkdirSync(join(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, result.planContent, "utf-8");

    logger.info("Draft plan saved.", {
      outputPath,
      contentLength: result.planContent.length,
    });

    return result;
  }

  // ============================================================
  // Prompt builders
  // ============================================================

  private buildQuestioningPrompt(
    context: ConversationContext,
    projectDocs: string,
    projectStructure: string
  ): string {
    const sections: string[] = [];

    sections.push(
      "You are analyzing a GitHub Issue to prepare an implementation plan. " +
        "Your task is to determine whether you have enough information to create " +
        "a detailed, actionable plan, or if you need to ask clarifying questions first.\n\n" +
        "IMPORTANT: Ask ALL questions you need before proceeding. " +
        "Do not leave any ambiguity that would affect the plan quality."
    );

    if (projectStructure) {
      sections.push(
        `## Project structure\n\n\`\`\`\n${projectStructure}\n\`\`\``
      );
    }

    if (projectDocs) {
      sections.push(`## Project documentation\n\n${projectDocs}`);
    }

    sections.push(this.formatConversationHistory(context));

    sections.push(
      "## Instructions\n\n" +
        "Explore the codebase using the available tools (Read, grep, find, ls, tree, etc.) " +
        "to understand the project structure and conventions.\n\n" +
        "Then determine:\n" +
        "- Is the Issue description clear enough to create a detailed implementation plan?\n" +
        "- Are there ambiguous requirements that need clarification?\n" +
        "- Are there technical decisions that the user should make?\n\n" +
        "If you have questions, output them in the following format:\n\n" +
        "QUESTIONS:\n" +
        "1. Your first question\n" +
        "2. Your second question\n" +
        "...\n\n" +
        "If you have NO questions and are ready to create the plan, output:\n\n" +
        "READY"
    );

    return sections.join("\n\n");
  }

  private buildDraftingPrompt(
    context: ConversationContext,
    projectDocs: string,
    projectStructure: string
  ): string {
    const sections: string[] = [];

    sections.push(
      "You are creating a detailed implementation plan for a GitHub Issue. " +
        "All clarifying questions have been resolved. " +
        "Create a comprehensive, actionable plan in Markdown format."
    );

    if (projectStructure) {
      sections.push(
        `## Project structure\n\n\`\`\`\n${projectStructure}\n\`\`\``
      );
    }

    if (projectDocs) {
      sections.push(`## Project documentation\n\n${projectDocs}`);
    }

    sections.push(this.formatConversationHistory(context));

    sections.push(
      "## Instructions\n\n" +
        "Explore the codebase thoroughly using the available tools. " +
        "Then create a detailed implementation plan that includes:\n\n" +
        "1. **Summary** - Brief overview of what will be implemented\n" +
        "2. **Key Decisions** - Architecture and design choices\n" +
        "3. **Files to Modify** - List of files to create or modify, with specific details\n" +
        "4. **Implementation Steps** - Ordered, actionable steps with code-level detail\n" +
        "5. **Dependencies** - New packages or tools needed\n" +
        "6. **Testing Strategy** - How to verify the implementation\n\n" +
        "Cite specific file paths and relevant code snippets from the existing codebase. " +
        "The plan should be detailed enough for an engineer to implement without further questions.\n\n" +
        "Output the plan in the following format:\n\n" +
        "PLAN_CONTENT:\n" +
        "# Implementation Plan for Issue #{issueNumber}\n\n" +
        "... (your plan in Markdown) ..."
    );

    return sections.join("\n\n");
  }

  // ============================================================
  // Conversation history formatter
  // ============================================================

  private formatConversationHistory(context: ConversationContext): string {
    const parts: string[] = [];

    parts.push(
      `## Issue: ${context.issue.title}\n\n` +
        `**Author:** @${context.issue.author}\n` +
        `**URL:** ${context.issue.htmlUrl}\n\n` +
        `### Issue body\n\n${context.issue.body || "(empty)"}`
    );

    if (context.comments.length > 0) {
      const commentEntries = context.comments
        .map(
          (c) =>
            `**@${c.author}** (${c.createdAt}):\n${c.body}`
        )
        .join("\n\n---\n\n");
      parts.push(`### Conversation history\n\n${commentEntries}`);
    }

    if (context.draftPlan) {
      parts.push(
        `### Previous draft plan\n\n${context.draftPlan}`
      );
    }

    return parts.join("\n\n");
  }

  // ============================================================
  // Output parsers
  // ============================================================

  private parseQuestioningOutput(output: string): QuestioningResult {
    const text = extractSearchableText(output);

    const questionsMatch = text.match(/QUESTIONS:\s*\n([\s\S]+?)(?:\n\n|$)/);
    if (questionsMatch) {
      return {
        hasQuestions: true,
        questions: questionsMatch[1].trim(),
        ready: false,
      };
    }

    if (text.includes("READY")) {
      return { hasQuestions: false, questions: null, ready: true };
    }

    // If neither marker found, treat as ready (best-effort)
    logger.warn(
      "Claude output contained neither QUESTIONS: nor READY marker. Treating as ready.",
      { outputLength: text.length }
    );
    return { hasQuestions: false, questions: null, ready: true };
  }

  private parseDraftingOutput(output: string): DraftingResult {
    const text = extractSearchableText(output);

    const planMatch = text.match(/PLAN_CONTENT:\s*\n([\s\S]+)/);
    if (planMatch) {
      return { planContent: planMatch[1].trim() };
    }

    // If no marker, use the entire output as the plan
    logger.warn(
      "Claude output did not contain PLAN_CONTENT: marker. Using full output as plan.",
      { outputLength: text.length }
    );
    return { planContent: text.trim() };
  }

  // ============================================================
  // Claude CLI execution
  // ============================================================

  private async runClaude(repoDir: string, prompt: string): Promise<string> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p...", { repoDir });

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const child = spawn("claude", args, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const killTimer = setTimeout(() => {
        if (settled) return;
        logger.warn("claude -p timed out, sending SIGTERM.", {
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          logger.warn(
            "claude -p did not exit after SIGTERM, sending SIGKILL."
          );
          child.kill("SIGKILL");
        }, SIGKILL_GRACE_MS);
      }, CLAUDE_TIMEOUT_MS);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_STDOUT_SIZE) {
          stdout = stdout.substring(stdout.length - MAX_STDOUT_SIZE);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code, signal) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(
            new Error(
              `claude -p timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `claude -p exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        resolve(stdout);
      });

      child.on("error", (error) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`claude -p failed: ${error.message}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Repository cloning
  // ============================================================

  private async ensureRepoClone(issue: {
    owner: string;
    repo: string;
  }): Promise<string> {
    mkdirSync(this.config.workDir, { recursive: true });

    const repoDir = join(this.config.workDir, issue.owner, issue.repo);

    if (existsSync(join(repoDir, ".git"))) {
      logger.debug("Fetching latest for existing clone.", { repoDir });
      await execFileAsync("git", ["fetch", "--all", "--prune"], {
        cwd: repoDir,
        timeout: 2 * 60 * 1000,
      });
    } else {
      logger.info("Cloning repository.", {
        owner: issue.owner,
        repo: issue.repo,
        repoDir,
      });
      mkdirSync(join(this.config.workDir, issue.owner), { recursive: true });
      const cloneUrl = `https://github.com/${issue.owner}/${issue.repo}.git`;
      await execFileAsync(
        "git",
        ["clone", cloneUrl, join(issue.owner, issue.repo)],
        {
          cwd: this.config.workDir,
          timeout: 2 * 60 * 1000,
        }
      );
    }

    return repoDir;
  }

  // ============================================================
  // Project context helpers
  // ============================================================

  private async getProjectStructure(repoDir: string): Promise<string> {
    const maxSize = 5_000;
    try {
      const { stdout } = await execFileAsync(
        "tree",
        [
          "-L",
          "3",
          "-I",
          "node_modules|.git|dist|build|__pycache__|.next|venv|.venv",
        ],
        { cwd: repoDir, timeout: 10_000, maxBuffer: 1024 * 1024 }
      );
      return stdout.length > maxSize
        ? stdout.substring(0, maxSize) + "\n... (truncated)"
        : stdout;
    } catch {
      try {
        const { stdout } = await execFileAsync(
          "find",
          [
            ".",
            "-maxdepth",
            "3",
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
          ],
          { cwd: repoDir, timeout: 10_000, maxBuffer: 1024 * 1024 }
        );
        return stdout.length > maxSize
          ? stdout.substring(0, maxSize) + "\n... (truncated)"
          : stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Failed to get project structure.", {
          error: message,
          repoDir,
        });
        return "";
      }
    }
  }

  private async getProjectDocumentation(repoDir: string): Promise<string> {
    const sections: string[] = [];

    for (const fileName of PROJECT_DOC_FILES) {
      const filePath = join(repoDir, fileName);
      try {
        if (!existsSync(filePath)) continue;
        let content = await readFile(filePath, "utf-8");
        if (content.length > MAX_DOC_SIZE) {
          content = content.substring(0, MAX_DOC_SIZE) + "\n... (truncated)";
        }
        sections.push(`### ${fileName}\n\n${content}`);
      } catch {
        logger.debug(`Could not read project documentation: ${fileName}`);
      }
    }

    return sections.join("\n\n");
  }
}

// ============================================================
// Utility: extract searchable text from claude -p output
// ============================================================

function extractSearchableText(claudeOutput: string): string {
  const trimmed = claudeOutput.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      // fall through to JSONL scanning
    }
  }

  const jsonLines = trimmed.split("\n");
  for (let i = jsonLines.length - 1; i >= 0; i--) {
    const line = jsonLines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      continue;
    }
  }

  return claudeOutput;
}
