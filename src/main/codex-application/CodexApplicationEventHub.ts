import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexThreadNotificationEvent } from "../../shared/codex-thread-notification";
import type { IpcEvents } from "../../shared/ipc-api";
import type { CodexHostMessage } from "../../shared/types";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export type CodexApplicationEvent =
  | { readonly kind: "codex"; readonly value: IpcEvents["codex:event"] }
  | { readonly kind: "threadNotification"; readonly value: CodexThreadNotificationEvent }
  | { readonly kind: "hostMessage"; readonly value: CodexHostMessage }
  | {
      readonly kind: "rendererOwnerHostMessage";
      readonly value: { readonly targetClientId: string; readonly message: unknown };
    }
  | {
      readonly kind: "rendererThreadStreamRelay";
      readonly value: {
        readonly targetClientIds: readonly string[];
        readonly sourceClientId: string | null;
        readonly message: CodexHostMessage;
      };
    }
  | {
      readonly kind: "rendererThreadStreamControlRelay";
      readonly value: {
        readonly targetClientIds: readonly string[];
        readonly message: Extract<
          CodexHostMessage,
          {
            type:
              | "threadStreamFollowersChanged"
              | "threadStreamTransportReset"
              | "threadStreamSnapshotRequested";
          }
        >;
      };
    }
  | { readonly kind: "rendererConversationPresentedInForeground"; readonly value: string }
  | {
      readonly kind: "conversationReadStateCommitted";
      readonly value: { readonly threadId: string; readonly hasUnreadTurn: boolean };
    }
  | {
      readonly kind: "conversationRelationshipsInvalidated";
      readonly value: {
        readonly parentThreadIds: readonly string[];
        readonly removedThreadIds?: readonly string[];
        readonly restoredThreadIds?: readonly string[];
      };
    }
  | {
      readonly kind: "pendingWorktreesChanged";
      readonly value: IpcEvents["codex:pending-worktrees:changed"];
    }
  | {
      readonly kind: "pendingWorktreeWarning";
      readonly value: IpcEvents["codex:pending-worktree:warning"];
    }
  | { readonly kind: "agentImportProgress"; readonly value: IpcEvents["agent-import:progress"] };

/** Synchronous ingress for causally ordered protocol projections into the Main-scoped event bus. */
export interface CodexApplicationEventPublisher {
  readonly publish: (event: CodexApplicationEvent) => void;
}

export interface CodexApplicationEventHubService extends CodexApplicationEventPublisher {
  readonly events: Stream.Stream<CodexApplicationEvent>;
}

export class CodexApplicationEventHub extends Context.Service<
  CodexApplicationEventHub,
  CodexApplicationEventHubService
>()("nodex/main/codex-application/CodexApplicationEventHub") {}

/** Owns the typed application projection bus for exactly one Main Scope. */
export const make: Effect.Effect<CodexApplicationEventHub["Service"], never, Scope.Scope> =
  Effect.gen(function* () {
    let accepting = true;
    const events = yield* PubSub.sliding<CodexApplicationEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
      }).pipe(Effect.andThen(PubSub.shutdown(events)), Effect.asVoid),
    );

    return CodexApplicationEventHub.of({
      events: Stream.fromPubSub(events),
      publish: (event) => {
        if (!accepting) return;
        // Protocol ingress is synchronous. Publishing inline preserves causal order while
        // subscription fibers remain owned and interrupted by the Main Scope.
        PubSub.publishUnsafe(events, event);
      },
    });
  });
