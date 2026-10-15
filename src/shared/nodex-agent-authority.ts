import { createHash } from "node:crypto";

/** Host-issued identity for one exact Agent execution in the current Profile. */
export interface NodexAgentTurnContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly rootThreadId: string;
  readonly actorProjectId: string | null;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly admittedAtMs: number;
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
      ]),
    )
    .digest("hex");
