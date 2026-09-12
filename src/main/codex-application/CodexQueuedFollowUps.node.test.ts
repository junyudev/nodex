/* oxlint-disable effecttsgo/strict-effect-provide -- Scoped queue tests provide a single boundary fixture. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { make } from "./CodexQueuedFollowUps";
import type { CodexQueuedMessageState } from "../../shared/codex-queued-message";
import type { QueuedMessageRole } from "../../shared/codex-queued-message-coordinator";

const message = (id: string) => ({
  id,
  cwd: "/repo",
  context: {
    prompt: "captured",
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
    mcpAppModelContextAttachments: [{ widget: { arbitrary: [1, 2] } }],
  },
});
const fixture = (initial: CodexQueuedMessageState = {}) =>
  Effect.gen(function* () {
    let state = initial;
    let role: QueuedMessageRole = { role: "owner" };
    const broadcasts: unknown[] = [];
    const followerRequests: unknown[] = [];
    const events: unknown[] = [];
    const service = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: () => Effect.sync(() => ({ value: { kind: "queued_message_state", state } })),
          apply: (input: { intent: { kind: string; state: CodexQueuedMessageState } }) =>
            Effect.sync(() => {
              assert.strictEqual(input.intent.kind, "set_queued_message_state");
              state = structuredClone(input.intent.state);
              return {};
            }),
        },
      } as unknown as CoreModules["Service"]),
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
      Effect.provideService(CodexMainConversationManagers, {
        get: () =>
          Effect.succeed({
            assertCurrent: () => {},
            stream: { getRole: () => role },
            coordination: {
              threadQueuedFollowUpsChanged: async (value: unknown) => {
                broadcasts.push(value);
              },
              requestThreadFollower: async (value: unknown) => {
                followerRequests.push(value);
                return { resultType: "success", result: { ok: true } };
              },
            },
            subscribeQueuedMessages: () => ({ [Symbol.dispose]() {} }),
            onDispose: () => () => {},
          }),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexInputAssets, {
        retainPrepared: (_thread, _id, prepared) => Effect.succeed(prepared),
        retainCaptured: (_thread, _id, input) => Effect.succeed(input),
      }),
      Effect.provideService(CodexTurnPresentation, {} as CodexTurnPresentation["Service"]),
      Effect.provideService(CodexApplicationEventHub, {
        events: Stream.never,
        publish: (event) => {
          events.push(event);
        },
      }),
      Effect.provideService(ConversationEntityMap, {
        current: () => undefined,
      } as unknown as ConversationEntityMap["Service"]),
    );
    return {
      service,
      broadcasts,
      followerRequests,
      events,
      state: () => state,
      setRole: (next: QueuedMessageRole) => {
        role = next;
      },
    };
  });
it.effect("persists whole captured queue messages and broadcasts only after the owner write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({ unrelated: [message("other")] });
      yield* f.service.acceptFromFollower("thread", [message("one")]);
      assert.deepEqual(f.state(), { unrelated: [message("other")], thread: [message("one")] });
      assert.deepEqual(f.broadcasts, [
        { hostId: "local", conversationId: "thread", messages: [message("one")] },
      ]);
      assert.deepEqual(f.events, [{ kind: "queuedMessageStateChanged", value: null }]);
      yield* f.service.acceptFromFollower("thread", []);
      assert.deepEqual(f.state(), { unrelated: [message("other")] });
    }),
  ).pipe(Effect.provide(callbackLayer)),
);
it.effect("a follower refuses an owner-only queue replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({ thread: [message("one"), message("two")] });
      f.setRole({ role: "follower", ownerClientId: "window-owner" });
      const rejected = yield* f.service.acceptFromFollower("thread", []).pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
    }),
  ).pipe(Effect.provide(callbackLayer)),
);
it.effect("send locks exclude concurrent windows and suppress already sent messages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const request = { conversationId: "thread", messageId: "message", lockId: "window-a" };
      assert.isTrue(service.acquireSendLock(request));
      assert.isFalse(service.acquireSendLock({ ...request, lockId: "window-b" }));
      service.releaseSendLock({ ...request, sent: true });
      assert.isFalse(service.acquireSendLock({ ...request, lockId: "window-b" }));
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

for (const permissionMode of ["auto", "guardian-approvals", "full-access", "custom"] as const) {
  it.effect(
    `retains an explicit queued permission mode through persistence: ${permissionMode}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const input = { threadId: "thread", prompt: "captured choice", permissionMode };
          const captured = yield* f.service.prepareMessage(input);
          yield* f.service.acceptFromFollower("thread", [captured]);
          const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
          assert.strictEqual(restored.thread?.[0]?.submissionOptions?.agentMode, permissionMode);
          assert.strictEqual(
            restored.thread?.[0]?.submissionOptions?.shouldSendPermissionOverrides,
            true,
          );
        }),
      ).pipe(Effect.provide(callbackLayer)),
  );
}

it.effect("an implicit queued permission mode does not become an explicit override", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const captured = yield* f.service.prepareMessage({ threadId: "thread", prompt: "continue" });
      assert.strictEqual(captured.submissionOptions?.agentMode, undefined);
      assert.strictEqual(captured.submissionOptions?.shouldSendPermissionOverrides, false);
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "modern queued permission intent survives persistence without becoming legacy intent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const captured = yield* f.service.prepareMessage({
          threadId: "thread",
          prompt: "continue",
          permissionSelection: { kind: "profile", profileId: "team-profile" },
          permissionProfileId: "legacy-profile",
          usePermissionSelection: true,
          shouldSendPermissionOverrides: false,
        });
        yield* f.service.acceptFromFollower("thread", [captured]);
        const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
        assert.deepEqual(restored.thread?.[0]?.submissionOptions?.permissionSelection, {
          kind: "profile",
          profileId: "team-profile",
        });
        assert.strictEqual(
          restored.thread?.[0]?.submissionOptions?.permissionProfileId,
          "legacy-profile",
        );
        assert.strictEqual(restored.thread?.[0]?.submissionOptions?.usePermissionSelection, true);
        assert.strictEqual(
          restored.thread?.[0]?.submissionOptions?.shouldSendPermissionOverrides,
          false,
        );
        assert.strictEqual(restored.thread?.[0]?.submissionOptions?.agentMode, undefined);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);
