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
import { extractSearchableText } from "./planGenerator.js";
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
        "Your task is to triage the review suggestions and produce the best possible final plan.\n\n" +
        "You MUST NOT make any file changes — only read and explore the codebase."
    );

    sections.push(
      "## Triage guidelines\n\n" +
        "- **Accept** suggestions that clearly improve correctness, completeness, or clarity\n" +
        "- **Accept** suggestions that align with the project's existing conventions " +
        "(check CLAUDE.md, AGENTS.md if available)\n" +
        "- **Reject** suggestions that contradict the original plan's design decisions " +
        "without strong justification\n" +
        "- **Reject** suggestions that add unnecessary complexity or over-engineer " +
        "what should be simple\n" +
        "- **Ask the user** if a review suggestion proposes a major architectural change " +
        "that would significantly alter the plan's direction — present specific options (A/B/C)\n" +
        "- **Verify in code** — Use available tools to check whether a suggestion is " +
        "actually applicable to the current codebase before accepting it"
    );

    sections.push(this.formatConversationHistory(context));

    if (context.draftPlan) {
      sections.push(`## Draft plan\n\n${context.draftPlan}`);
    }

    if (context.reviewOutput) {
      sections.push(`## Codex review suggestions\n\n${context.reviewOutput}`);
    }

    sections.push(
      "## Output format\n\n" +
        "If you need to ask about major changes (1-2 questions max, with concrete options):\n\n" +
        "QUESTIONS:\n" +
        "1. [Question with options A/B]\n\n" +
        "Otherwise, output the final plan following the same format principles:\n" +
        "- Cite specific file paths with Markdown links\n" +
        "- Use bullet lists instead of tables\n" +
        "- Use mermaid diagrams where they help explain architecture\n" +
        "- Keep proportional to complexity — don't pad simple plans\n" +
        "- End with an ordered task list\n\n" +
        "PLAN_CONTENT:\n" +
        "# Implementation Plan for Issue #N\n\n" +
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

    const questionsMatch = text.match(/QUESTIONS:\s*\n([\s\S]+?)(?=\nPLAN_CONTENT:\s*\n|$)/s);
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
      if (!existsSync(repoDir)) {
        reject(
          new Error(
            `runClaude (finalization): target repo directory does not exist: ${repoDir}. Ensure the repository is cloned first.`
          )
        );
        return;
      }
      const cwd = repoDir;

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

