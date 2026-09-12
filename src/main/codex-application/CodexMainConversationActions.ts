import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { parseCodexQueuedMessageState } from "../../shared/codex-queued-message";
import { CodexMainConversationEdit } from "./CodexMainConversationEdit";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { runCanonicalOwnerSteer } from "../../shared/codex-conversation-state/codex-owner-steer";
import { CodexTurnDeliveryError } from "../../shared/codex-conversation-state/codex-turn-delivery";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";
import { parseSteerTurnMismatchActualTurnId } from "../../shared/codex-steer-errors";
import { ServerNotification__ActivePermissionProfile } from "@nodex/effect-codex-app-server/schema";
import { CodexMainConversationInterrupt } from "./CodexMainConversationInterrupt";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { CodexMainConversationHistory } from "./CodexMainConversationHistory";
import type {
  TurnStartParams,
  ThreadSettingsUpdateParams,
  CommandExecutionApprovalDecision,
  PermissionsRequestApprovalResponse,
  McpServerElicitationRequestResponse,
} from "@nodex/codex-app-server-protocol/v2";
import {
  CLIENT_REQUEST_PARAMS,
  SERVER_REQUEST_RESPONSES,
} from "@nodex/effect-codex-app-server/rpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Installs authorized application actions on the ordinary Main peer after command construction. */
export const install = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const turns = yield* CodexTurnCommands;
  const queued = yield* CodexQueuedFollowUps;
  const entities = yield* ConversationEntityMap;
  const callbacks = yield* ScopedCallbackRuntime;
  const events = yield* CodexApplicationEventHub;
  const history = yield* CodexMainConversationHistory;
  const settings = yield* CodexMainConversationSettings;
  const interrupts = yield* CodexMainConversationInterrupt;
  const edits = yield* CodexMainConversationEdit;
  const compaction = yield* CodexManualCompactionRuntime;
  const responses = yield* CodexServerRequestResponses;
  const subscription = managers.registerFollowerHandler((hostId, request) =>
    Effect.gen(function* () {
      const params = record(request.params);
      if (!params || typeof params.conversationId !== "string")
        return yield* new MainConversationManagerError({
          hostId,
          cause: new Error("Invalid follower conversation"),
        });
      const threadId = params.conversationId;
      const requestId = params.requestId;
      const requireRequestId = (): Effect.Effect<RequestId, MainConversationManagerError> =>
        typeof requestId === "string" ||
        (typeof requestId === "number" && Number.isSafeInteger(requestId))
          ? Effect.succeed(requestId)
          : Effect.fail(
              new MainConversationManagerError({
                hostId,
                cause: new Error("Invalid follower request identity"),
              }),
            );
      switch (request.method) {
        case "thread-follower-edit-last-user-turn": {
          const options = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              turnId: Schema.String,
              message: Schema.String,
              agentMode: Schema.optionalKey(Schema.Unknown),
              shouldSendPermissionOverrides: Schema.optionalKey(Schema.Boolean),
              serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
              additionalContext: Schema.optionalKey(Schema.Unknown),
              writingBlockContextPrepared: Schema.optionalKey(Schema.Boolean),
            }),
          )(params);
          const validated = yield* Schema.decodeUnknownEffect(CLIENT_REQUEST_PARAMS["turn/start"])({
            threadId,
            input: [],
            additionalContext: options.additionalContext,
          });
          yield* edits.edit(hostId, threadId, {
            ...options,
            additionalContext:
              validated.additionalContext as import("@nodex/codex-app-server-protocol/v2").TurnStartParams["additionalContext"],
          });
          return { ok: true };
        }
        case "thread-follower-set-queued-follow-ups-state": {
          const state = yield* Effect.try(() => parseCodexQueuedMessageState(params.state));
          yield* queued.acceptFromFollower(threadId, state[threadId] ?? []);
          return { ok: true };
        }
        case "thread-follower-steer-turn": {
          const clientUserMessageId = yield* Schema.decodeUnknownEffect(Schema.String)(
            params.clientUserMessageId,
          );
          const prepared = yield* turns.inspectPreparedNativeSteer(clientUserMessageId);
          if (
            prepared.conversationId !== threadId ||
            !isDeepStrictEqual(params.input, prepared.input) ||
            !isDeepStrictEqual(params.restoreMessage, prepared.restoreMessage) ||
            !isDeepStrictEqual(params.attachments ?? [], prepared.attachments ?? []) ||
            !isDeepStrictEqual(params.additionalContext, prepared.additionalContext) ||
            !isDeepStrictEqual(params.serviceTier, prepared.serviceTier) ||
            !isDeepStrictEqual(params.toolOutput, prepared.toolOutput)
          )
            return yield* new MainConversationManagerError({
              hostId,
              cause: new Error("Steer request does not match its application admission"),
            });
          const manager = yield* managers.get(hostId);
          const nativeGeneration = manager.generation;
          const entity = entities.current(threadId);
          const owner = manager.stream.getRole(threadId);
          const assertOwner = () => {
            manager.assertCurrent(nativeGeneration);
            if (
              !entity ||
              entities.current(threadId) !== entity ||
              entity.readCanonicalState()?.hostId !== hostId ||
              owner?.role !== "owner" ||
              manager.stream.getRole(threadId) !== owner
            )
              throw new Error("Conversation owner changed during steering");
          };
          const result = yield* Effect.tryPromise({
            try: () =>
              runCanonicalOwnerSteer(
                {
                  read: () => {
                    assertOwner();
                    return entity?.readCanonicalState() ?? null;
                  },
                  update: (recipe) => {
                    assertOwner();
                    entity?.mutateCanonicalState(recipe, Date.now());
                  },
                  subscribe: (listener) =>
                    entities.subscribeCanonicalMutations((event) => {
                      if (event.threadId === threadId) listener();
                    }),
                  onDispose: (listener) => {
                    const reset = manager.onConnectionReset(listener);
                    const retired = entities.subscribeRetired((id, generation) => {
                      if (id === threadId && generation === entity?.generation) listener();
                    });
                    return {
                      [Symbol.dispose]() {
                        reset[Symbol.dispose]();
                        retired[Symbol.dispose]();
                      },
                    };
                  },
                  createId: randomUUID,
                  sendNative: (native, options) => {
                    assertOwner();
                    return callbacks
                      .runPromise(
                        turns
                          .executePreparedNativeSteer(native, clientUserMessageId, undefined, {
                            timeoutMs: options.timeoutMs,
                            onOutcomeUnknown: (delivery) =>
                              Effect.sync(() => {
                                assertOwner();
                                options.onOutcomeUnknown(delivery);
                              }),
                          })
                          .pipe(
                            Effect.mapError((error) => {
                              const failure = encodeCodexNativeRequestFailure(error);
                              return failure.delivery
                                ? new CodexTurnDeliveryError(failure.message, failure.delivery, {
                                    cause: error,
                                  })
                                : error;
                            }),
                          ),
                      )
                      .then((result) => {
                        assertOwner();
                        return result;
                      });
                  },
                  outcomeUnknown: (error) =>
                    error instanceof CodexTurnDeliveryError &&
                    error.delivery.stage === "outcome-unknown"
                      ? error.delivery
                      : null,
                  mismatchTurnId: parseSteerTurnMismatchActualTurnId,
                  isLocalHost: hostId === "local",
                  emitSteered: () => {
                    assertOwner();
                    events.publish({ kind: "conversationTurnSteered", value: threadId });
                  },
                },
                prepared,
              ),
            catch: (cause) => new MainConversationManagerError({ hostId, cause }),
          });
          return { result };
        }
        case "thread-follower-interrupt-turn": {
          const mode = yield* Schema.decodeUnknownEffect(
            Schema.Literals(["system", "user-stop", "descendant-cleanup"]),
          )(params.mode);
          const expectedTurnId =
            params.expectedTurnId === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(Schema.String)(params.expectedTurnId);
          return {
            ...(yield* interrupts.interrupt(hostId, threadId, mode, expectedTurnId)),
            ok: true,
          };
        }
        case "thread-follower-update-thread-settings": {
          const native = yield* Schema.decodeUnknownEffect(
            CLIENT_REQUEST_PARAMS["thread/settings/update"],
          )({ ...record(params.threadSettings), threadId });
          const condition =
            params.condition === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    ifEffortEquals: Schema.NullOr(Schema.String),
                    ifModelEquals: Schema.optionalKey(Schema.NullOr(Schema.String)),
                  }),
                )(params.condition);
          const activeTurnId =
            params.activeTurnId == null
              ? null
              : yield* Schema.decodeUnknownEffect(Schema.String)(params.activeTurnId);
          const rawProfile = record(params.threadSettings)?.activePermissionProfile;
          const profile =
            rawProfile === undefined
              ? {}
              : {
                  activePermissionProfile: yield* Schema.decodeUnknownEffect(
                    Schema.NullOr(ServerNotification__ActivePermissionProfile),
                  )(rawProfile),
                };
          return {
            applied: yield* settings.update(
              hostId,
              threadId,
              {
                ...(native as ThreadSettingsUpdateParams),
                ...profile,
              } as import("../../shared/codex-conversation-state/codex-thread-settings-update").CanonicalThreadSettingsPatch,
              activeTurnId === null ? condition : undefined,
              activeTurnId,
            ),
          };
        }
        case "thread-follower-load-complete-history":
          return { revision: yield* history.loadComplete(hostId, threadId) };
        case "thread-follower-start-turn": {
          const native = yield* Schema.decodeUnknownEffect(CLIENT_REQUEST_PARAMS["turn/start"])(
            record(params.turnStart)?.request,
          );
          if (native.threadId !== threadId)
            return yield* new MainConversationManagerError({
              hostId,
              cause: new Error("Native turn targets another conversation"),
            });
          const operation = {
            request: native as TurnStartParams,
            context: record(params.turnStart)
              ?.context as import("../../shared/codex-thread-follower-request").ConversationFollowerTurnStart["context"],
          };
          const prepared = yield* turns.inspectPreparedNativeStart(operation);
          return { result: yield* turns.executePreparedNativeStart(prepared.request) };
        }
        case "thread-follower-compact-thread": {
          yield* compaction.startAsOwner(hostId, threadId);
          return { ok: true };
        }
        case "thread-follower-command-approval-decision": {
          const id = yield* requireRequestId();
          const response = yield* Schema.decodeUnknownEffect(
            SERVER_REQUEST_RESPONSES["item/commandExecution/requestApproval"],
          )({ decision: params.decision });
          yield* responses.approval({
            threadId,
            requestId: id,
            response: {
              kind: "command",
              decision: response.decision as CommandExecutionApprovalDecision,
            },
          });
          return { ok: true };
        }
        case "thread-follower-file-approval-decision": {
          const id = yield* requireRequestId();
          const response = yield* Schema.decodeUnknownEffect(
            SERVER_REQUEST_RESPONSES["item/fileChange/requestApproval"],
          )({ decision: params.decision });
          yield* responses.approval({
            threadId,
            requestId: id,
            response: { kind: "file", decision: response.decision },
          });
          return { ok: true };
        }
        case "thread-follower-permissions-request-approval-response": {
          const id = yield* requireRequestId();
          const response = yield* Schema.decodeUnknownEffect(
            SERVER_REQUEST_RESPONSES["item/permissions/requestApproval"],
          )(params.response);
          yield* responses.permission({
            threadId,
            requestId: id,
            response: response as PermissionsRequestApprovalResponse,
          });
          return { ok: true };
        }
        case "thread-follower-submit-mcp-server-elicitation-response": {
          const id = yield* requireRequestId();
          const response = yield* Schema.decodeUnknownEffect(
            SERVER_REQUEST_RESPONSES["mcpServer/elicitation/request"],
          )(params.response);
          yield* responses.mcpElicitation({
            threadId,
            requestId: id,
            response: response as McpServerElicitationRequestResponse,
          });
          return { ok: true };
        }
        case "thread-follower-submit-user-input": {
          const id = yield* requireRequestId();
          const response = yield* Schema.decodeUnknownEffect(
            SERVER_REQUEST_RESPONSES["item/tool/requestUserInput"],
          )(params.response);
          const answers = Object.fromEntries(
            Object.entries(response.answers).flatMap(([key, value]) =>
              value ? [[key, value.answers]] : [],
            ),
          );
          yield* responses.userInput({ threadId, requestId: id, answers });
          return { ok: true };
        }
        default:
          return yield* new MainConversationManagerError({
            hostId,
            cause: new Error(`Unsupported follower method '${request.method}'`),
          });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof MainConversationManagerError
          ? cause
          : new MainConversationManagerError({ hostId, cause }),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => subscription[Symbol.dispose]()));
});
