import {
  compareMessageSearchRank,
  foldSearchQuery,
  scoreMessageSearch,
  type MessageSearchRank,
  type ThreadOpenStats,
} from "@t3tools/shared/paletteSearch";

export interface SessionBodyUsageSubject {
  readonly latestUserAuthoredMessageAt: string | null;
  readonly activityEvidence?: { readonly at: string; readonly provenance: "user_role" };
  readonly opens?: ThreadOpenStats | null;
}
/** Authored evidence wins; a producer's user-role timestamp remains explicitly weaker evidence. */
export const sessionBodyUsage = (session: SessionBodyUsageSubject) => {
  const value = session.latestUserAuthoredMessageAt ?? session.activityEvidence?.at ?? null;
  const at = value === null ? null : Date.parse(value);
  return {
    activityAt: at !== null && Number.isFinite(at) ? at : null,
    opens: session.opens ?? null,
  };
};

export type SessionBodyRank = MessageSearchRank;
export const rankSessionBody = (
  fact: { readonly quality: number; readonly hits: number; readonly messageAt: string },
  usage: ReturnType<typeof sessionBodyUsage>,
  query: string,
  now: number,
): SessionBodyRank =>
  scoreMessageSearch(
    { quality: fact.quality, hits: fact.hits, messageCreatedAt: fact.messageAt },
    {
      title: "",
      activityAt: usage.activityAt,
      opens: usage.opens ?? null,
    },
    foldSearchQuery(query),
    now,
    { picks: false },
  );

export const compareSessionBodyRank = (
  left: SessionBodyRank & { readonly sessionId: string },
  right: SessionBodyRank & { readonly sessionId: string },
) => compareMessageSearchRank(left, right) || left.sessionId.localeCompare(right.sessionId);
