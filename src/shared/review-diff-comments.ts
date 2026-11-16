import { defineMessages, type MessageDescriptor } from "./i18n/messages";
import type {
  CodexReviewDiffCommentAttachment,
  ReviewDiffAnnotationSide,
  ReviewDiffCommentPositionSide,
} from "./types";

export const REVIEW_DIFF_COMMENTS_ADDITIONAL_CONTEXT_KEY = "review-diff-comments";
export const REVIEW_DIFF_COMMENT_DRAFTS_STORAGE_KEY = "diff_comment_drafts";

export function mapReviewDiffAnnotationSideToPositionSide(
  side: ReviewDiffAnnotationSide,
): ReviewDiffCommentPositionSide {
  return side === "deletions" ? "left" : "right";
}

export function mapReviewDiffPositionSideToAnnotationSide(
  side: ReviewDiffCommentPositionSide,
): ReviewDiffAnnotationSide {
  return side === "left" ? "deletions" : "additions";
}

export function getReviewDiffLinePrefix(
  side: ReviewDiffAnnotationSide | ReviewDiffCommentPositionSide,
): "L" | "R" {
  return side === "deletions" || side === "left" ? "L" : "R";
}

export function buildReviewDiffAnnotationKey(
  side: ReviewDiffAnnotationSide,
  lineNumber: number,
): string {
  return `${side}:${lineNumber}`;
}

export function formatReviewDiffLineReference(input: {
  side: ReviewDiffAnnotationSide | ReviewDiffCommentPositionSide;
  line: number;
}): string {
  return `${getReviewDiffLinePrefix(input.side)}${input.line}`;
}

const REVIEW_COMMENT_LINE_MESSAGES = defineMessages({
  line: { id: "shared.reviewDiffComments.line", defaultMessage: "Comment on line {end}" },
  range: {
    id: "shared.reviewDiffComments.range",
    defaultMessage: "Comment on lines {start} to {end}",
  },
  chipLine: { id: "shared.reviewDiffComments.chipLine", defaultMessage: "line {end}" },
  chipRange: {
    id: "shared.reviewDiffComments.chipRange",
    defaultMessage: "lines {start} to {end}",
  },
});

interface ReviewCommentLine {
  side: ReviewDiffAnnotationSide | ReviewDiffCommentPositionSide;
  line: number;
  startSide?: ReviewDiffAnnotationSide | ReviewDiffCommentPositionSide;
  startLine?: number;
}

type FormatReviewCommentLine = (
  message: MessageDescriptor,
  values: { end: string; start?: string },
) => string;

function reviewCommentLineParts(input: ReviewCommentLine): { end: string; start?: string } {
  const end = formatReviewDiffLineReference({ side: input.side, line: input.line });
  if (
    !input.startLine ||
    (input.startLine === input.line && (!input.startSide || input.startSide === input.side))
  )
    return { end };
  const start = formatReviewDiffLineReference({
    side: input.startSide ?? input.side,
    line: input.startLine,
  });
  return { end, start };
}

export function formatReviewDiffCommentLineLabel(
  input: ReviewCommentLine,
  formatMessage?: FormatReviewCommentLine,
): string {
  const values = reviewCommentLineParts(input);
  if (formatMessage) {
    return formatMessage(
      values.start ? REVIEW_COMMENT_LINE_MESSAGES.range : REVIEW_COMMENT_LINE_MESSAGES.line,
      values,
    );
  }
  return values.start
    ? `Comment on lines ${values.start} to ${values.end}`
    : `Comment on line ${values.end}`;
}

export function formatReviewDiffCommentChipLabel(
  input: ReviewCommentLine,
  formatMessage: FormatReviewCommentLine,
): string {
  const values = reviewCommentLineParts(input);
  return formatMessage(
    values.start ? REVIEW_COMMENT_LINE_MESSAGES.chipRange : REVIEW_COMMENT_LINE_MESSAGES.chipLine,
    values,
  );
}

export function getReviewDiffCommentText(attachment: CodexReviewDiffCommentAttachment): string {
  return attachment.content
    .filter((part) => part.content_type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function serializeReviewDiffCommentAttachmentForPrompt(
  attachment: CodexReviewDiffCommentAttachment,
): string {
  const position = attachment.position;
  const lineLabel = formatReviewDiffCommentLineLabel({
    side: position.side,
    line: position.line,
    ...(position.start_line ? { startLine: position.start_line } : {}),
    ...(position.start_side ? { startSide: position.start_side } : {}),
  });
  const comment = getReviewDiffCommentText(attachment);
  const chunks = [
    "Review diff comment:",
    `File: ${position.path}`,
    `Side: ${position.side}`,
    `Lines: ${lineLabel.replace(/^Comment on (?:line|lines) /u, "")}`,
  ];

  if (attachment.localDiffHunk?.trim()) {
    chunks.push("Diff hunk:", attachment.localDiffHunk.trim());
  }

  chunks.push("Comment:", comment);
  return chunks.join("\n");
}

export function serializeReviewDiffCommentAttachmentsForAdditionalContext(
  attachments: readonly CodexReviewDiffCommentAttachment[],
): string {
  return JSON.stringify(
    attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      content: attachment.content,
      position: attachment.position,
      localDiffHunk: attachment.localDiffHunk ?? null,
      source: attachment.source ?? null,
      createdAt: attachment.createdAt,
    })),
  );
}

export function captureReviewDiffLocalHunkFromPatch(input: {
  patchText: string;
  side: ReviewDiffAnnotationSide;
  lineNumber: number;
}): string | undefined {
  const normalizedPatch = input.patchText.replace(/\r\n/g, "\n");
  const lines = normalizedPatch.split("\n");
  let current: {
    startIndex: number;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  } | null = null;

  const flushContainsLine = (endIndex: number): string | undefined => {
    if (!current) return undefined;
    const rangeStart = input.side === "deletions" ? current.oldStart : current.newStart;
    const rawCount = input.side === "deletions" ? current.oldCount : current.newCount;
    const count = Math.max(rawCount, 1);
    const rangeEnd = rangeStart + count - 1;
    if (input.lineNumber < rangeStart || input.lineNumber > rangeEnd) {
      return undefined;
    }
    return lines.slice(current.startIndex, endIndex).join("\n").trimEnd();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("@@ ")) {
      const existing = flushContainsLine(index);
      if (existing) return existing;

      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      current = match
        ? {
            startIndex: index,
            oldStart: Number(match[1]),
            oldCount: Number(match[2] ?? "1"),
            newStart: Number(match[3]),
            newCount: Number(match[4] ?? "1"),
          }
        : null;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const existing = flushContainsLine(index);
      if (existing) return existing;
      current = null;
    }
  }

  return flushContainsLine(lines.length);
}
