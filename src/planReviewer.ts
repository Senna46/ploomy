// Plan reviewer for Ploomy.
// Runs Codex CLI (codex exec) in read-only sandbox mode to review a
// draft implementation plan and collect improvement suggestions.
// Uses --output-last-message to reliably capture the review output.
// Limitations: Codex CLI must be installed and authenticated.
//   5-minute timeout. Review failure transitions to FAILED for retry.

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";

import { logger } from "./logger.js";
import type { Config, ReviewResult } from "./types.js";

const CODEX_TIMEOUT_MS = 5 * 60 * 1000;
const SIGKILL_GRACE_MS = 5_000;

export class PlanReviewer {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Run Codex review
  // ============================================================

  async reviewPlan(
    draftPlanPath: string,
    reviewOutputPath: string,
    repoDir: string
  ): Promise<ReviewResult> {
    const planContent = await readFile(draftPlanPath, "utf-8");

    mkdirSync(join(reviewOutputPath, ".."), { recursive: true });

    const outputMessagePath = `${reviewOutputPath}.tmp`;

    const prompt =
      "Review the following implementation plan and suggest improvements. " +
      "Focus on:\n" +
      "1. Missing edge cases or error handling\n" +
      "2. Potential architectural issues\n" +
      "3. Missing steps or unclear instructions\n" +
      "4. Better alternatives for proposed approaches\n" +
      "5. Consistency with existing codebase patterns\n\n" +
      "Do NOT modify any files. Only provide review comments.\n\n" +
      "## Plan to review\n\n" +
      planContent;

    const args = ["exec"];
    if (this.config.codexModel) {
      args.push("-m", this.config.codexModel);
    }
    args.push(
      "-s",
      "read-only",
      "--output-last-message",
      outputMessagePath,
      "-"
    );

    logger.info("Running codex exec for plan review...", {
      codexModel: this.config.codexModel ?? "(default)",
      draftPlanPath,
    });

    await this.runCodex(args, repoDir, prompt);

    let reviewContent: string;
    try {
      reviewContent = await readFile(outputMessagePath, "utf-8");
      await cleanupTempFile(outputMessagePath);
    } catch (readError) {
      const message =
        readError instanceof Error ? readError.message : String(readError);
      throw new Error(
        `Failed to read codex review output from ${outputMessagePath}: ${message}`
      );
    }

    await writeFile(reviewOutputPath, reviewContent, "utf-8");

    logger.info("Codex review complete.", {
      reviewOutputPath,
      contentLength: reviewContent.length,
    });

    return { reviewContent };
  }

  // ============================================================
  // Codex CLI execution
  // ============================================================

  private async runCodex(args: string[], cwd: string, prompt?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const child = spawn("codex", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";

      child.stdout.on("data", () => {
        // Drain stdout to prevent pipe buffer from filling and blocking the process
      });

      const killTimer = setTimeout(() => {
        if (settled) return;
        logger.warn("codex exec timed out, sending SIGTERM.", {
          timeoutMs: CODEX_TIMEOUT_MS,
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          logger.warn(
            "codex exec did not exit after SIGTERM, sending SIGKILL."
          );
          child.kill("SIGKILL");
        }, SIGKILL_GRACE_MS);
      }, CODEX_TIMEOUT_MS);

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
              `codex exec timed out after ${CODEX_TIMEOUT_MS / 1000}s. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `codex exec exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        resolve();
      });

      child.on("error", (error) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`codex exec failed: ${error.message}`));
      });

      child.stdin.on("error", (err) => {
        logger.warn("codex exec stdin error (EPIPE expected if process exited early).", {
          error: err.message,
        });
      });

      if (prompt) {
        child.stdin.write(prompt);
      }
      child.stdin.end();
    });
  }
}

// ============================================================
// Utility
// ============================================================

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup
  }
}
