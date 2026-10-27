import { foldSearchQuery, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

export interface SessionSearchSubject {
  readonly sessionId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly projectName: string | null;
  readonly pullRequests: readonly {
    readonly number: number;
    readonly title?: string | null;
    readonly url: string;
    readonly repository: string;
  }[];
  readonly activityAt: number | null;
  readonly opens?: {
    readonly openedAt: number;
    readonly score: number;
    readonly picks: readonly { readonly query: string; readonly at: number }[];
  } | null;
}
export interface SessionMetadataRank {
  readonly quality: number;
  readonly score: number;
  readonly strong: boolean;
  readonly source: "title" | "branch" | "pull_request" | "project" | "reference";
}
/** The same token, word, typo and weighted-field matcher used for ordinary Thread search. */
export const rankSessionMetadata = (
  subject: SessionSearchSubject,
  query: string,
  now: number,
  typos: boolean,
): SessionMetadataRank | null => {
  const match = scoreThreadSearch(
    foldSearchQuery(query),
    {
      id: subject.sessionId,
      title: subject.title,
      branch: subject.branch,
      projectTitle: subject.projectName,
      pullRequests: subject.pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title ?? null,
        references: [pr.url, pr.repository],
      })),
      activityAt: subject.activityAt,
      opens: subject.opens ?? null,
    },
    now,
    { picks: false, typos },
  );
  if (match === null) return null;
  const label = match.explain?.()?.label;
  return {
    quality: match.quality,
    score: match.score,
    strong: match.strong,
    source:
      match.ranges.length > 0
        ? "title"
        : label === "ID or link"
          ? "reference"
          : label === "Branch"
            ? "branch"
            : label === "Project"
              ? "project"
              : "pull_request",
  };
};
const matchClass = (quality: number) =>
  quality >= 1.5 ? 3 : quality >= 0.7 ? 2 : quality >= 0.4 ? 1 : 0;
/** Fixed clock scores plus stable identity make the ranking key safe for later windows. */
export const compareSessionMetadataRank = (
  left: SessionMetadataRank & { readonly sessionId: string },
  right: SessionMetadataRank & { readonly sessionId: string },
) =>
  matchClass(right.quality) - matchClass(left.quality) ||
  right.score - left.score ||
  left.sessionId.localeCompare(right.sessionId);

export interface SessionSearchSummary extends Omit<SessionSearchSubject, "activityAt"> {
  readonly latestUserAuthoredMessageAt: string | null;
  readonly createdAt: string;
}
export const sessionSearchSubject = (session: SessionSearchSummary): SessionSearchSubject => ({
  sessionId: session.sessionId,
  title: session.title,
  branch: session.branch,
  projectName: session.projectName,
  pullRequests: session.pullRequests,
  opens: session.opens ?? null,
  activityAt: Date.parse(session.latestUserAuthoredMessageAt ?? session.createdAt),
});
/** Classification uses the same metadata matcher in all search source adapters. */
export const matchesSessionMetadata = (
  session: SessionSearchSummary,
  query: string,
  mode: "exact" | "typos",
) => rankSessionMetadata(sessionSearchSubject(session), query, 0, mode === "typos") !== null;
