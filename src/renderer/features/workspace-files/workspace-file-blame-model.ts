import type { GitReviewBlameLine } from "../../../shared/types";

/** Git author timestamps are seconds; dates are UTC calendar days. */
export function formatWorkspaceFileBlameDate(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The editable source view shows active-line blame, using the user's locale. */
export function formatWorkspaceFileActiveLineBlame(
  line: GitReviewBlameLine,
  locale: string,
): string | null {
  if (line.author === null || !line.commitSha || /^0+$/u.test(line.commitSha)) return null;
  const date =
    formatWorkspaceFileBlameDate(line.authorTime) === null
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(line.authorTime! * 1_000);
  return [line.author, line.summary, line.commitSha.slice(0, 8), date]
    .filter((value) => value !== null && value.length > 0)
    .join(" · ");
}
