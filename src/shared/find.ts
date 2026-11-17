import type { ChatHistoryMatch, ChatSearchMatch } from "./chat-search";
import type { PageSearchResult, PageSearchTextPart } from "./types";

export type FindKind = "page" | "block" | "chat";
export type FindPlace =
  | { readonly kind: "everywhere" }
  | {
      readonly kind: "project";
      readonly projectId: string;
    };

export interface FindRequest {
  readonly query: string;
  readonly kinds: readonly FindKind[];
  readonly place: FindPlace;
  readonly limit: number;
  readonly cursor?: string;
  readonly preferredProjectId?: string;
  readonly recentPageIds?: readonly string[];
  readonly startedChatsOnly?: boolean;
  readonly excludePageIds?: readonly string[];
  readonly dataSourceIds?: readonly string[];
}

export type FindPhase = "instant" | "complete";
export interface FindRank {
  readonly text: number | null;
  readonly strong: boolean;
  readonly ordered: boolean;
}
export type FindAnchor =
  | { readonly kind: "block"; readonly pageId: string; readonly blockId: string }
  | ({ readonly kind: "chat_item" } & ChatHistoryMatch);

export interface FindEvidence {
  readonly field: string;
  readonly parts: readonly PageSearchTextPart[];
  readonly anchor?: FindAnchor;
}

interface FindHitFields {
  readonly identity: string;
  readonly title: string;
  readonly location: { readonly projectId: string | null; readonly label: string | null };
  readonly evidence: readonly FindEvidence[];
  readonly rank: FindRank;
  readonly archived: boolean;
}

export type FindHit = FindHitFields &
  (
    | { readonly kind: "page"; readonly page: PageSearchResult }
    | { readonly kind: "block"; readonly pageId: string }
    | { readonly kind: "chat"; readonly chatMatch: ChatSearchMatch }
  );

export interface FindCoverage {
  readonly source: "pages" | "blocks" | "chat_catalog" | "runtime" | "codex";
  readonly truncated?: boolean;
  readonly state: "complete" | "pending" | "indexing" | "partial" | "unavailable" | "timed_out";
}

export interface FindResponse {
  readonly phase: FindPhase;
  readonly hits: readonly FindHit[];
  readonly topResult?: FindHit;
  readonly coverage: readonly FindCoverage[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}
