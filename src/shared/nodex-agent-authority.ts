import { createHash } from "node:crypto";

/**
 * An Agent Runtime execution's bound Session. Thread and Turn ids are then engine coordinates,
 * and the Turn is the Run, or the native connection when the caller names no Run.
 */
export interface NodexAgentRuntimeAuthority {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly turnKind: "run" | "native_connection";
}

/** Host-issued identity for one exact Agent execution in the current Profile. */
export interface NodexAgentTurnContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly rootThreadId: string;
  readonly actorProjectId: string | null;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly admittedAtMs: number;
  readonly runtime?: NodexAgentRuntimeAuthority;
}

export const nodexAgentAuthorityFingerprint = (context: NodexAgentTurnContext): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        context.threadId,
        context.turnId,
        context.rootThreadId,
        context.libraryId,
        context.storeEpoch,
        ...(context.runtime
          ? [[context.runtime.sessionId, context.runtime.runtimeId, context.runtime.turnKind]]
          : []),
      ]),
    )
    .digest("hex");
