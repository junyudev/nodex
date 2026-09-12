/* oxlint-disable effecttsgo/strict-effect-provide -- This scoped action test provides callback lifetime at its test entry point. */
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexMainConversationEdit } from "./CodexMainConversationEdit";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ConversationEntityMap, live as entitiesLayer } from "./internal/ConversationEntityMap";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CodexMainConversationInterrupt } from "./CodexMainConversationInterrupt";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { CodexMainConversationHistory } from "./CodexMainConversationHistory";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import type { TurnSteerResponse } from "@nodex/codex-app-server-protocol/v2";
import type {
  CanonicalOwnerSteerInput,
  CanonicalSteerNativeRequest,
} from "../../shared/codex-conversation-state/codex-owner-steer";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
} from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  CodexMainConversationManagers,
  type MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import type { ConversationFollowerRequest } from "../../shared/codex-client-coordination";
import { install } from "./CodexMainConversationActions";

it.effect("decodes source follower decisions through the authorized response owner", () =>
  Effect.gen(function* () {
    let handler:
      | ((
          hostId: string,
          request: ConversationFollowerRequest,
        ) => Effect.Effect<unknown, MainConversationManagerError>)
      | undefined;
    const decisions: unknown[] = [];
    yield* install.pipe(
      Effect.provideService(CodexQueuedFollowUps, {} as CodexQueuedFollowUps["Service"]),
      Effect.provideService(CodexMainConversationEdit, { edit: () => Effect.die("unused") }),
      Effect.provide(callbackLayer),
      Effect.provideService(CodexApplicationEventHub, {} as CodexApplicationEventHub["Service"]),
      Effect.provideService(ConversationEntityMap, {} as ConversationEntityMap["Service"]),
      Effect.provideService(CodexMainConversationInterrupt, {
        interrupt: () => Effect.die("unused"),
      }),
      Effect.provideService(CodexMainConversationSettings, {
        update: () => Effect.die("unused"),
        awaitCurrent: () => Effect.void,
      }),
      Effect.provideService(CodexMainConversationHistory, {
        loadComplete: () => Effect.die("unused"),
      }),
      Effect.provideService(CodexMainConversationManagers, {
        registerFollowerHandler: (value) => {
          handler = value;
          return {
            [Symbol.dispose]() {
              handler = undefined;
            },
          };
        },
      } as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexTurnCommands, {} as CodexTurnCommands["Service"]),
      Effect.provideService(
        CodexManualCompactionRuntime,
        {} as CodexManualCompactionRuntime["Service"],
      ),
      Effect.provideService(CodexServerRequestResponses, {
        approval: (input: Parameters<CodexServerRequestResponses["Service"]["approval"]>[0]) =>
          Effect.sync(() => {
            decisions.push(input);
            return true;
          }),
      } as unknown as CodexServerRequestResponses["Service"]),
    );
    if (!handler) throw new Error("Peer actions missing");
    const accepted = yield* handler("local", {
      method: "thread-follower-command-approval-decision",
      params: { conversationId: "thread", requestId: 0, decision: "acceptForSession" },
    });
    assert.deepEqual(accepted, { ok: true });
    assert.deepEqual(decisions, [
      {
        threadId: "thread",
        requestId: 0,
        response: { kind: "command", decision: "acceptForSession" },
      },
    ]);
    const rejected = yield* handler("local", {
      method: "thread-follower-command-approval-decision",
      params: { conversationId: "thread", requestId: 0, decision: "invented-decision" },
    }).pipe(Effect.result);
    assert.strictEqual(rejected._tag, "Failure");
    assert.strictEqual(decisions.length, 1);
  }),
);

