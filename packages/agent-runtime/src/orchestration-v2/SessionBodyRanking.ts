import {
  compareMessageSearchRank,
  scoreMessageSearch,
  type MessageSearchRank,
  type ThreadOpenStats,
} from "@nodex/runtime-shared/paletteSearch";

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
  fact: {
    readonly quality: number;
    readonly wordQuality?: number;
    readonly hits: number;
    readonly messageAt: string;
  },
  usage: ReturnType<typeof sessionBodyUsage>,
  _query: string,
  now: number,
): SessionBodyRank =>
  scoreMessageSearch(
    {
      quality: fact.quality,
      ...(fact.wordQuality === undefined ? {} : { wordQuality: fact.wordQuality }),
      hits: fact.hits,
      messageCreatedAt: fact.messageAt,
    },
    usage,
    now,
  );

export const compareSessionBodyRank = (
  left: SessionBodyRank & { readonly sessionId: string },
  right: SessionBodyRank & { readonly sessionId: string },
) => compareMessageSearchRank(left, right) || left.sessionId.localeCompare(right.sessionId);
