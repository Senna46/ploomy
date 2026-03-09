// Issue body and comment parser for Ploomy.
// Extracts structured data from raw Issue content and identifies
// bot-generated comments using HTML marker detection.
// Limitations: Depends on PLOOMY_COMMENT marker format.

import type { IssueComment } from "./types.js";

const PLOOMY_COMMENT_MARKER = "<!-- PLOOMY_COMMENT -->";

export function isBotComment(comment: IssueComment): boolean {
  return comment.body.includes(PLOOMY_COMMENT_MARKER);
}

export function findNewHumanComments(
  comments: IssueComment[],
  afterCommentId: number | null
): IssueComment[] {
  return comments.filter((comment) => {
    if (isBotComment(comment)) return false;
    if (afterCommentId === null) return true;
    return comment.id > afterCommentId;
  });
}

export function collectMentionTargets(
  issueAuthor: string,
  comments: IssueComment[]
): string[] {
  const users = new Set<string>();
  users.add(issueAuthor);

  for (const comment of comments) {
    if (!isBotComment(comment) && comment.author !== "unknown") {
      users.add(comment.author);
    }
  }

  return [...users];
}
