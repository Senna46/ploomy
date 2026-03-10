// Plan finalizer for Ploomy.
// Takes the draft plan and Codex review output, then runs Claude CLI
// to autonomously triage review suggestions and produce the final plan.
// May ask the user for confirmation on major design changes.
// Limitations: Same as planGenerator (claude -p timeout, marker parsing).

import { mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

import { logger } from "./logger.js";
import {
  formatConversationHistory,
  runClaude,
} from "./planGenerator.js";
import type {
  Config,
  ConversationContext,
  FinalizingResult,
} from "./types.js";

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
    outputPath: string,
    preClonedRepoDir?: string
  ): Promise<FinalizingResult> {
    if (!preClonedRepoDir) {
      throw new Error("runFinalization: preClonedRepoDir is required");
    }
    const repoDir = preClonedRepoDir;

    const prompt = this.buildFinalizationPrompt(context);
    const output = await runClaude(repoDir, prompt, this.config.claudeModel, "finalization");
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

    sections.push(formatConversationHistory(context));

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
  // Output parser
  // ============================================================

  private parseFinalizationOutput(output: string): FinalizingResult {
    const text = output;

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

}

