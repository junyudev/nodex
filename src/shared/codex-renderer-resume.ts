import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { CodexThreadSummary } from "./types";

/** A durable preparation authorizes one native resume without owning its live document. */
export interface CodexRendererResumePreparation {
  readonly receiptId: string;
  readonly nativeRequestId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly supportsPaginatedHistory: boolean;
  readonly params: ThreadResumeParams;
  /** Kept for result reconciliation even when the native request preserves all server settings. */
  readonly requestedCwd: string | null;
  readonly summary: CodexThreadSummary;
}

export interface CodexRendererHostContext {
  readonly accountContext: import("./codex-thread-read-state").ThreadReadStateContext;
  readonly hostId: string;
  readonly generation: number;
  readonly sourceEpoch: string;
  readonly supportsPaginatedHistory: boolean;
  readonly supportsTurnApprovalsReviewer: boolean;
  readonly supportsThreadRevert: boolean;
  readonly supportsThreadQueue: boolean;
}
