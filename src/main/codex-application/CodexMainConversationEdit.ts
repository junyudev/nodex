import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ThreadRevertResponse,
  ThreadRollbackResponse,
  ConfigReadResponse,
} from "@nodex/codex-app-server-protocol/v2";
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
  editCanonicalLastUserTurn,
  type CanonicalEditOptions,
} from "../../shared/codex-conversation-state/codex-owner-edit";
import {
  canonicalPermissionsForMode,
  nativePermissionRequestFields,
} from "../../shared/codex-conversation-state/codex-native-permissions";
import {
  mutateCodexCanonicalRevert,
  mutateCodexCanonicalRollbackThread,
} from "../../shared/codex-conversation-state/codex-rollback-state";

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
            editCanonicalLastUserTurn(
              {
                getConversation: () => {
                  assertOwner();
                  return entities.current(id)?.readCanonicalState() ?? undefined;
                },
                awaitSettings: () => callbacks.runPromise(settings.awaitCurrent(hostId, id)),
                supportsRevert: () => capability.flags.threadRevert,
                readPermissionOverrides: (_id, state, edit) =>
                  callbacks.runPromise(
                    Effect.gen(function* () {
                      const response = yield* gateway.requestOnHost(
                        hostId,
                        "config/read",
                        { includeLayers: false, cwd: state.cwd ?? null },
                        nativeOptions,
                      );
                      return (cwd: string | undefined) => {
                        const resolved = canonicalPermissionsForMode(
                          edit.agentMode,
                          cwd === undefined ? [] : [cwd],
                          response.config as ConfigReadResponse["config"],
                        );
                        if (!resolved) return null;
                        const profile =
                          state.latestThreadSettings?.activePermissionProfile === undefined
                            ? state.currentPermissions?.activePermissionProfile
                            : state.latestThreadSettings.activePermissionProfile;
                        return nativePermissionRequestFields(
                          profile === undefined
                            ? resolved
                            : { ...resolved, activePermissionProfile: profile },
                        );
                      };
                    }),
                  ),
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
                rollback: (_id, numTurns) =>
                  callbacks
                    .runPromise(
                      gateway.requestOnHost(
                        hostId,
                        "thread/rollback",
                        { threadId: id, numTurns },
                        nativeOptions,
                      ),
                    )
                    .then((response) => {
                      assertOwner();
                      return response as ThreadRollbackResponse;
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
                applyRollback: (_id, _before, response) => {
                  assertOwner();
                  entities.current(id)?.mutateCanonicalState((draft) => {
                    if (!mutateCodexCanonicalRollbackThread(draft, response.thread))
                      throw new Error("Rollback could not hydrate retained turns");
                  }, Date.now());
                },
                start: (request, original, inheritPermissionDefaults) =>
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
                          useAppServerPermissionDefault: inheritPermissionDefaults,
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
