import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { imageInput } from "./CodexTurnPreparation";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { parseAssetSource } from "../../shared/assets";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import {
  editCanonicalUserTurn,
  type CanonicalEditOptions,
} from "../../shared/codex-conversation-state/codex-owner-edit";

import { createUuidV7 } from "../../shared/uuid-v7";
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
  const assets = yield* TemporaryAssets;
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
                // A managed asset is a path in this computer's Profile; another host gets bytes.
                resolveImageInput: (source) => {
                  if (hostId !== CODEX_APP_LOCAL_HOST_ID && parseAssetSource(source))
                    throw new Error("A managed image reaches another host only as its bytes");
                  return imageInput(source, assets.resolveAssetPath);
                },
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
                prepareStart: (request, original, preparedPrompt) =>
                  callbacks.runPromise(
                    Effect.suspend(() => {
                      const clientUserMessageId = createUuidV7();
                      const release = () => turns.releasePreparedNativeStart(clientUserMessageId);
                      return Effect.gen(function* () {
                        const prepared = yield* turns.prepareNativeStart(
                          id,
                          options.message,
                          { preparedPrompt, clientUserMessageId },
                          { ...request, clientUserMessageId },
                          {
                            attachments: original.params.attachments,
                            commentAttachments: original.params.commentAttachments,
                            writingBlockContextPrepared: options.writingBlockContextPrepared,
                            mcpAppModelContextAttachments: original.mcpAppModelContextAttachments,
                          },
                        );
                        const materialized = yield* turns.inspectPreparedNativeStart(prepared);
                        return {
                          start: () =>
                            callbacks.runPromise(
                              turns.executePreparedNativeStart(materialized.request),
                            ),
                          release,
                        };
                      }).pipe(
                        Effect.onExit((exit) =>
                          Exit.isFailure(exit) ? Effect.sync(release) : Effect.void,
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
