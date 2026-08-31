import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadRevertResponse } from "@nodex/codex-app-server-protocol/v2/ThreadRevertResponse";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CodexConversationSnapshot,
  CodexConversationTurnPagination,
  CodexThreadHistoryEditResult,
} from "../../shared/types";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexConversationProjection,
  type CodexConversationProjectionError,
} from "./CodexConversationProjection";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import {
  CodexHistoryPageAdapter,
  type CodexHistoryPageAdapterError,
} from "./CodexHistoryPageAdapter";
import { CodexThreadDirectory, type CodexThreadDirectoryError } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type GatewayThreadRevertParams = ClientRequestParamsByMethod["thread/revert"];

export class CodexThreadRollbackPolicyError extends Schema.TaggedError<CodexThreadRollbackPolicyError>()(
  "CodexThreadRollbackPolicyError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexThreadRollbackProtocolError extends Schema.TaggedError<CodexThreadRollbackProtocolError>()(
  "CodexThreadRollbackProtocolError",
  {
    threadId: Schema.String,
    responseThreadId: Schema.String,
  },
) {}

export class CodexThreadRollbackCommands extends Context.Service<
  CodexThreadRollbackCommands,
  {
    readonly revertLatestForEdit: (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly numTurns: number;
    }) => Effect.Effect<
      CodexThreadHistoryEditResult,
      | CodexRuntimeError
      | CodexConversationProjectionError
      | CodexHistoryPageAdapterError
      | CodexThreadDirectoryError
      | CodexThreadRollbackPolicyError
      | CodexThreadRollbackProtocolError
    >;
  }
>()("nodex/main/codex-application/CodexThreadRollbackCommands") {}

const latestEditableTurnId = (snapshot: CodexConversationSnapshot | null): string | null => {
  const latestTurn = snapshot?.turns.at(-1);
  if (!snapshot || !latestTurn || latestTurn.status === "inProgress") return null;
  const hasUserMessage = latestTurn.items.some(
    (entry) =>
      entry.turnId === latestTurn.turnId &&
      (entry.semanticKind === "userMessage" || entry.kind === "userMessage"),
  );
  return hasUserMessage ? latestTurn.turnId : null;
};

export const make: Effect.Effect<
  CodexThreadRollbackCommands["Service"],
  never,
  | CodexConversationProjection
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexHistoryPageAdapter
  | CodexOwnerNotificationDrainRuntime
  | CodexThreadDirectory
  | ConversationEntityMap
> = Effect.gen(function* () {
  const projection = yield* CodexConversationProjection;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const historyPages = yield* CodexHistoryPageAdapter;
  const ownerNotificationDrain = yield* CodexOwnerNotificationDrainRuntime;
  const directory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;

  const revertLatestForEdit = Effect.fn("CodexThreadRollbackCommands.revertLatestForEdit")(
    function* (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly numTurns: number;
    }) {
      return yield* conversations.runCommand(
        input.threadId,
        Effect.gen(function* () {
          yield* ownerNotificationDrain
            .awaitCurrent(input.threadId)
            .pipe(
              Effect.mapError(
                (cause) => new CodexThreadRollbackPolicyError({ threadId: input.threadId, cause }),
              ),
            );
          if (input.numTurns !== 1) {
            return yield* new CodexThreadRollbackPolicyError({
              threadId: input.threadId,
              cause: new Error("Owner thread/rollback currently supports numTurns: 1"),
            });
          }
          const current = yield* projection.read(input.threadId);
          if (latestEditableTurnId(current.snapshot) !== input.turnId) {
            return yield* new CodexThreadRollbackPolicyError({
              threadId: input.threadId,
              cause: new Error("Only the latest completed user turn can be edited"),
            });
          }
          const capability = yield* capabilities.forThread(input.threadId);
          if (
            !capability.flags.threadRevert ||
            current.canonical.protocol.historyMode !== "paginated"
          ) {
            return yield* new CodexThreadRollbackPolicyError({
              threadId: input.threadId,
              cause: new Error(
                "Editing history requires identity-based revert with bounded paginated history",
              ),
            });
          }
          const response = yield* gateway.requestForThread(
            input.threadId,
            "thread/revert",
            {
              threadId: input.threadId,
              beforeTurnId: input.turnId,
            } satisfies GatewayThreadRevertParams,
            codexGatewayGenerationFence(capability),
          );
          if (response.thread.id !== input.threadId) {
            return yield* Effect.fail(
              new CodexThreadRollbackProtocolError({
                threadId: input.threadId,
                responseThreadId: response.thread.id,
              }),
            );
          }
          if (!(yield* capabilities.isCurrent(capability))) {
            return yield* new CodexThreadRollbackPolicyError({
              threadId: input.threadId,
              cause: new Error("Codex app-server generation changed while reverting history"),
            });
          }

          const revertResponse = response as unknown as ThreadRevertResponse;
          const paginatedPage = yield* historyPages.loadTurnPage({
            capability,
            threadId: input.threadId,
            cursor: revertResponse.turnsBackwardsCursor,
            initialItemsCursor: revertResponse.itemsBackwardsCursor,
            purpose: "initial",
          });
          if (!(yield* capabilities.isCurrent(capability))) {
            return yield* new CodexThreadRollbackPolicyError({
              threadId: input.threadId,
              cause: new Error(
                "Codex app-server generation changed while hydrating reverted history",
              ),
            });
          }
          const responseThread = response.thread as unknown as Thread;
          const thread: Thread = { ...responseThread, turns: [...paginatedPage.turns] };
          const pagination: CodexConversationTurnPagination = {
            olderCursor: paginatedPage.nextCursor,
            backwardsCursor: paginatedPage.backwardsCursor,
            oldestLoadedTurnId: thread.turns[0]?.id ?? null,
            isLoadingOlder: false,
            hasLoadedOldest: paginatedPage.nextCursor === null,
            loadedTurnCount: thread.turns.length,
            itemsView: Object.values(paginatedPage.itemsPaginationByTurnId).every(
              (item) => item.itemsView === "full",
            )
              ? "full"
              : "summary",
          };
          yield* directory.acceptRollbackResult({
            expectedThreadId: input.threadId,
            thread: thread as unknown as Parameters<
              CodexThreadDirectory["Service"]["acceptRollbackResult"]
            >[0]["thread"],
            fallbackCwd: current.snapshot?.cwd ?? null,
            pagination,
            itemsPaginationByTurnId: paginatedPage.itemsPaginationByTurnId,
          });
          return {
            thread,
            turnPagination: pagination,
            turnItemsPaginationById: paginatedPage.itemsPaginationByTurnId,
          } satisfies CodexThreadHistoryEditResult;
        }),
      );
    },
  );

  return CodexThreadRollbackCommands.of({ revertLatestForEdit });
});
