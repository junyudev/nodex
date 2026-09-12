import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexConversations, live } from "./CodexConversations";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";

it.effect("projects private entity state into one immutable cross-subsystem capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(live.pipe(Layer.provideMerge(conversationEntityMapLive)));
      const conversations = Context.get(context, CodexConversations);
      const entities = Context.get(context, ConversationEntityMap);
      const entity = entities.entity("thread-a");
      entity.acceptCanonicalState({
        ...conversationFixture("thread-a", [
          turnFixture("turn-old"),
          turnFixture("turn-current", "inProgress"),
        ]),
        title: "Canonical title",
      });
      entity.installSnapshot({
        threadId: "thread-a",
        threadName: "Projected title",
        statusType: "idle",
        statusActiveFlags: [],
        turns: [],
        requests: [],
        pendingSteers: [],
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 0,
          projectionRevision: 0,
          entries: [],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
      } as unknown as CodexConversationSnapshot);

      assert.strictEqual(conversations.latestTurnId("thread-a"), "turn-current");
      assert.deepEqual(conversations.activity("thread-a"), {
        active: true,
        label: "Canonical title",
        pending: false,
      });
      assert.strictEqual(conversations.read("thread-a")?.generation, entity.generation);
      assert.deepEqual(conversations.read("thread-a")?.historyCheckpoint, [
        entity.generation,
        entity.readHistoryTopology().generation,
        entity.read().historyMutationRevision,
      ]);

      yield* conversations.retire("thread-a");
      assert.isNull(conversations.read("thread-a"));
    }),
  ),
);

it.effect(
  "reads activity and the latest accepted Turn from resident history without a presentation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          live.pipe(Layer.provideMerge(conversationEntityMapLive)),
        );
        const conversations = Context.get(context, CodexConversations);
        const entity = Context.get(context, ConversationEntityMap).entity("resident-thread");
        const canonical = produce(
          conversationFixture("resident-thread", [
            turnFixture("resident-old"),
            turnFixture("resident-active", "inProgress"),
          ]),
          (draft) => {
            replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
          },
        );
        assert.strictEqual(canonical.turns.length, 0);
        entity.acceptCanonicalState(canonical);
        assert.isNull(entity.readSnapshot());
        assert.strictEqual(conversations.latestTurnId("resident-thread"), "resident-active");
        assert.isTrue(conversations.activity("resident-thread").active);
        const liveState = conversationFixture("resident-thread", [
          turnFixture("new-live-turn", "inProgress"),
        ]);
        entity.acceptCanonicalState({ ...canonical, turns: liveState.turns });
        assert.strictEqual(conversations.latestTurnId("resident-thread"), "new-live-turn");
        assert.isTrue(conversations.activity("resident-thread").active);

        entity.acceptCanonicalState({
          ...canonical,
          turns: [
            {
              ...conversationFixture("overlay", [turnFixture("placeholder", "inProgress")])
                .turns[0]!,
              turnId: null,
            },
          ],
        });
        assert.strictEqual(conversations.latestTurnId("resident-thread"), "resident-active");
      }),
    ),
);

it.effect("does not let a stale presentation restore canonical activity or requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(live.pipe(Layer.provideMerge(conversationEntityMapLive)));
      const conversations = Context.get(context, CodexConversations);
      const entity = Context.get(context, ConversationEntityMap).entity("settled-thread");
      entity.acceptCanonicalState(conversationFixture("settled-thread", [turnFixture("settled")]));
      entity.installSnapshot({
        threadId: "settled-thread",
        threadName: "Stale name",
        statusType: "active",
        statusActiveFlags: ["waitingOnApproval"],
        turns: [],
        requests: [],
        pendingSteers: [],
      } as unknown as CodexConversationSnapshot);
      assert.deepEqual(conversations.activity("settled-thread"), {
        active: false,
        pending: false,
        label: "Initial title",
      });
    }),
  ),
);