for (const invalidation of ["reconnect", "entity-replacement", "owner-replacement"] as const) {
  for (const phase of ["pending-turn-id", "pending-native-response"] as const) {
    it.effect(`retires a Main owner steering action across ${invalidation} during ${phase}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const entities = Context.get(
            yield* Layer.buildWithScope(entitiesLayer, scope),
            ConversationEntityMap,
          );
          const callbacks = Context.get(
            yield* Layer.buildWithScope(callbackLayer, scope),
            ScopedCallbackRuntime,
          );
          let entity = entities.entity("thread");
          entity.installFollowerCanonicalState(
            conversationFixture("thread", [turnFixture("turn-old", "inProgress")]),
          );
          if (phase === "pending-turn-id")
            entity.mutateCanonicalState((draft) => {
              const entry = residentConversationTurnEntries(draft).at(-1)!;
              conversationTurnDraft(draft, entry.address)!.turnId = null;
            }, 0);
          const entered = yield* Deferred.make<void>();
          const reply = yield* Deferred.make<TurnSteerResponse>();
          const resets = new Set<() => void>();
          let generation = 1;
          let owner = { role: "owner" } as const;
          const requests: CanonicalSteerNativeRequest[] = [];
          const events: unknown[] = [];
          const prepared: CanonicalOwnerSteerInput = {
            conversationId: "thread",
            clientUserMessageId: "steer-message",
            input: [{ type: "text", text: "answer", text_elements: [] }],
            restoreMessage: {
              context: { commentAttachments: [] },
            },
          };
          let handler:
            | ((
                hostId: string,
                request: ConversationFollowerRequest,
              ) => Effect.Effect<unknown, MainConversationManagerError>)
            | undefined;
          yield* install.pipe(
            Effect.provideService(ScopedCallbackRuntime, callbacks),
            Effect.provideService(ConversationEntityMap, {
              ...entities,
              subscribeCanonicalMutations: (listener) => {
                const subscription = entities.subscribeCanonicalMutations(listener);
                if (phase === "pending-turn-id") Deferred.doneUnsafe(entered, Effect.void);
                return subscription;
              },
            }),
            Effect.provideService(CodexMainConversationManagers, {
              get: () =>
                Effect.succeed({
                  hostId: "local",
                  get generation() {
                    return generation;
                  },
                  assertCurrent: (expected?: number) => {
                    if (expected !== undefined && expected !== generation)
                      throw new Error("Native conversation connection retired");
                  },
                  stream: { getRole: () => owner },
                  onDispose: () => ({ [Symbol.dispose]() {} }),
                  onConnectionReset: (callback: () => void) => {
                    resets.add(callback);
                    return {
                      [Symbol.dispose]: () => {
                        resets.delete(callback);
                      },
                    };
                  },
                }),
              registerFollowerHandler: (
                value: Parameters<
                  CodexMainConversationManagers["Service"]["registerFollowerHandler"]
                >[0],
              ) => {
                handler = value;
                return {
                  [Symbol.dispose]: () => {
                    handler = undefined;
                  },
                };
              },
            } as unknown as CodexMainConversationManagers["Service"]),
            Effect.provideService(CodexTurnCommands, {
              inspectPreparedNativeSteer: () => Effect.succeed(prepared),
              executePreparedNativeSteer: (request: CanonicalSteerNativeRequest) =>
                Effect.gen(function* () {
                  requests.push(request);
                  yield* Deferred.succeed(entered, undefined);
                  return phase === "pending-native-response"
                    ? yield* Deferred.await(reply)
                    : { turnId: "turn-new" };
                }),
            } as unknown as CodexTurnCommands["Service"]),
            Effect.provideService(CodexApplicationEventHub, {
              publish: (event: unknown) => events.push(event),
            } as unknown as CodexApplicationEventHub["Service"]),
            Effect.provideService(CodexQueuedFollowUps, {} as CodexQueuedFollowUps["Service"]),
            Effect.provideService(CodexMainConversationEdit, { edit: () => Effect.die("unused") }),
            Effect.provideService(CodexMainConversationInterrupt, {
              interrupt: () => Effect.die("unused"),
            }),
            Effect.provideService(CodexMainConversationSettings, {
              update: () => Effect.die("unused"),
              awaitCurrent: () => Effect.void,
            }),
            Effect.provideService(CodexMainConversationHistory, {
              loadComplete: () => Effect.die("unused"),
            }),
            Effect.provideService(
              CodexManualCompactionRuntime,
              {} as CodexManualCompactionRuntime["Service"],
            ),
            Effect.provideService(
              CodexServerRequestResponses,
              {} as CodexServerRequestResponses["Service"],
            ),
          );
          assert.ok(handler);
          const action = yield* handler("local", {
            method: "thread-follower-steer-turn",
            params: prepared,
          }).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          if (invalidation === "reconnect") {
            generation += 1;
            for (const reset of [...resets]) reset();
          } else if (invalidation === "entity-replacement") {
            yield* entities.retire("thread");
            entity = entities.entity("thread");
          } else owner = { role: "owner" };
          entity.installFollowerCanonicalState(
            conversationFixture("thread", [turnFixture("turn-new", "inProgress")]),
          );
          const recovered = structuredClone(entity.readCanonicalState());
          yield* TestClock.adjust(30_000);
          assert.deepEqual(entity.readCanonicalState(), recovered);
          yield* Deferred.succeed(reply, { turnId: "turn-old" });
          const outcome = yield* Fiber.join(action);
          assert.strictEqual(outcome._tag, "Failure");
          assert.deepEqual(entity.readCanonicalState(), recovered);
          assert.deepEqual(events, []);
          assert.strictEqual(requests.length, phase === "pending-turn-id" ? 0 : 1);
          assert.strictEqual(resets.size, 0);
        }),
      ),
    );
  }
}
