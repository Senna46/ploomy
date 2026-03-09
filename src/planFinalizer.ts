// Plan finalizer for Ploomy.
// Takes the draft plan and Codex review output, then runs Claude CLI
// to autonomously triage review suggestions and produce the final plan.
// May ask the user for confirmation on major design changes.
// Limitations: Same as planGenerator (claude -p timeout, marker parsing).

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
  FinalizingResult,
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

export class PlanFinalizer {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Run finalization
  // ============================================================

  async runFinalization(
    context: ConversationContext,
    outputPath: string
  ): Promise<FinalizingResult> {
    const repoDir = join(
      this.config.workDir,
      context.issue.owner,
      context.issue.repo
    );

    if (existsSync(join(repoDir, ".git"))) {
      await execFileAsync("git", ["fetch", "--all", "--prune"], {
        cwd: repoDir,
        timeout: 2 * 60 * 1000,
      });
    }

    const prompt = this.buildFinalizationPrompt(context);
    const output = await this.runClaude(repoDir, prompt);
    const result = this.parseFinalizationOutput(output);

    if (result.planContent) {
      mkdirSync(join(outputPath, ".."), { recursive: true });
      await writeFile(outputPath, result.planContent, "utf-8");

      logger.info("Final plan saved.", {
        outputPath,
        contentLength: result.planContent.length,
      });
    }

    return result;
  }

  // ============================================================
  // Prompt builder
  // ============================================================

  private buildFinalizationPrompt(context: ConversationContext): string {
    const sections: string[] = [];

    sections.push(
      "You are finalizing an implementation plan for a GitHub Issue. " +
        "A draft plan has been created and reviewed by another AI model (Codex). " +
        "Your task is to triage the review suggestions and produce the final plan.\n\n" +
        "Guidelines for triage:\n" +
        "- Accept suggestions that clearly improve correctness, completeness, or clarity\n" +
        "- Reject suggestions that contradict the original plan's design decisions " +
        "without strong justification\n" +
        "- Reject suggestions that add unnecessary complexity\n" +
        "- If a review suggestion proposes a major architectural change, " +
        "ask the user for confirmation rather than accepting autonomously"
    );

    sections.push(this.formatConversationHistory(context));

    if (context.draftPlan) {
      sections.push(`## Draft plan\n\n${context.draftPlan}`);
    }

    if (context.reviewOutput) {
      sections.push(`## Codex review\n\n${context.reviewOutput}`);
    }

    sections.push(
      "## Instructions\n\n" +
        "Review the Codex suggestions and produce the final plan. " +
        "You may explore the codebase with available tools to verify suggestions.\n\n" +
        "If you need to ask the user about any major changes, output:\n\n" +
        "QUESTIONS:\n" +
        "1. Your question\n" +
        "...\n\n" +
        "Otherwise, output the final plan:\n\n" +
        "PLAN_CONTENT:\n" +
        "# Implementation Plan for Issue #{issueNumber}\n\n" +
        "... (your final plan in Markdown) ..."
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

    return parts.join("\n\n");
  }

  // ============================================================
  // Output parser
  // ============================================================

  private parseFinalizationOutput(output: string): FinalizingResult {
    const text = extractSearchableText(output);

    const questionsMatch = text.match(/QUESTIONS:\s*\n([\s\S]+?)(?:\n\n|$)/);
    if (questionsMatch) {
      return {
        hasQuestions: true,
        questions: questionsMatch[1].trim(),
        planContent: null,
      };
    }

    const planMatch = text.match(/PLAN_CONTENT:\s*\n([\s\S]+)/);
    if (planMatch) {
      return {
        hasQuestions: false,
        questions: null,
        planContent: planMatch[1].trim(),
      };
    }

    logger.warn(
      "Claude finalization output did not contain expected markers. Using full output as plan.",
      { outputLength: text.length }
    );
    return {
      hasQuestions: false,
      questions: null,
      planContent: text.trim(),
    };
  }

  // ============================================================
  // Claude CLI execution
  // ============================================================

  private async runClaude(repoDir: string, prompt: string): Promise<string> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p for finalization...", { repoDir });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cwd = existsSync(repoDir) ? repoDir : process.cwd();

      const child = spawn("claude", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const killTimer = setTimeout(() => {
        if (settled) return;
        logger.warn("claude -p (finalization) timed out, sending SIGTERM.", {
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
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
              `claude -p (finalization) timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `claude -p (finalization) exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
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
        reject(
          new Error(`claude -p (finalization) failed: ${error.message}`)
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
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
      // fall through
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
