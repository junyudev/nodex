import { scoreMessageSearch, type ThreadOpenStats } from "@nodex/runtime-shared/paletteSearch";
import type { SearchFieldEvidence } from "@nodex/search-kernel";
import { searchKernel, compileSearchQuery, type SearchTextQuery } from "@nodex/search-kernel/node";
import {
  fieldRank,
  matchedRanges,
  phraseBonus,
  rankQuality,
  strongRank,
} from "./SessionSearchText.ts";

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
  readonly opens?: Pick<ThreadOpenStats, "openedAt" | "score"> | null;
}
type Source = "title" | "branch" | "pull_request" | "project" | "reference";
export interface SessionMetadataRank {
  readonly wordQuality: number;
  readonly quality: number;
  readonly score: number;
  readonly strong: boolean;
  readonly source: Source;
}
const labelFor: Record<Exclude<Source, "title">, string> = {
  branch: "Branch",
  pull_request: "PR",
  project: "Project",
  reference: "ID or link",
};

interface Field {
  readonly source: Source;
  readonly text: string;
  readonly beforeTypos: SearchFieldEvidence;
  readonly afterTypos: SearchFieldEvidence;
}
const fieldKind = (source: Source) => (source === "title" ? "title" : "metadata");

export function sessionMetadataEvidence(
  subject: SessionSearchSubject,
  query: SearchTextQuery,
  raw: string,
) {
  const fields: Field[] = [];
  const add = (source: Source, text: string | null | undefined) => {
    if (!text) return;
    const beforeTypos = query.evidence(text, "metadata", false);
    const afterTypos = beforeTypos.words.every(
      (word) => word && strongRank(fieldRank(word.quality, fieldKind(source))),
    )
      ? beforeTypos
      : query.evidence(text, "metadata", true);
    fields.push({ source, text, beforeTypos, afterTypos });
  };
  add("title", subject.title);
  add("branch", subject.branch);
  add("project", subject.projectName);
  for (const pr of subject.pullRequests) {
    add("pull_request", `#${pr.number}`);
    add("pull_request", pr.title);
  }
  if (raw.length >= 8) {
    const needle = searchKernel().foldText(raw);
    for (const reference of [
      subject.sessionId,
      ...subject.pullRequests.flatMap(({ url, repository }) => [url, repository]),
    ]) {
      const value = searchKernel().foldText(reference);
      if (value.startsWith(needle) || (/\d/u.test(needle) && value.includes(needle)))
        add("reference", reference);
    }
  }
  const words = query.words();
  const ranks = (key: "beforeTypos" | "afterTypos") =>
    words.map((_, index) =>
      fields.reduce<number | null>((best, field) => {
        const word = field[key].words[index];
        if (!word) return best;
        const rank = fieldRank(word.quality, fieldKind(field.source));
        return best === null ? rank : Math.min(best, rank);
      }, null),
    );
  const withoutTypos = ranks("beforeTypos");
  const withTypos = ranks("afterTypos");
  return {
    withoutTypos,
    withTypos,
    render: (strongWords: readonly boolean[], now: number) => {
      const best = withoutTypos.map((rank, index) =>
        strongWords[index] ? rank : withTypos[index],
      );
      if (!best.length || best.some((rank) => rank === null || rank === undefined)) return null;
      const weakest = Math.max(...(best as number[]));
      const wordQuality = rankQuality(weakest);
      const quality =
        wordQuality + (fields.some(({ beforeTypos }) => beforeTypos.ordered) ? phraseBonus : 0);
      const highlights = fields.map((field) => ({
        ...field,
        ranges: matchedRanges(
          field.beforeTypos.words.map((word, index) =>
            strongWords[index] ? word : (field.afterTypos.words[index] ?? null),
          ),
        ),
      }));
      const title = highlights.find((field) => field.source === "title");
      const titleRanges = title?.ranges ?? [];
      const other = highlights.find((field) => field.source !== "title" && field.ranges.length);
      const label =
        other?.source && other.source !== "title" ? labelFor[other.source] : "ID or link";
      const rank = scoreMessageSearch({ wordQuality, quality }, subject, now);
      return {
        ...rank,
        strong: strongRank(weakest),
        source: titleRanges.length ? ("title" as const) : (other?.source ?? ("reference" as const)),
        titleRanges,
        hint:
          !titleRanges.length && other ? { label, text: other.text, ranges: other.ranges } : null,
      };
    },
  };
}

export const rankSessionMetadata = (
  subject: SessionSearchSubject,
  query: string,
  now: number,
  typos: boolean,
): SessionMetadataRank | null => {
  using compiled = compileSearchQuery(query);
  const evidence = sessionMetadataEvidence(subject, compiled, query);
  return evidence.render(
    evidence.withoutTypos.map(() => !typos),
    now,
  );
};

/** Fixed clock scores plus stable identity make the ranking key safe for later windows. */
export const compareSessionMetadataRank = (
  left: SessionMetadataRank & { readonly sessionId: string },
  right: SessionMetadataRank & { readonly sessionId: string },
) =>
  right.wordQuality - left.wordQuality ||
  right.quality - left.quality ||
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

export const matchesSessionMetadata = (
  session: SessionSearchSummary,
  query: string,
  mode: "exact" | "typos",
) => rankSessionMetadata(sessionSearchSubject(session), query, 0, mode === "typos") !== null;
