import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type {
  CodexTurnPresentationCaptureInput,
  CodexTurnPresentationTarget,
  CodexTurnPresentationTicket,
} from "../shared/nodex-app-tools/turn-presentation";
import type { PresentationAnchor } from "../shared/nodex-app-tools/workbench";

export class CodexTurnPresentationError extends Schema.TaggedError<CodexTurnPresentationError>()(
  "CodexTurnPresentationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "stale_renderer",
      "capacity",
      "expired",
      "target_mismatch",
      "submission_mismatch",
      "in_flight",
      "already_accepted",
      "turn_mismatch",
      "closed",
    ]),
    message: Schema.String,
    acceptedTurnId: Schema.NullOr(Schema.String),
  },
) {}

/** Main-only claim. The origin snapshot remains inside its scoped owner. */
export interface CodexTurnPresentationClaim {
  readonly ticketId: string;
  readonly submissionId: string;
}

export interface CodexTurnPresentationLaunch extends CodexTurnPresentationClaim {
  readonly launchId: string;
  readonly threadId: string;
  readonly sequence: number;
}

export interface RuntimePresentationSource {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly providerSessionId: string;
  readonly nativeGeneration: number;
}

export class CodexTurnPresentation extends Context.Service<
  CodexTurnPresentation,
  {
    readonly capture: (
      webContentsId: number,
      input: CodexTurnPresentationCaptureInput,
    ) => Effect.Effect<CodexTurnPresentationTicket, CodexTurnPresentationError>;
    readonly claim: (
      ticket: CodexTurnPresentationTicket,
      target: CodexTurnPresentationTarget,
      submissionId: string,
    ) => Effect.Effect<CodexTurnPresentationClaim | undefined, CodexTurnPresentationError>;
    /** Stable Session messages can retry an uncertain engine receipt without recapturing origin. */
    readonly admitRuntimeMessage: (
      ticket: CodexTurnPresentationTicket | undefined,
      target: CodexTurnPresentationTarget,
      threadId: string,
      messageId: string,
    ) => Effect.Effect<CodexTurnPresentationLaunch | null, CodexTurnPresentationError>;
    readonly replaceQueuedRuntimeMessage: (
      ticket: CodexTurnPresentationTicket | undefined,
      threadId: string,
      messageId: string,
      editRequestId: string,
    ) => Effect.Effect<CodexTurnPresentationLaunch | null, CodexTurnPresentationError>;
    readonly begin: (
      claim: CodexTurnPresentationClaim | undefined,
      threadId: string,
      submissionId?: string,
    ) => Effect.Effect<CodexTurnPresentationLaunch | null, CodexTurnPresentationError>;
    readonly bind: (
      launch: CodexTurnPresentationLaunch | null,
      turnId: string,
    ) => Effect.Effect<void, CodexTurnPresentationError>;
    /** Protocol client message identity is required; unknown notifications never choose a launch. */
    readonly observeUserMessage: (
      threadId: string,
      turnId: string,
      clientUserMessageId: string | null,
    ) => Effect.Effect<void, CodexTurnPresentationError>;
    readonly observeRuntimeMessage: (
      threadId: string,
      runId: string,
      messageId: string | null,
      source: RuntimePresentationSource,
    ) => Effect.Effect<void, CodexTurnPresentationError>;
    readonly finishRuntimeSource: (source: RuntimePresentationSource) => void;
    readonly finishRuntimeLease: (runtimeId: string, runtimeGeneration: string) => void;
    readonly abort: (launch: CodexTurnPresentationLaunch | null) => void;
    readonly releaseClaim: (claim: CodexTurnPresentationClaim | undefined) => void;
    /** Resumes a deferred launch only through its original target and logical submission identity. */
    readonly lookupSubmission: (
      target: CodexTurnPresentationTarget,
      submissionId: string,
    ) => CodexTurnPresentationClaim | undefined;
    /** Retained origins are indexed only by exact durable message identity. */
    readonly retainQueued: (claim: CodexTurnPresentationClaim | undefined) => void;
    readonly readQueued: (
      threadId: string,
      clientUserMessageId: string,
    ) => CodexTurnPresentationClaim | undefined;
    readonly reconcileQueued: (
      threadId: string,
      retainedClientMessageIds: readonly string[],
    ) => void;
    readonly read: (threadId: string, turnId: string) => PresentationAnchor | null;
    readonly finish: (threadId: string, turnId: string) => void;
  }
>()("nodex/main/codex-application/CodexTurnPresentation") {}
