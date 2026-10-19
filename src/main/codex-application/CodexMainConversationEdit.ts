import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ThreadRevertResponse } from "@nodex/codex-app-server-protocol/v2";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexTurnCommands } from "./CodexTurnCommands";
import {
  editCanonicalUserTurn,
  type CanonicalEditOptions,
} from "../../shared/codex-conversation-state/codex-owner-edit";

import { mutateCodexCanonicalRevert } from "../../shared/codex-conversation-state/codex-revert-state";

export class CodexMainConversationEdit extends Context.Service<
  CodexMainConversationEdit,
  {
    readonly edit: (
      hostId: string,
      conversationId: string,
      options: CanonicalEditOptions,
    ) => Effect.Effect<void, MainConversationManagerError>;
  }
>()("nodex/main/codex-application/CodexMainConversationEdit") {}

export const make = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const entities = yield* ConversationEntityMap;
  const settings = yield* CodexMainConversationSettings;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const callbacks = yield* ScopedCallbackRuntime;
  const turns = yield* CodexTurnCommands;
  return CodexMainConversationEdit.of({
    edit: (hostId, id, options) =>
      Effect.gen(function* () {
        const manager = yield* managers.get(hostId);
        const nativeGeneration = manager.generation;
        const capability = yield* capabilities.forHost(hostId);
        const assertOwner = () => {
          manager.assertCurrent(nativeGeneration);
          if (manager.stream.getRole(id)?.role !== "owner")
            throw new Error("no-client-found: thread stream owner became unavailable");
        };
        const nativeOptions = { expectedHostId: hostId, expectedGeneration: nativeGeneration };
        yield* Effect.tryPromise({
          try: () =>
            editCanonicalUserTurn(
              {
                getConversation: () => {
                  assertOwner();
                  return entities.current(id)?.readCanonicalState() ?? undefined;
                },
                awaitSettings: () => callbacks.runPromise(settings.awaitCurrent(hostId, id)),
                supportsRevert: () => capability.flags.threadRevert,
                revert: (_id, beforeTurnId) =>
                  callbacks
                    .runPromise(
                      gateway.requestOnHost(
                        hostId,
                        "thread/revert",
                        { threadId: id, beforeTurnId },
                        nativeOptions,
                      ),
                    )
                    .then((response) => {
                      assertOwner();
                      return response as ThreadRevertResponse;
                    }),
                applyRevert: (_id, response, removed) => {
                  assertOwner();
                  entities
                    .current(id)
                    ?.mutateCanonicalState(
                      (draft) =>
                        mutateCodexCanonicalRevert(
                          draft,
                          response,
                          new Set(removed.map((turn) => turn.turnId)),
                        ),
                      Date.now(),
                    );
                },
                start: (request, original) =>
                  callbacks.runPromise(
                    Effect.gen(function* () {
                      const prepared = yield* turns.prepareNativeStart(
                        id,
                        options.message,
                        undefined,
                        request,
                        {
                          attachments: original.params.attachments,
                          commentAttachments: original.params.commentAttachments,

                          writingBlockContextPrepared: options.writingBlockContextPrepared,
                          mcpAppModelContextAttachments: original.mcpAppModelContextAttachments,
                        },
                      );
                      return yield* Effect.gen(function* () {
                        const materialized = yield* turns.inspectPreparedNativeStart(prepared);
                        return yield* turns.executePreparedNativeStart(materialized.request);
                      }).pipe(
                        Effect.ensuring(
                          Effect.sync(() =>
                            turns.releasePreparedNativeStart(prepared.request.clientUserMessageId!),
                          ),
                        ),
                      );
                    }),
                  ),
              },
              id,
              options,
            ),
          catch: (cause) => new MainConversationManagerError({ hostId, cause }),
        });
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MainConversationManagerError
            ? cause
            : new MainConversationManagerError({ hostId, cause }),
        ),
      ),
  });
});
