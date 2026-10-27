import type { GitReviewBlameLine } from "../../shared/types";

/** Parses line porcelain, keeping author metadata attached to each final-file line. */
export function parseGitBlamePorcelain(stdout: string): GitReviewBlameLine[] {
  const lines: GitReviewBlameLine[] = [];
  let current: GitReviewBlameLine | null = null;
  for (const chunk of stdout.split("\n")) {
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/u.exec(chunk);
    if (header) {
      current = {
        commitSha: header[1]!,
        line: Number(header[2]),
        author: null,
        authorTime: null,
        summary: null,
      };
      continue;
    }
    if (current === null) continue;
    if (chunk.startsWith("\t")) {
      if (current.line > 0) lines.push(current);
      current = null;
      continue;
    }
    if (chunk.startsWith("author ")) {
      current.author = chunk.slice("author ".length) || null;
      continue;
    }
    if (chunk.startsWith("author-time ")) {
      const seconds = Number(chunk.slice("author-time ".length));
      current.authorTime = Number.isFinite(seconds) ? seconds : null;
      continue;
    }
    if (chunk.startsWith("summary ")) current.summary = chunk.slice("summary ".length) || null;
  }
  return lines;
}
