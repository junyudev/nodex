import type {
  CodexConversationSnapshot,
  CodexThreadOwnerStreamStatePublishInput,
  CodexThreadOwnerStreamStatePublishResult,
  CodexThreadStreamCheckpoint,
} from "./types";
import { applyCodexConversationStateUpdates } from "./codex-conversation-patches";

export function buildCodexThreadStreamCheckpoint(input: {
  ownerEpoch: number;
  revision: number;
}): CodexThreadStreamCheckpoint {
  if (!Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0) {
    throw new Error("Owner epoch must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error("Stream revision must be a non-negative safe integer");
  }
  return {
    protocolVersion: 1,
    ownerEpoch: input.ownerEpoch,
    revision: input.revision,
  };
}

export function areCodexThreadStreamCheckpointsEqual(
  left: CodexThreadStreamCheckpoint | null | undefined,
  right: CodexThreadStreamCheckpoint | null | undefined,
): boolean {
  if (!left || !right) return left == null && right == null;
  return (
    left.protocolVersion === right.protocolVersion &&
    left.ownerEpoch === right.ownerEpoch &&
    left.revision === right.revision
  );
}

export function isCodexThreadStreamCheckpoint(
  value: unknown,
): value is CodexThreadStreamCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CodexThreadStreamCheckpoint>;
  return (
    candidate.protocolVersion === 1 &&
    Number.isSafeInteger(candidate.ownerEpoch) &&
    (candidate.ownerEpoch ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? -1) >= 0
  );
}

export interface CodexThreadStreamReplica {
  checkpoint: CodexThreadStreamCheckpoint;
  conversation: CodexConversationSnapshot;
}

export type CodexThreadStreamReplicaApplyResult =
  | {
      accepted: true;
      replica: CodexThreadStreamReplica;
    }
  | Exclude<CodexThreadOwnerStreamStatePublishResult, { accepted: true }>;

function rejectedReplicaPublication(
  reason: Exclude<CodexThreadOwnerStreamStatePublishResult, { accepted: true }>["reason"],
  current: CodexThreadStreamReplica | null,
): CodexThreadStreamReplicaApplyResult {
  return {
    accepted: false,
    reason,
    recovery: current
      ? {
          checkpoint: current.checkpoint,
          conversationState: current.conversation,
        }
      : null,
  };
}

/**
 * Applies an owner publication as one compare-and-swap transaction.
 *
 * The caller owns authorization and epoch assignment. This function owns the
 * owner revision contract and never mutates the accepted replica on a
 * rejected publication.
 */
export function applyCodexThreadOwnerPublication(input: {
  current: CodexThreadStreamReplica | null;
  expectedOwnerEpoch: number;
  publication: CodexThreadOwnerStreamStatePublishInput;
}): CodexThreadStreamReplicaApplyResult {
  const { current, expectedOwnerEpoch, publication } = input;
  if (
    publication.checkpoint.ownerEpoch !== expectedOwnerEpoch ||
    (publication.baseCheckpoint !== null &&
      publication.baseCheckpoint.ownerEpoch !== expectedOwnerEpoch)
  ) {
    return rejectedReplicaPublication("owner-epoch-mismatch", current);
  }
  if (publication.checkpoint.protocolVersion !== 1) {
    return rejectedReplicaPublication("checkpoint-mismatch", current);
  }

  if (publication.recoveryOnly) {
    if (!current || !publication.baseCheckpoint)
      return rejectedReplicaPublication("missing-base", current);
    if (
      publication.change.type !== "snapshot" ||
      publication.change.revision !== current.checkpoint.revision ||
      !areCodexThreadStreamCheckpointsEqual(publication.checkpoint, current.checkpoint) ||
      !areCodexThreadStreamCheckpointsEqual(publication.baseCheckpoint, current.checkpoint)
    ) {
      return rejectedReplicaPublication("base-checkpoint-mismatch", current);
    }
    return {
      accepted: true,
      replica: {
        checkpoint: current.checkpoint,
        conversation: publication.change.conversationState,
      },
    };
  }

  if (!current) {
    if (publication.baseCheckpoint !== null) {
      return rejectedReplicaPublication("missing-base", current);
    }
    if (publication.change.type !== "snapshot") {
      return rejectedReplicaPublication("missing-base", current);
    }
    if (publication.change.revision !== publication.checkpoint.revision) {
      return rejectedReplicaPublication("revision-gap", current);
    }
  } else {
    if (!publication.baseCheckpoint) {
      return rejectedReplicaPublication("missing-base", current);
    }
    if (!areCodexThreadStreamCheckpointsEqual(publication.baseCheckpoint, current.checkpoint)) {
      return rejectedReplicaPublication("base-checkpoint-mismatch", current);
    }
    if (publication.checkpoint.revision !== current.checkpoint.revision + 1) {
      return rejectedReplicaPublication("revision-gap", current);
    }
    if (publication.change.type === "patches") {
      if (
        publication.change.baseRevision !== current.checkpoint.revision ||
        publication.change.revision !== publication.checkpoint.revision
      ) {
        return rejectedReplicaPublication("revision-gap", current);
      }
    } else if (publication.change.revision !== publication.checkpoint.revision) {
      return rejectedReplicaPublication("revision-gap", current);
    }
  }

  let nextConversation: CodexConversationSnapshot;
  if (publication.change.type === "snapshot") {
    nextConversation = publication.change.conversationState;
  } else {
    if (!current) return rejectedReplicaPublication("missing-base", current);
    try {
      nextConversation = applyCodexConversationStateUpdates(
        current.conversation,
        publication.change.patches,
      );
    } catch {
      return rejectedReplicaPublication("patch-apply-failed", current);
    }
  }

  return {
    accepted: true,
    replica: {
      checkpoint: publication.checkpoint,
      conversation: nextConversation,
    },
  };
}
