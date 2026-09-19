import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CLIENT_REQUEST_PARAMS } from "@nodex/effect-codex-app-server/rpc";
import { produce } from "immer";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexAgentConfigRuntime } from "./CodexAgentConfigRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexPermissions } from "./CodexPermissions";
import { CodexPreferences } from "./CodexPreferences";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { make } from "./CodexTurnPreparation";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import type { CodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { createCodexQueuedFollowUp } from "../../shared/codex-queued-follow-up-state";
import { encodeCodexAsyncQuestionReplies } from "../../shared/codex-async-user-input";
import {
  runCanonicalOwnerSteer,
  type CanonicalSteerNativeRequest,
} from "../../shared/codex-conversation-state/codex-owner-steer";

const threadId = "thread-steering";
const prepare = (canonical: CodexCanonicalConversationState | null) =>
  make.pipe(
    Effect.provideService(MainConfig, {} as MainConfig["Service"]),
    Effect.provideService(CoreAuthority, {} as CoreAuthority["Service"]),
    Effect.provideService(CodexAgentConfigRuntime, {} as CodexAgentConfigRuntime["Service"]),
    Effect.provideService(CodexAttachments, {} as CodexAttachments["Service"]),
    Effect.provideService(CodexConversationContext, {} as CodexConversationContext["Service"]),
    Effect.provideService(CodexConversationProjection, {
      read: () => Effect.succeed({ canonical }),
    } as unknown as CodexConversationProjection["Service"]),
    Effect.provideService(CodexPermissions, {} as CodexPermissions["Service"]),
    Effect.provideService(CodexPreferences, {} as CodexPreferences["Service"]),
    Effect.provideService(CodexThreadSettingsRuntime, {} as CodexThreadSettingsRuntime["Service"]),
    Effect.provideService(TemporaryAssets, {} as TemporaryAssets["Service"]),
    Effect.provideService(CodexInputAssets, {
      retainPrepared: (_threadId, _id, prepared) => Effect.succeed(prepared),
      retainCaptured: () => Effect.die("Unused captured input"),
    }),
    Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
    Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
  );

const command = (prompt = "continue", expectedTurnId?: string) => ({
  command: { threadId, prompt, ...(expectedTurnId ? { expectedTurnId } : {}) },
  recoveryRow: createCodexQueuedFollowUp({
    followUpId: "follow-up",
    clientUserMessageId: "client-message",
    threadId,
    prompt,
    createdAtMs: 1,
  }),
});

for (const residency of ["unbound-turn", "follower-without-history"] as const) {
  it.effect(`prepares steering before the owner supplies its Turn identity: ${residency}`, () =>
    Effect.gen(function* () {
      const canonical =
        residency === "follower-without-history"
          ? null
          : produce(
              conversationFixture(threadId, [turnFixture("pending", "inProgress")]),
              (draft) => {
                draft.turns[0]!.turnId = null;
              },
            );
      const preparation = yield* prepare(canonical);
      const result = yield* preparation.steer(command());
      assert.strictEqual(result.clientUserMessageId, "client-message");
      assert.strictEqual(result.conversationId, threadId);
      assert.deepEqual(result.input, [{ type: "text", text: "continue", text_elements: [] }]);
      assert.strictEqual(result.restoreMessage.queueRow?.clientUserMessageId, "client-message");
    }),
  );
}

for (const status of ["inProgress", "completed"] as const) {
  it.effect(`question preparation respects its originating ${status} Turn`, () =>
    Effect.gen(function* () {
      const turn = turnFixture("question-turn", status);
      turn.items.push({
        id: "question",
        type: "agentMessage",
        text: "Which scope?",
        phase: "final_answer",
        delivery: "async",
        memoryCitation: null,
        questions: null,
      });
      const preparation = yield* prepare(conversationFixture(threadId, [turn]));
      const prompt = encodeCodexAsyncQuestionReplies([
        { questionItemId: "question", question: "Which scope?", answer: "Project" },
      ]);
      const result = yield* preparation.steer(command(prompt, "question-turn")).pipe(Effect.result);
      assert.strictEqual(result._tag, status === "inProgress" ? "Success" : "Failure");
    }),
  );
}

it.effect.each(["message", "tool-output"] as const)(
  "executes prepared %s steering once after the owner receives its pending Turn ID",
  (kind) =>
    Effect.gen(function* () {
      let state = produce(
        conversationFixture(threadId, [turnFixture("pending", "inProgress")]),
        (draft) => {
          draft.turns[0]!.turnId = null;
        },
      );
      const preparation = yield* prepare(state);
      const prepared = yield* preparation.steer(command());
      yield* Effect.tryPromise(async () => {
        let notifySubscribed: () => void = () => {};
        const subscribed = new Promise<void>((resolve) => {
          notifySubscribed = resolve;
        });
        const listeners = new Set<() => void>();
        const requests: CanonicalSteerNativeRequest[] = [];
        const pending = runCanonicalOwnerSteer(
          {
            read: () => state,
            update: (recipe) => {
              state = produce(state, recipe);
            },
            subscribe: (listener) => {
              listeners.add(listener);
              notifySubscribed();
              return {
                [Symbol.dispose]: () => {
                  listeners.delete(listener);
                },
              };
            },
            onDispose: () => ({ [Symbol.dispose]() {} }),
            createId: () => "steering-item",
            sendNative: async (request) => {
              if (request.method === "turn/steer")
                Schema.encodeUnknownSync(CLIENT_REQUEST_PARAMS["turn/steer"])(request.params);
              else Schema.encodeUnknownSync(CLIENT_REQUEST_PARAMS["turn/start"])(request.params);
              requests.push(request);
              return { turnId: "native-turn" };
            },
            outcomeUnknown: () => null,
            mismatchTurnId: () => null,
            isLocalHost: true,
            emitSteered() {},
          },
          {
            ...prepared,
            ...(kind === "tool-output"
              ? {
                  toolOutput: {
                    namespace: "codex_app",
                    name: "send_message_to_thread",
                    output: "continue",
                  },
                }
              : {}),
          },
        );
        await subscribed;
        assert.deepEqual(requests, []);
        assert.strictEqual(
          state.turns[0]!.items[0]?.type,
          kind === "message" ? "steeringUserMessage" : undefined,
        );
        state = produce(state, (draft) => {
          draft.turns[0]!.turnId = "native-turn";
        });
        for (const listener of [...listeners]) listener();
        assert.deepEqual(await pending, { turnId: "native-turn" });
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.method, kind === "message" ? "turn/steer" : "turn/start");
        if (requests[0]?.method === "turn/steer") {
          assert.strictEqual(requests[0].params.expectedTurnId, "native-turn");
          assert.strictEqual(requests[0].params.clientUserMessageId, "client-message");
        }
        if (requests[0]?.method === "turn/start") {
          assert.deepEqual(requests[0].params.input, []);
          assert.strictEqual(requests[0].params.toolOutput?.output, "continue");
          assert.isUndefined(requests[0].params.clientUserMessageId);
        }
        assert.strictEqual(listeners.size, 0);
      });
    }),
);
