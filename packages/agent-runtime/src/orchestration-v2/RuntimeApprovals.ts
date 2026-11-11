import type {
  OrchestrationV2AppThread,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RunAttemptId,
  RunId,
  RuntimeChatGrant,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Work of the Runtime itself that needs a person's permission on a Run. */
export interface RuntimeApprovalRequest {
  readonly threadId: ThreadId;
  /** The card belongs to this attempt; it is cancelled if the attempt ends first. */
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly kind: ProviderRequestKind;
  /** What is being approved, shown as is: the command, code, or the asking server's message. */
  readonly prompt: string;
  /** Who asks, when it is not the Agent itself. */
  readonly appName?: string;
  /** The choices the asker can honour; omitted means approve once, decline, decline and stop. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  /** Persist this grant with an acceptForSession decision in the mode that showed the card. */
  readonly chatGrant?: RuntimeChatGrant;
  /** Aborting withdraws the card; the answer is then `cancel`. */
  readonly signal?: AbortSignal;
}

/**
 * Permission cards the Runtime raises for its own tools, with the same durable record, card and
 * answers as a provider's native requests, but answered here instead of through an adapter.
 */
export class RuntimeApprovals extends Context.Service<
  RuntimeApprovals,
  {
    /**
     * Shows the card on the Thread's current running attempt and waits. Ending or retiring
     * the attempt, stopping the Run, archiving or deleting the Thread, or aborting the signal
     * answers `cancel`. A card that cannot be shown also answers `cancel`.
     */
    readonly ask: (request: RuntimeApprovalRequest) => Effect.Effect<ProviderApprovalDecision>;
    /** Whether a person allowed this for the rest of the chat under its current permission mode. */
    readonly isAllowedForChat: (input: {
      readonly threadId: ThreadId;
      readonly grant: RuntimeChatGrant;
    }) => Effect.Effect<boolean>;
    /** Records such an allowance. Changing the Thread's permission mode ends it; forks start without it. */
    readonly allowForChat: (input: {
      readonly threadId: ThreadId;
      readonly grant: RuntimeChatGrant;
    }) => Effect.Effect<void>;
  }
>()("nodex/agent-runtime/orchestration-v2/RuntimeApprovals") {}

/** What a chat-long allowance covers. */
export type { RuntimeChatGrant } from "@nodex/runtime-contracts";

/** Updates only the allowances for the Thread's current permission mode. */
export function addRuntimeChatGrant(thread: OrchestrationV2AppThread, grant: RuntimeChatGrant) {
  const current = thread.runtimeChatGrants;
  const grants = current?.mode === thread.runtimeMode ? current.grants : [];
  if (grants.includes(grant)) return undefined;
  return { ...current, mode: thread.runtimeMode, grants: [...grants, grant] };
}
