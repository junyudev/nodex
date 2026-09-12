import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { CLIENT_REQUEST_PARAMS } from "@nodex/effect-codex-app-server/rpc";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  mutateCanonicalThreadSettingsPatch,
  type CanonicalThreadSettingsPatch,
  type CanonicalThreadSettingsCondition,
} from "../../shared/codex-conversation-state/codex-thread-settings-update";

export class CodexMainConversationSettings extends Context.Service<
  CodexMainConversationSettings,
  {
    readonly awaitCurrent: (
      hostId: string,
      conversationId: string,
    ) => Effect.Effect<void, MainConversationManagerError>;
    readonly update: (
      hostId: string,
      conversationId: string,
      patch: CanonicalThreadSettingsPatch,
      condition?: CanonicalThreadSettingsCondition,
      activeTurnId?: string | null,
    ) => Effect.Effect<boolean, MainConversationManagerError>;
  }
>()("nodex/main/codex-application/CodexMainConversationSettings") {}

const unsupported = (error: unknown): boolean => {
  if (!Schema.is(CodexRuntimeError)(error) || !Schema.is(CodexAppServerRequestError)(error.cause))
    return false;
  const message = error.cause.message.toLowerCase();
  return (
    error.cause.code === -32601 ||
    message.includes("method not found") ||
    ((message.includes("unknown method") || message.includes("unknown variant")) &&
      message.includes("thread/settings/update"))
  );
};

/** Settings serialize within their physical owner lifetime; native notifications win races. */
export const make = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const entities = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const lanes = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });
  const support = new WeakMap<
    MainConversationManager,
    { generation: number; status: "supported" | "unsupported" }
  >();
  return CodexMainConversationSettings.of({
    awaitCurrent: (hostId, id) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* managers.get(hostId);
          const nativeGeneration = manager.generation;
          const lane = yield* RcMap.get(lanes, JSON.stringify([hostId, nativeGeneration, id]));
          yield* lane.withPermit(
            Effect.try({
              try: () => manager.assertCurrent(nativeGeneration),
              catch: (cause) => new MainConversationManagerError({ hostId, cause }),
            }),
          );
        }),
      ).pipe(Effect.mapError((cause) => new MainConversationManagerError({ hostId, cause }))),
    update: (hostId, id, patch, condition, activeTurnId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* managers.get(hostId);
          const nativeGeneration = manager.generation;
          const lane = yield* RcMap.get(lanes, JSON.stringify([hostId, nativeGeneration, id]));
          return yield* lane.withPermit(
            Effect.gen(function* () {
              const assertOwner = () => {
                manager.assertCurrent(nativeGeneration);
                if (manager.stream.getRole(id)?.role !== "owner")
                  throw new Error("no-client-found: thread stream owner became unavailable");
                const entity = entities.current(id);
                if (!entity) throw new Error("Conversation unavailable");
                const state = entity.readCanonicalState();
                if (!state) throw new Error("Conversation document unavailable");
                return { entity, state };
              };
              const readOwner = Effect.try({
                try: assertOwner,
                catch: (cause) => new MainConversationManagerError({ hostId, cause }),
              });
              const { state: before } = yield* readOwner;
              if (
                condition &&
                (before.latestReasoningEffort !== condition.ifEffortEquals ||
                  (condition.ifModelEquals != null &&
                    before.latestModel !== condition.ifModelEquals))
              )
                return false;
              const options = { expectedHostId: hostId, expectedGeneration: nativeGeneration };
              const supportStatus = () => {
                const value = support.get(manager);
                return value?.generation === nativeGeneration ? value.status : undefined;
              };
              if (supportStatus() !== "unsupported") {
                const params = yield* Schema.decodeUnknownEffect(
                  CLIENT_REQUEST_PARAMS["thread/settings/update"],
                )({ threadId: id, ...patch });
                const result = yield* gateway
                  .requestOnHost(hostId, "thread/settings/update", params, options)
                  .pipe(Effect.result);
                yield* readOwner;
                if (result._tag === "Failure" && !unsupported(result.failure))
                  return yield* Effect.fail(result.failure);
                support.set(manager, {
                  generation: nativeGeneration,
                  status: result._tag === "Success" ? "supported" : "unsupported",
                });
              }
              const current = yield* readOwner;
              if (
                supportStatus() === "unsupported" ||
                current.state.latestThreadSettings === before.latestThreadSettings
              ) {
                current.entity.mutateCanonicalState(
                  (draft) => mutateCanonicalThreadSettingsPatch(draft, patch),
                  Date.now(),
                );
              }
              if (activeTurnId == null || patch.approvalsReviewer == null) return true;
              const capability = yield* capabilities.forHost(hostId);
              yield* readOwner;
              if (!capability.flags.turnApprovalsReviewer) return true;
              const params = yield* Schema.decodeUnknownEffect(
                CLIENT_REQUEST_PARAMS["turn/settings/update"],
              )({ threadId: id, turnId: activeTurnId, approvalsReviewer: patch.approvalsReviewer });
              yield* gateway.requestOnHost(hostId, "turn/settings/update", params, options);
              yield* readOwner;
              return true;
            }),
          );
        }),
      ).pipe(Effect.mapError((cause) => new MainConversationManagerError({ hostId, cause }))),
  });
});
