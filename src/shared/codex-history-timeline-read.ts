import type { ThreadTimelineListParams } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CanonicalHistoryRequestOptions } from "./codex-conversation-state/codex-canonical-history-loader";

/** A timeline read belongs to the physical host context retained by its conversation owner. */
export interface CodexHistoryTimelineReadInput {
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly sourceEpoch: string;
  readonly params: ThreadTimelineListParams;
  readonly options?: CanonicalHistoryRequestOptions;
}

export interface CodexHistoryTimelineReadPage {
  readonly threadId: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly sourceEpoch: string;
  readonly response: ClientRequestResponsesByMethod["thread/timeline/list"];
}
